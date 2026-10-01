import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gitModeForWorktreeFile } from './file-mode.mjs';

const exec = promisify(execFile);
const decodePath = new TextDecoder('utf-8', { fatal: true });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const repoPath = (path) => path.split(sep).join('/');

function confinedPath(root, path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('Snapshot path must be a nonempty string.');
  if (isAbsolute(path)) throw new Error(`Snapshot path must be relative: ${path}`);
  const absolute = resolve(root, path);
  const name = relative(root, absolute);
  if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) throw new Error(`Snapshot path escapes the worktree: ${path}`);
  return { absolute, name: repoPath(name) };
}

async function assertSafeParents(root, name) {
  let current = root;
  for (const part of name.split('/').slice(0, -1)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Snapshot path has a symlink parent: ${name}`);
    if (!info.isDirectory()) throw new Error(`Snapshot path has a non-directory parent: ${name}`);
  }
}

async function entryFor(root, name) {
  const { absolute, name: normalized } = confinedPath(root, name);
  await assertSafeParents(root, normalized);
  let handle;
  try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    // O_NOFOLLOW rejects a symlink on POSIX; Windows may report ENOENT for a broken link.
    let info;
    try { info = await lstat(absolute); }
    catch (lookupError) {
      if (lookupError.code === 'ENOENT') return { path: normalized, type: 'deleted', mode: null, sha256: null };
      throw lookupError;
    }
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: 'buffer' });
      return { path: normalized, type: 'symlink', mode: info.mode.toString(8), sha256: sha256(target) };
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    const current = await lstat(absolute);
    if (current.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: 'buffer' });
      return { path: normalized, type: 'symlink', mode: current.mode.toString(8), sha256: sha256(target) };
    }
    if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino ||
        await realpath(dirname(absolute)) !== dirname(absolute)) throw new Error(`Snapshot path changed type while reading: ${normalized}`);
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return { path: normalized, type: 'file', mode: opened.mode.toString(8), sha256: digest.digest('hex') };
  } finally { await handle.close(); }
}

function statusPaths(output) {
  const paths = new Set();
  for (let at = 0; at < output.length;) {
    const end = output.indexOf(0, at);
    if (end < 0) throw new Error('Malformed null-delimited Git status.');
    const record = output.subarray(at, end);
    if (record.length < 4 || record[2] !== 32) throw new Error('Malformed Git status entry.');
    const code = record.toString('ascii', 0, 2);
    paths.add(repoPath(decodePath.decode(record.subarray(3))));
    at = end + 1;
    if (code.includes('R') || code.includes('C')) {
      const priorEnd = output.indexOf(0, at);
      if (priorEnd < 0) throw new Error('Malformed null-delimited Git rename.');
      paths.add(repoPath(decodePath.decode(output.subarray(at, priorEnd))));
      at = priorEnd + 1;
    }
  }
  return paths;
}

function nullDelimitedPaths(output) {
  const paths = new Set();
  for (let at = 0; at < output.length;) {
    const end = output.indexOf(0, at);
    if (end < 0) throw new Error('Malformed null-delimited Git path list.');
    paths.add(repoPath(decodePath.decode(output.subarray(at, end))));
    at = end + 1;
  }
  return paths;
}

async function assertVisibleIndex(root) {
  const { stdout } = await exec('git', ['-C', root, 'ls-files', '-v', '-z'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  for (let at = 0; at < stdout.length;) {
    const end = stdout.indexOf(0, at);
    if (end < 0) throw new Error('Malformed null-delimited Git index listing.');
    const record = stdout.subarray(at, end);
    if (record.length < 3 || record[1] !== 32) throw new Error('Malformed Git index entry.');
    const marker = record[0];
    if ((marker >= 97 && marker <= 122) || marker === 83) {
      const path = decodePath.decode(record.subarray(2));
      throw new Error(`Tracked path uses assume-unchanged or skip-worktree and cannot be safely reviewed: ${path}`);
    }
    at = end + 1;
  }
}

async function indexModes(root) {
  const { stdout } = await exec('git', ['-C', root, 'ls-files', '--stage', '-z'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const modes = new Map();
  for (let at = 0; at < stdout.length;) {
    const end = stdout.indexOf(0, at);
    if (end < 0) throw new Error('Malformed null-delimited Git index listing.');
    const record = stdout.subarray(at, end);
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error('Malformed Git index entry.');
    const [mode, , stage] = record.toString('ascii', 0, tab).split(' ');
    const path = repoPath(decodePath.decode(record.subarray(tab + 1)));
    if (stage !== '0' || modes.has(path)) throw new Error(`Unmerged Git index entry: ${path}`);
    modes.set(path, mode);
    at = end + 1;
  }
  return modes;
}

/** Capture every changed tracked and nonignored untracked path, plus the manifest. */
export async function captureWorktreeSnapshot(worktree, baseCommit, manifestPath, { allowMissingManifest = false, allowHeadChange = false } = {}) {
  const rootInfo = await lstat(resolve(worktree));
  if (rootInfo.isSymbolicLink()) throw new Error('Worktree root cannot be a symlink.');
  if (!rootInfo.isDirectory()) throw new Error('Worktree root must be a directory.');
  const root = await realpath(worktree);
  if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error('Snapshot base commit must be a full Git hash.');
  const { stdout: headOutput } = await exec('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  if (!allowHeadChange && headOutput.trim() !== baseCommit) throw new Error('Worktree HEAD changed after its base commit.');
  await assertVisibleIndex(root);
  const { stdout } = await exec('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const paths = statusPaths(stdout);
  if (allowHeadChange && headOutput.trim() !== baseCommit) {
    const { stdout: committed } = await exec('git', ['-C', root, 'diff', '--name-only', '-z', '--no-renames', baseCommit, 'HEAD', '--'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    for (const name of nullDelimitedPaths(committed)) paths.add(name);
  }
  // macOS temporary paths may be spelled /var/... while realpath uses /private/var/....
  let manifestName = manifestPath;
  if (isAbsolute(manifestPath)) {
    const originalRoot = resolve(worktree);
    const fromOriginal = relative(originalRoot, manifestPath);
    manifestName = fromOriginal !== '..' && !fromOriginal.startsWith(`..${sep}`) && !isAbsolute(fromOriginal)
      ? fromOriginal : relative(root, manifestPath);
  }
  const manifest = confinedPath(root, manifestName).name;
  paths.add(manifest);
  const indexedModes = await indexModes(root);
  const files = [];
  for (const path of [...paths].sort()) {
    const entry = await entryFor(root, path);
    if (entry.type === 'file') {
      // Keep the raw permissions and byte digest exact. Separately attest the
      // index metadata that Windows retains despite its native stat permissions.
      entry.indexMode = indexedModes.get(entry.path) ?? null;
      if (process.platform === 'win32') entry.gitMode = gitModeForWorktreeFile(entry.mode, entry.indexMode);
    }
    files.push(entry);
  }
  if (!allowMissingManifest && files.find((entry) => entry.path === manifest)?.type === 'deleted') throw new Error(`Worktree manifest is missing: ${manifest}`);
  return { baseCommit, files, digest: sha256(JSON.stringify({ baseCommit, files })) };
}

/** Return path-level differences between a passing snapshot and current state. */
export function compareWorktreeSnapshots(expected, actual) {
  const before = new Map((expected?.files || []).map((entry) => [entry.path, entry]));
  const after = new Map((actual?.files || []).map((entry) => [entry.path, entry]));
  const added = [], removed = [], changed = [];
  for (const path of after.keys()) if (!before.has(path)) added.push(path);
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  for (const [path, entry] of after) {
    if (!before.has(path)) continue;
    const previous = before.get(path);
    // Older passing snapshots predate index metadata. Their raw mode and bytes
    // remain comparable; new evidence binds both additional fields exactly.
    const comparable = { ...entry };
    if (!Object.hasOwn(previous, 'indexMode')) delete comparable.indexMode;
    if (!Object.hasOwn(previous, 'gitMode')) delete comparable.gitMode;
    if (JSON.stringify(comparable) !== JSON.stringify(previous)) changed.push(path);
  }
  added.sort(); removed.sort(); changed.sort();
  const equal = expected?.baseCommit === actual?.baseCommit && added.length === 0 && removed.length === 0 && changed.length === 0;
  return { equal, added, removed, changed };
}
