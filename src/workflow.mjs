import { mkdir, readFile, writeFile, appendFile, lstat, readlink, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { validateBlock, validateProposalPatches, hashProposal } from './contracts.mjs';
import { validateCreateScope, assertCreatePathAbsent } from './create-scope.mjs';
import { captureWorktreeSnapshot, compareWorktreeSnapshots } from './worktree-snapshot.mjs';

const exec = promisify(execFile);
const safeName = (id) => /^[a-z][a-z0-9-]*$/.test(id);
const sliceName = (id) => {
  if (!safeName(id)) throw new Error('Slice ID must be kebab-case.');
  return id;
};
const rootDir = (root) => join(resolve(root), '.blocks');
const roadmapDir = (root, id) => {
  if (!safeName(id)) throw new Error('Roadmap ID must be kebab-case.');
  return join(rootDir(root), 'roadmaps', id);
};
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const worktreeAt = (root, roadmapId, sliceId) => join(rootDir(root), 'worktrees', sliceName(roadmapId), sliceName(sliceId));
const branchFor = (roadmapId, sliceId) => `block-beaver/${sliceName(roadmapId)}/${sliceName(sliceId)}`;
const manifestRelativePath = (sliceId) => `.blocks/manifests/${sliceName(sliceId)}.json`;
const gitHead = async (root) => (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
const createScopeOf = (roadmap) => roadmap.createScope || [];
const patchOp = (patch) => patch.op || 'replace';
const patchBoundary = (proposal) => (proposal.patches || []).map((patch) => `${patchOp(patch)}\0${patch.path}`).sort();
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');
const inside = (root, path) => {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split('/').includes('..') || path.split('/').includes('.') || path.includes('\\')) throw new Error(`Unsafe worktree path: ${path}`);
  const target = resolve(root, path);
  if (target === resolve(root) || relative(resolve(root), target).startsWith(`..${sep}`) || relative(resolve(root), target) === '..') throw new Error(`Path escapes worktree: ${path}`);
  return target;
};
async function safeWorktreeTarget(worktree, path, create) {
  const target = inside(worktree, path);
  const parent = dirname(target);
  const pieces = relative(worktree, parent).split(sep).filter(Boolean);
  let cursor = resolve(worktree);
  for (const piece of pieces) {
    cursor = join(cursor, piece);
    try {
      const entry = await lstat(cursor);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Worktree path has an unsafe parent: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(cursor);
    }
  }
  try {
    const existing = await lstat(target);
    if (create) throw new Error(`Create target already exists in worktree: ${path}`);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Replacement target is not a regular file: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) throw new Error(`Replacement target is missing in worktree: ${path}`);
  }
  return target;
}
async function writeWorktreeFile(worktree, target, content, { create, expectedHash = null } = {}) {
  const expectedParent = resolve(await realpath(worktree), relative(worktree, dirname(target)));
  if (await realpath(dirname(target)) !== expectedParent) throw new Error(`Worktree parent changed before write: ${target}`);
  const flags = create ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW : constants.O_RDWR | constants.O_NOFOLLOW;
  const handle = await open(target, flags, 0o666);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Worktree target is not an isolated regular file: ${target}`);
    if (await realpath(dirname(target)) !== expectedParent) throw new Error(`Worktree parent changed during write: ${target}`);
    if (expectedHash) {
      const digest = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      if (!digest.digest('hex').startsWith(expectedHash)) throw new Error(`Worktree preimage changed before write: ${target}`);
    }
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      offset += bytesWritten;
    }
    await handle.truncate(bytes.length);
  } finally { await handle.close(); }
}
function assertAllowedChanges(snapshot, allowed, { allowMissingManifest = null } = {}) {
  const unexpected = snapshot.files.map((entry) => entry.path).filter((path) => !allowed.has(path));
  if (unexpected.length) throw new Error(`Worktree contains changes outside the declared scope: ${unexpected.join(', ')}`);
  const unsupported = snapshot.files.filter((entry) => (entry.type === 'deleted' && entry.path !== allowMissingManifest) || entry.type === 'symlink');
  if (unsupported.length) throw new Error(`Worktree contains unsupported deletion or symlink changes: ${unsupported.map((entry) => entry.path).join(', ')}`);
}
async function hashWorktreeFile(worktree, path) {
  const target = inside(worktree, path);
  const expectedParent = resolve(await realpath(worktree), relative(worktree, dirname(target)));
  if (await realpath(dirname(target)) !== expectedParent) throw new Error(`Worktree path has a symlink parent: ${path}`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Worktree path is not an isolated regular file: ${path}`);
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest('hex');
  } finally { await handle.close(); }
}
async function assertSourceMatchesBase(root, baseCommit, path) {
  const source = inside(root, path);
  const { stdout: sourceHash } = await exec('git', ['-C', root, 'hash-object', `--path=${path}`, '--', source]);
  const { stdout: baseHash } = await exec('git', ['-C', root, 'rev-parse', '--verify', `${baseCommit}:${path}`]);
  if (sourceHash.trim() !== baseHash.trim()) throw new Error(`Source file differs from the roadmap base commit: ${path}`);
}
async function bootstrapLegacyWorktree(worktree, snapshot, proposal, manifestPath) {
  const patches = proposal.patches || [];
  const allowed = new Set([manifestPath, ...patches.map((patch) => patch.path)]);
  assertAllowedChanges(snapshot, allowed);
  if (snapshot.files.some((entry) => entry.type !== 'file')) throw new Error('Legacy worktree contains an unsupported change.');
  const expected = new Map([[manifestPath, JSON.stringify(proposal.manifest, null, 2) + '\n'], ...patches.map((patch) => [patch.path, patch.content])]);
  for (const [path, content] of expected) {
    const actual = await hashWorktreeFile(worktree, path);
    const wanted = createHash('sha256').update(content).digest('hex');
    if (actual !== wanted) throw new Error(`Legacy worktree differs from the saved proposal: ${path}`);
  }
  return snapshot;
}
async function prepareWorktree(root, roadmapId, sliceId, proposal, roadmap, previousEvidence, legacyPass) {
  const worktree = worktreeAt(root, roadmapId, sliceId);
  let baseCommit = roadmap.baseCommit;
  if (!baseCommit) {
    baseCommit = await gitHead(root);
    try {
      await lstat(worktree);
      if (await gitHead(worktree) !== baseCommit) throw new Error('Legacy worktree HEAD differs from the source checkout. Recreate it before checking.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const path of [rootDir(root), join(rootDir(root), 'worktrees'), join(rootDir(root), 'worktrees', roadmapId), worktree]) {
    try {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Worktree location contains a symlink or non-directory: ${path}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let existed = true;
  try { await lstat(worktree); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    existed = false;
    await mkdir(join(rootDir(root), 'worktrees', roadmapId), { recursive: true });
    await exec('git', ['-C', root, 'worktree', 'add', '-b', branchFor(roadmapId, sliceId), worktree, baseCommit]);
  }
  const topLevel = (await exec('git', ['-C', worktree, 'rev-parse', '--show-toplevel'])).stdout.trim();
  const actualWorktree = await realpath(worktree);
  if (await realpath(topLevel) !== actualWorktree) throw new Error('Worktree path is not its Git checkout root.');
  const listed = (await exec('git', ['-C', root, 'worktree', 'list', '--porcelain'])).stdout;
  const listedPaths = listed.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
  const registered = await Promise.allSettled(listedPaths.map((path) => realpath(path)));
  if (!registered.some((entry) => entry.status === 'fulfilled' && entry.value === actualWorktree)) throw new Error('Git does not recognize the isolated worktree.');
  const manifestPath = manifestRelativePath(sliceId);
  const before = await captureWorktreeSnapshot(worktree, baseCommit, manifestPath, { allowMissingManifest: true });
  if (!previousEvidence && legacyPass && existed) previousEvidence = await bootstrapLegacyWorktree(worktree, before, proposal, manifestPath);
  const allowedBefore = new Set(previousEvidence ? [manifestPath, ...roadmap.scope, ...createScopeOf(roadmap)] : [manifestPath]);
  assertAllowedChanges(before, allowedBefore, { allowMissingManifest: manifestPath });
  if (previousEvidence && !compareWorktreeSnapshots(previousEvidence, before).equal) throw new Error('Worktree changed since the previous check attempt. Restore it before retrying.');
  const previousEntry = (path) => previousEvidence?.files.find((file) => file.path === path && file.type === 'file');
  const manifestExists = before.files.some((file) => file.path === manifestPath && file.type !== 'deleted');
  if (manifestExists && !previousEntry(manifestPath)) throw new Error('Worktree manifest exists without prior check evidence. Restore it before retrying.');
  const manifestTarget = await safeWorktreeTarget(worktree, manifestPath, !manifestExists);
  await writeWorktreeFile(worktree, manifestTarget, JSON.stringify(proposal.manifest, null, 2) + '\n', { create: !manifestExists, expectedHash: previousEntry(manifestPath)?.sha256 });
  for (const patch of proposal.patches || []) {
    const existsInWorktree = before.files.some((file) => file.path === patch.path && file.type !== 'deleted');
    if (patchOp(patch) === 'create' && existsInWorktree && !previousEntry(patch.path)) {
      throw new Error(`Create target appeared in worktree without passing check evidence: ${patch.path}`);
    }
    const target = await safeWorktreeTarget(worktree, patch.path, patchOp(patch) === 'create' && !existsInWorktree);
    if (patchOp(patch) === 'replace' && !previousEntry(patch.path)) await assertSourceMatchesBase(root, baseCommit, patch.path);
    // Git may check out CRLF bytes from an LF blob. The clean worktree snapshot and
    // source blob check establish the first preimage; retries use the saved raw hash.
    await writeWorktreeFile(worktree, target, patch.content, { create: patchOp(patch) === 'create' && !existsInWorktree, expectedHash: previousEntry(patch.path)?.sha256 });
  }
  return { worktree, baseCommit, manifestPath };
}
async function runVerification(worktree, commands) {
  const checks = [];
  const { BLOCK_BEAVER_TOKEN: _workerToken, BLOCK_STUDIO_TOKEN: _oldWorkerToken, ...safeEnvironment } = process.env;
  for (const command of commands || []) {
    const args = Array.isArray(command) ? command : command.trim().split(/\s+/);
    if (!args.length || args.some((arg) => !arg || /[;&|`$<>]/.test(arg))) {
      checks.push({ command, pass: false, output: 'Use a command and arguments without shell operators.' });
      continue;
    }
    try {
      const result = await exec(args[0], args.slice(1), { cwd: worktree, env: safeEnvironment, timeout: 120_000, maxBuffer: 2_000_000 });
      checks.push({ command, pass: true, output: `${result.stdout}${result.stderr}`.slice(-4000) });
    } catch (error) { checks.push({ command, pass: false, output: `${error.stdout || ''}${error.stderr || ''}${error.message}`.slice(-4000) }); }
  }
  return checks;
}

export async function events(root, id) {
  try { return (await readFile(join(roadmapDir(root, id), 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function record(root, id, type, data = {}) {
  const dir = roadmapDir(root, id);
  await mkdir(dir, { recursive: true });
  const entry = { seq: (await events(root, id)).length + 1, at: new Date().toISOString(), type, ...data };
  await appendFile(join(dir, 'events.jsonl'), JSON.stringify(entry) + '\n');
  return entry;
}

export async function createRoadmap(root, id, graph, { title = id, scope = [], createScope = [] } = {}) {
  if (!Array.isArray(scope) || !Array.isArray(createScope) || scope.length + createScope.length === 0) throw new Error('A roadmap needs a bounded file scope. Pass --scope or --create.');
  for (const file of scope) if (!graph.hashes[file]) throw new Error(`Roadmap scope contains an unscanned file: ${file}`);
  createScope = await validateCreateScope(root, graph, createScope, { scope });
  const dir = roadmapDir(root, id);
  try { await readFile(join(dir, 'roadmap.json')); throw new Error(`Roadmap ${id} already exists.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dir, { recursive: true });
  const roadmap = { schemaVersion: 1, id, title, scope, createScope, createdAt: new Date().toISOString(), baseFingerprint: graph.fingerprint, baseCommit: await gitHead(root), slices: [] };
  await writeJson(join(dir, 'roadmap.json'), roadmap);
  await record(root, id, 'roadmap-created', { fingerprint: graph.fingerprint });
  return roadmap;
}

export async function propose(root, roadmapId, proposal, graph) {
  const dir = roadmapDir(root, roadmapId);
  const roadmap = await readJson(join(dir, 'roadmap.json'));
  await validateCreateScope(root, graph, createScopeOf(roadmap), { scope: roadmap.scope });
  const { manifest } = proposal;
  if (!safeName(manifest?.id)) throw new Error('Proposal needs a kebab-case block ID.');
  if (!Array.isArray(manifest.files)) throw new Error('Proposal needs implementation files.');
  if (!manifest.files.every((file) => [...roadmap.scope, ...createScopeOf(roadmap)].includes(file))) throw new Error('Proposal exceeds the roadmap scope.');
  const patchCheck = validateProposalPatches(proposal, graph, { scope: roadmap.scope, createScope: createScopeOf(roadmap) });
  if (!patchCheck.valid) return { accepted: false, check: patchCheck };
  for (const path of patchCheck.createdPaths) await assertCreatePathAbsent(root, path);
  const check = validateBlock(manifest, graph, { createdPaths: patchCheck.createdPaths });
  if (!check.valid) return { accepted: false, check };
  const id = manifest.id;
  if (roadmap.slices.some((slice) => slice.id === id)) throw new Error(`Slice ${id} already exists.`);
  const saved = { ...proposal, check, fingerprint: graph.fingerprint, id, status: 'proposed' };
  await writeJson(join(dir, `${id}.proposal.json`), saved);
  roadmap.slices.push({ id, status: 'proposed' });
  await writeJson(join(dir, 'roadmap.json'), roadmap);
  await record(root, roadmapId, 'slice-proposed', { slice: id, proposalHash: hashProposal(saved), fingerprint: graph.fingerprint });
  return { accepted: true, proposal: saved };
}

export async function repair(root, roadmapId, sliceId, candidate, graph) {
  sliceName(sliceId);
  const state = await resume(root, roadmapId);
  if (!['proposed', 'failed', 'checked'].includes(state.slices[sliceId]?.status)) throw new Error('Only a pending or failed slice may be repaired.');
  const path = join(roadmapDir(root, roadmapId), `${sliceId}.proposal.json`);
  const previous = await readJson(path);
  await validateCreateScope(root, graph, createScopeOf(state.roadmap), { scope: state.roadmap.scope });
  if (candidate.manifest?.id !== sliceId || !sameSet(candidate.manifest.files, previous.manifest.files)) throw new Error('Repair cannot change the slice ID or file boundary.');
  if (!sameSet(patchBoundary(candidate), patchBoundary(previous))) throw new Error('Repair cannot change patch paths or operations.');
  const patchCheck = validateProposalPatches(candidate, graph, { scope: state.roadmap.scope, createScope: createScopeOf(state.roadmap) });
  if (!patchCheck.valid) return { accepted: false, check: patchCheck };
  for (const path of patchCheck.createdPaths) await assertCreatePathAbsent(root, path);
  const check = validateBlock(candidate.manifest, graph, { createdPaths: patchCheck.createdPaths });
  if (!check.valid) return { accepted: false, check };
  const saved = { ...candidate, check, id: sliceId, fingerprint: graph.fingerprint, status: 'proposed', repairedAt: new Date().toISOString() };
  await writeJson(path, saved);
  await record(root, roadmapId, 'slice-repaired', { slice: sliceId, proposalHash: hashProposal(saved), fingerprint: graph.fingerprint });
  return { accepted: true, proposal: saved };
}

export async function checkSlice(root, roadmapId, sliceId, graph, { recordEvent = true, prepare = true } = {}) {
  sliceName(sliceId);
  const dir = roadmapDir(root, roadmapId);
  const roadmap = await readJson(join(dir, 'roadmap.json'));
  const proposal = await readJson(join(dir, `${sliceId}.proposal.json`));
  const patchCheck = validateProposalPatches(proposal, graph, { scope: roadmap.scope, createScope: createScopeOf(roadmap) });
  const validation = validateBlock(proposal.manifest, graph, { createdPaths: patchCheck.createdPaths });
  const drift = proposal.fingerprint !== graph.fingerprint;
  const patchErrors = [...patchCheck.errors];
  try { await validateCreateScope(root, graph, createScopeOf(roadmap), { scope: roadmap.scope }); }
  catch (error) { patchErrors.push({ path: '$.createScope', message: error.message }); }
  const result = { pass: validation.valid && !drift && patchErrors.length === 0, validation, drift, patchErrors, verification: [], proposalHash: hashProposal(proposal), expectedFingerprint: proposal.fingerprint, currentFingerprint: graph.fingerprint };
  if (result.pass && prepare) {
    try {
      const latestEvidenceEvent = [...await events(root, roadmapId)].reverse().find((event) => event.slice === sliceId && (event.result?.attemptSnapshot || event.result?.snapshot));
      const previousEvidence = latestEvidenceEvent?.result?.attemptSnapshot || latestEvidenceEvent?.result?.snapshot;
      const legacyPass = !previousEvidence && [...await events(root, roadmapId)].reverse().find((event) => event.slice === sliceId && event.type === 'checks-passed' && !event.result?.snapshot);
      const prepared = await prepareWorktree(root, roadmapId, sliceId, proposal, roadmap, previousEvidence, legacyPass);
      result.worktree = prepared.worktree;
      const commands = graph.adapter === 'teacake' ? [...(proposal.manifest.verification || []), 'pnpm blocks:check'] : proposal.manifest.verification;
      result.verification = await runVerification(result.worktree, commands);
      result.pass = result.verification.every((check) => check.pass);
      const snapshot = await captureWorktreeSnapshot(prepared.worktree, prepared.baseCommit, prepared.manifestPath);
      result.attemptSnapshot = snapshot;
      assertAllowedChanges(snapshot, new Set([...roadmap.scope, ...createScopeOf(roadmap), prepared.manifestPath]));
      if (result.pass) result.snapshot = snapshot;
    } catch (error) {
      result.pass = false;
      result.verification.push({ command: 'worktree integrity', pass: false, output: error.message });
    }
  }
  if (recordEvent) await record(root, roadmapId, result.pass ? 'checks-passed' : 'checks-failed', { slice: sliceId, result });
  return result;
}

export async function review(root, roadmapId, sliceId, graph) {
  sliceName(sliceId);
  const dir = roadmapDir(root, roadmapId);
  const proposal = await readJson(join(dir, `${sliceId}.proposal.json`));
  const check = await checkSlice(root, roadmapId, sliceId, graph, { recordEvent: false, prepare: false });
  const sliceEvents = (await events(root, roadmapId)).filter((event) => event.slice === sliceId);
  const lastPass = [...sliceEvents].reverse().find((event) => event.type === 'checks-passed');
  const currentStatus = (await resume(root, roadmapId)).slices[sliceId]?.status;
  const worktree = worktreeAt(root, roadmapId, sliceId);
  let snapshot;
  let integrity = { matches: false, reason: 'No passing check snapshot is available.' };
  try {
    const baseCommit = lastPass?.result?.snapshot?.baseCommit || await gitHead(worktree);
    try { snapshot = await captureWorktreeSnapshot(worktree, baseCommit, manifestRelativePath(sliceId)); }
    catch (error) {
      if (!/HEAD changed/.test(error.message)) throw error;
      snapshot = await captureWorktreeSnapshot(worktree, baseCommit, manifestRelativePath(sliceId), { allowHeadChange: true });
      integrity = { matches: false, reason: error.message };
    }
    if (lastPass?.result?.snapshot && !/HEAD changed/.test(integrity.reason)) {
      const comparison = compareWorktreeSnapshots(lastPass.result.snapshot, snapshot);
      integrity = { matches: comparison.equal, reason: comparison.equal ? null : 'Worktree changed after checks.', ...comparison };
    }
  } catch (error) { integrity = { matches: false, reason: error.message }; }
  if (currentStatus !== 'checked' && integrity.matches) integrity = { ...integrity, matches: false, reason: 'The latest slice state has no passing checks.' };
  if (lastPass?.result?.proposalHash && lastPass.result.proposalHash !== hashProposal(proposal)) integrity = { ...integrity, matches: false, reason: 'Proposal changed after checks.' };
  const changeSet = [];
  for (const entry of snapshot?.files || []) {
    const before = await reviewVersionFromGit(worktree, snapshot.baseCommit, entry.path);
    const after = await reviewVersionFromWorktree(worktree, entry);
    changeSet.push({ ...entry, before, after });
  }
  const patches = await Promise.all((proposal.patches || []).map(async (patch) => {
    let before = null;
    if (patchOp(patch) !== 'create') before = await readFile(join(root, patch.path), 'utf8');
    return { path: patch.path, op: patchOp(patch), before, after: patch.content, baseHash: patch.baseHash };
  }));
  return { slice: sliceId, check, target: manifestRelativePath(sliceId), proposedContent: JSON.stringify(proposal.manifest, null, 2) + '\n', patches, changeSet, integrity, files: proposal.manifest.files, events: sliceEvents };
}

function reviewBytes(value, sha256) {
  if (value === null) return null;
  const digest = sha256 || createHash('sha256').update(value).digest('hex');
  if (value.length > 2_000_000 || value.includes(0)) return { binary: true, bytes: value.length, sha256: digest };
  try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(value), bytes: value.length, sha256: digest }; }
  catch { return { binary: true, bytes: value.length, sha256: digest }; }
}

async function reviewVersionFromGit(worktree, baseCommit, path) {
  try {
    const { stdout } = await exec('git', ['-C', worktree, 'show', `${baseCommit}:${path}`], { encoding: 'buffer', maxBuffer: 2_000_000 });
    return reviewBytes(stdout);
  } catch (error) {
    if (error.code === 128) return null;
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { binary: true, bytes: 'over 2 MB' };
    throw error;
  }
}

async function reviewVersionFromWorktree(worktree, entry) {
  if (entry.type === 'deleted') return null;
  if (entry.type === 'symlink') return { symlinkTarget: await readlink(inside(worktree, entry.path)), sha256: entry.sha256 };
  const target = inside(worktree, entry.path);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Review target changed type: ${entry.path}`);
    if (info.size > 2_000_000) return { binary: true, bytes: info.size, sha256: entry.sha256 };
    return reviewBytes(await handle.readFile(), entry.sha256);
  } finally { await handle.close(); }
}

export async function reject(root, roadmapId, sliceId, reason) {
  sliceName(sliceId);
  if (!reason?.trim()) throw new Error('A rejection reason is required.');
  const state = await resume(root, roadmapId);
  if (!state.slices[sliceId] || state.slices[sliceId].status === 'approved') throw new Error('Only a pending or failed slice may be rejected.');
  await record(root, roadmapId, 'slice-rejected', { slice: sliceId, reason });
  return { status: 'rejected', slice: sliceId };
}

export async function approve(root, roadmapId, sliceId, graph) {
  sliceName(sliceId);
  const state = await resume(root, roadmapId);
  if (state.slices[sliceId]?.status !== 'checked') throw new Error('Run passing checks in the isolated worktree before approval.');
  const check = await checkSlice(root, roadmapId, sliceId, graph, { recordEvent: false, prepare: false });
  if (!check.pass) throw new Error('Proposal checks failed or source changed. Review and propose again.');
  const lastPass = [...state.events].reverse().find((event) => event.type === 'checks-passed' && event.slice === sliceId);
  if (!lastPass?.result?.snapshot) throw new Error('Passing worktree snapshot is missing. Run check again.');
  const proposal = await readJson(join(roadmapDir(root, roadmapId), `${sliceId}.proposal.json`));
  if (lastPass.result.proposalHash !== hashProposal(proposal)) throw new Error('Proposal changed after checks. Run check again.');
  const worktree = worktreeAt(root, roadmapId, sliceId);
  const target = join(worktree, '.blocks', 'manifests', `${sliceId}.json`);
  let snapshot;
  try { snapshot = await captureWorktreeSnapshot(worktree, lastPass.result.snapshot.baseCommit, manifestRelativePath(sliceId)); }
  catch (error) { throw new Error(`Worktree changed after checks. Run check again. ${error.message}`); }
  if (!compareWorktreeSnapshots(lastPass.result.snapshot, snapshot).equal) throw new Error('Worktree changed after checks. Run check again.');
  const branch = branchFor(roadmapId, sliceId);
  await record(root, roadmapId, 'slice-approved', { slice: sliceId, branch, worktree, target });
  return { status: 'approved', branch, worktree, target };
}

export async function resume(root, roadmapId) {
  const roadmap = await readJson(join(roadmapDir(root, roadmapId), 'roadmap.json'));
  const ledger = await events(root, roadmapId);
  const slices = Object.fromEntries(roadmap.slices.map((slice) => [slice.id, { status: 'proposed' }]));
  for (const event of ledger) {
    if (!event.slice) continue;
    if (event.type === 'slice-repaired') slices[event.slice] = { status: 'proposed' };
    if (event.type === 'checks-passed') slices[event.slice] = { ...slices[event.slice], status: 'checked' };
    if (event.type === 'checks-failed') slices[event.slice] = { ...slices[event.slice], status: 'failed' };
    if (event.type === 'slice-rejected') slices[event.slice] = { status: 'rejected', reason: event.reason };
    if (event.type === 'slice-approved') slices[event.slice] = { status: 'approved', branch: event.branch, worktree: event.worktree };
  }
  for (const slice of roadmap.slices) {
    try { slices[slice.id].files = (await readJson(join(roadmapDir(root, roadmapId), `${slice.id}.proposal.json`))).manifest.files; }
    catch { slices[slice.id].files = []; }
  }
  return { roadmap, slices, events: ledger };
}
