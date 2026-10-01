import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitModeForWorktreeFile } from './file-mode.mjs';

const exec = promisify(execFile);
const decoder = new TextDecoder('utf-8', { fatal: true });
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const repositoryVariables = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];
const configVariable = /^GIT_CONFIG(?:|_PARAMETERS|_COUNT|_KEY_\d+|_VALUE_\d+)$/;
// Hooks export these for the host repository, as do `git -c` overrides and GIT_CONFIG; a command aimed at
// another repository must not inherit them. Names compare case-insensitively because Windows env is.
export function isolatedGitEnv(base = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    const upper = name.toUpperCase();
    if (!repositoryVariables.includes(upper) && !configVariable.test(upper)) env[name] = value;
  }
  return env;
}

export async function git(root, args, { buffer = false, isolated = false } = {}) {
  const result = await exec('git', ['-C', root, ...args], { encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, ...(isolated ? { env: isolatedGitEnv() } : {}) });
  return result.stdout;
}

function fields(buffer) {
  const result = [];
  for (let at = 0; at < buffer.length;) {
    const end = buffer.indexOf(0, at);
    if (end < 0) throw new Error('Malformed null-delimited Git output.');
    result.push(decoder.decode(buffer.subarray(at, end)));
    at = end + 1;
  }
  return result;
}

export async function changedPaths(root, mode, base = null) {
  const args = mode === 'staged' ? ['diff', '--cached', '--name-status', '-z', '--no-renames', 'HEAD', '--']
    : mode === 'range' ? ['diff', '--name-status', '-z', '--no-renames', base, 'HEAD', '--']
      : ['diff', '--name-status', '-z', '--no-renames', 'HEAD', '--'];
  const parts = fields(await git(root, args, { buffer: true }));
  if (parts.length % 2) throw new Error('Malformed Git change list.');
  const changed = new Map();
  for (let index = 0; index < parts.length; index += 2) changed.set(parts[index + 1], parts[index]);
  if (mode === 'working') {
    for (const path of fields(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { buffer: true }))) changed.set(path, 'A');
  }
  return [...changed].map(([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
}

export async function versionBytes(root, path, mode, base = null) {
  if (mode === 'working') {
    try {
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) return await readlink(join(root, path), { encoding: 'buffer' });
      if (!info.isFile()) throw new Error(`Changed path is not a regular file: ${path}`);
      return await readFile(join(root, path));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const rev = mode === 'staged' ? `:${path}` : `HEAD:${path}`;
  try { return await git(root, ['show', rev], { buffer: true }); }
  catch (error) { if (error.code === 128) return null; throw error; }
}

export async function versionMode(root, path, mode, base = null) {
  if (mode === 'working') {
    try {
      const info = await lstat(join(root, path));
      const nativeMode = info.mode.toString(8);
      return info.isFile() ? gitModeForWorktreeFile(nativeMode,
        process.platform === 'win32' ? await versionMode(root, path, 'staged') : null) : nativeMode;
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const output = mode === 'staged' ? await git(root, ['ls-files', '--stage', '-z', '--', path], { buffer: true })
    : await git(root, ['ls-tree', '-z', 'HEAD', '--', path], { buffer: true });
  const entries = fields(output);
  if (!entries.length) return null;
  if (entries.length !== 1 || !entries[0].endsWith(`\t${path}`)) throw new Error(`Ambiguous Git index entry: ${path}`);
  const header = entries[0].split('\t')[0].split(' ');
  if (mode === 'staged' && header[2] !== '0') throw new Error(`Unmerged Git index entry: ${path}`);
  return header[0];
}

export async function baseBytes(root, path, mode, base = null) {
  const rev = `${mode === 'range' ? base : 'HEAD'}:${path}`;
  try { return await git(root, ['show', rev], { buffer: true }); }
  catch (error) { if (error.code === 128) return null; throw error; }
}

export async function baseMode(root, path, mode, base = null) {
  const ref = mode === 'range' ? base : 'HEAD';
  const entries = fields(await git(root, ['ls-tree', '-z', ref, '--', path], { buffer: true }));
  if (!entries.length) return null;
  if (entries.length !== 1 || !entries[0].endsWith(`\t${path}`)) throw new Error(`Ambiguous Git tree entry: ${path}`);
  return entries[0].split(' ')[0];
}

export async function evidencePaths(root, mode) {
  const args = mode === 'range' ? ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--'] : ['ls-files', '--cached', '-z', '--'];
  const names = fields(await git(root, args, { buffer: true }));
  if (mode === 'working') names.push(...fields(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { buffer: true })));
  return [...new Set(names)].filter((path) => path.startsWith('.blocks/receipts/') || path.startsWith('.blocks/exceptions/')).sort();
}

export async function gitHead(root) { return (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); }

export async function assertGitRoot(root) {
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(top) !== await realpath(root)) throw new Error(`Audit root must be the Git checkout root: ${top}`);
}

export async function assertAncestor(root, base) {
  if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error('CI base must be a full Git commit hash.');
  try { await git(root, ['merge-base', '--is-ancestor', base, 'HEAD']); }
  catch { throw new Error('CI base is not an ancestor of HEAD. Fetch the base commit and retry.'); }
}
