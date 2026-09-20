import { mkdir, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { validateBlock, hashProposal } from './contracts.mjs';
import ts from 'typescript';

const exec = promisify(execFile);
const safeName = (id) => /^[a-z][a-z0-9-]*$/.test(id);
const rootDir = (root) => join(resolve(root), '.blocks');
const roadmapDir = (root, id) => {
  if (!safeName(id)) throw new Error('Roadmap ID must be kebab-case.');
  return join(rootDir(root), 'roadmaps', id);
};
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const worktreeAt = (root, roadmapId, sliceId) => join(rootDir(root), 'worktrees', roadmapId, sliceId);
const branchFor = (roadmapId, sliceId) => `block-studio/${roadmapId}/${sliceId}`;
async function prepareWorktree(root, roadmapId, sliceId, proposal) {
  const worktree = worktreeAt(root, roadmapId, sliceId);
  try { await stat(worktree); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(join(rootDir(root), 'worktrees', roadmapId), { recursive: true });
    await exec('git', ['-C', root, 'worktree', 'add', '-b', branchFor(roadmapId, sliceId), worktree, 'HEAD']);
  }
  const targetDir = join(worktree, '.blocks', 'manifests');
  await mkdir(targetDir, { recursive: true });
  await writeJson(join(targetDir, `${sliceId}.json`), proposal.manifest);
  for (const patch of proposal.patches || []) await writeFile(join(worktree, patch.path), patch.content);
  return worktree;
}
async function runVerification(worktree, commands) {
  const checks = [];
  for (const command of commands || []) {
    const args = Array.isArray(command) ? command : command.trim().split(/\s+/);
    if (!args.length || args.some((arg) => !arg || /[;&|`$<>]/.test(arg))) {
      checks.push({ command, pass: false, output: 'Use a command and arguments without shell operators.' });
      continue;
    }
    try {
      const result = await exec(args[0], args.slice(1), { cwd: worktree, timeout: 120_000, maxBuffer: 2_000_000 });
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

export async function createRoadmap(root, id, graph, { title = id, scope = [] } = {}) {
  if (!Array.isArray(scope) || scope.length === 0) throw new Error('A roadmap needs a bounded file scope. Pass --scope path1,path2.');
  for (const file of scope) if (!graph.hashes[file]) throw new Error(`Roadmap scope contains an unscanned file: ${file}`);
  const dir = roadmapDir(root, id);
  try { await readFile(join(dir, 'roadmap.json')); throw new Error(`Roadmap ${id} already exists.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dir, { recursive: true });
  const roadmap = { schemaVersion: 1, id, title, scope, createdAt: new Date().toISOString(), baseFingerprint: graph.fingerprint, slices: [] };
  await writeJson(join(dir, 'roadmap.json'), roadmap);
  await record(root, id, 'roadmap-created', { fingerprint: graph.fingerprint });
  return roadmap;
}

export async function propose(root, roadmapId, proposal, graph) {
  const dir = roadmapDir(root, roadmapId);
  const roadmap = await readJson(join(dir, 'roadmap.json'));
  const { manifest } = proposal;
  if (!safeName(manifest?.id)) throw new Error('Proposal needs a kebab-case block ID.');
  if (!manifest.files.every((file) => roadmap.scope.includes(file))) throw new Error('Proposal exceeds the roadmap scope.');
  for (const patch of proposal.patches || []) if (!roadmap.scope.includes(patch.path)) throw new Error(`Patch exceeds the roadmap scope: ${patch.path}`);
  const check = validateBlock(manifest, graph);
  if (!check.valid) return { accepted: false, check };
  const id = manifest.id;
  if (roadmap.slices.some((slice) => slice.id === id)) throw new Error(`Slice ${id} already exists.`);
  const saved = { ...proposal, fingerprint: graph.fingerprint, id, status: 'proposed' };
  await writeJson(join(dir, `${id}.proposal.json`), saved);
  roadmap.slices.push({ id, status: 'proposed' });
  await writeJson(join(dir, 'roadmap.json'), roadmap);
  await record(root, roadmapId, 'slice-proposed', { slice: id, proposalHash: hashProposal(saved), fingerprint: graph.fingerprint });
  return { accepted: true, proposal: saved };
}

export async function repair(root, roadmapId, sliceId, candidate, graph) {
  const state = await resume(root, roadmapId);
  if (!['proposed', 'failed', 'checked'].includes(state.slices[sliceId]?.status)) throw new Error('Only a pending or failed slice may be repaired.');
  const path = join(roadmapDir(root, roadmapId), `${sliceId}.proposal.json`);
  const previous = await readJson(path);
  const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');
  if (candidate.manifest?.id !== sliceId || !sameSet(candidate.manifest.files, previous.manifest.files)) throw new Error('Repair cannot change the slice ID or file boundary.');
  if (!sameSet((candidate.patches || []).map((patch) => patch.path), (previous.patches || []).map((patch) => patch.path))) throw new Error('Repair cannot add or remove patch paths.');
  const check = validateBlock(candidate.manifest, graph);
  if (!check.valid) return { accepted: false, check };
  const saved = { ...candidate, id: sliceId, fingerprint: graph.fingerprint, status: 'proposed', repairedAt: new Date().toISOString() };
  await writeJson(path, saved);
  await record(root, roadmapId, 'slice-repaired', { slice: sliceId, proposalHash: hashProposal(saved), fingerprint: graph.fingerprint });
  return { accepted: true, proposal: saved };
}

export async function checkSlice(root, roadmapId, sliceId, graph, { recordEvent = true, prepare = true } = {}) {
  const dir = roadmapDir(root, roadmapId);
  const proposal = await readJson(join(dir, `${sliceId}.proposal.json`));
  const validation = validateBlock(proposal.manifest, graph);
  const drift = proposal.fingerprint !== graph.fingerprint;
  const patchErrors = [];
  for (const [index, patch] of (proposal.patches || []).entries()) {
    if (typeof patch.path !== 'string' || typeof patch.content !== 'string') { patchErrors.push({ index, message: 'Patch needs a path and replacement content.' }); continue; }
    if (graph.hashes[patch.path] !== patch.baseHash) patchErrors.push({ index, message: `Source changed for ${patch.path}.` });
    const source = ts.createSourceFile(patch.path, patch.content, ts.ScriptTarget.Latest, true, patch.path.endsWith('.tsx') ? ts.ScriptKind.TSX : patch.path.endsWith('.jsx') ? ts.ScriptKind.JSX : patch.path.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    for (const diagnostic of source.parseDiagnostics) patchErrors.push({ index, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') });
  }
  const result = { pass: validation.valid && !drift && patchErrors.length === 0, validation, drift, patchErrors, verification: [], expectedFingerprint: proposal.fingerprint, currentFingerprint: graph.fingerprint };
  if (result.pass && prepare) {
    try {
      result.worktree = await prepareWorktree(root, roadmapId, sliceId, proposal);
      const commands = graph.adapter === 'teacake' ? [...(proposal.manifest.verification || []), 'pnpm blocks:check'] : proposal.manifest.verification;
      result.verification = await runVerification(result.worktree, commands);
      result.pass = result.verification.every((check) => check.pass);
      result.appliedHash = hash(JSON.stringify({ manifest: proposal.manifest, patches: proposal.patches || [] }));
    } catch (error) {
      result.pass = false;
      result.verification.push({ command: 'prepare worktree', pass: false, output: error.message });
    }
  }
  if (recordEvent) await record(root, roadmapId, result.pass ? 'checks-passed' : 'checks-failed', { slice: sliceId, result });
  return result;
}

export async function review(root, roadmapId, sliceId, graph) {
  const dir = roadmapDir(root, roadmapId);
  const proposal = await readJson(join(dir, `${sliceId}.proposal.json`));
  const check = await checkSlice(root, roadmapId, sliceId, graph, { recordEvent: false, prepare: false });
  const patches = await Promise.all((proposal.patches || []).map(async (patch) => ({ path: patch.path, before: await readFile(join(root, patch.path), 'utf8'), after: patch.content, baseHash: patch.baseHash })));
  return { slice: sliceId, check, target: `.blocks/manifests/${sliceId}.json`, proposedContent: JSON.stringify(proposal.manifest, null, 2) + '\n', patches, files: proposal.manifest.files, events: (await events(root, roadmapId)).filter((event) => event.slice === sliceId) };
}

export async function reject(root, roadmapId, sliceId, reason) {
  if (!reason?.trim()) throw new Error('A rejection reason is required.');
  const state = await resume(root, roadmapId);
  if (!state.slices[sliceId] || state.slices[sliceId].status === 'approved') throw new Error('Only a pending or failed slice may be rejected.');
  await record(root, roadmapId, 'slice-rejected', { slice: sliceId, reason });
  return { status: 'rejected', slice: sliceId };
}

export async function approve(root, roadmapId, sliceId, graph) {
  const state = await resume(root, roadmapId);
  if (state.slices[sliceId]?.status !== 'checked') throw new Error('Run passing checks in the isolated worktree before approval.');
  const check = await checkSlice(root, roadmapId, sliceId, graph, { recordEvent: false, prepare: false });
  if (!check.pass) throw new Error('Proposal checks failed or source changed. Review and propose again.');
  const proposal = await readJson(join(roadmapDir(root, roadmapId), `${sliceId}.proposal.json`));
  const lastPass = [...state.events].reverse().find((event) => event.type === 'checks-passed' && event.slice === sliceId);
  if (!lastPass) throw new Error('Passing check evidence is missing.');
  const worktree = worktreeAt(root, roadmapId, sliceId);
  const target = join(worktree, '.blocks', 'manifests', `${sliceId}.json`);
  const worktreeManifest = await readJson(target);
  if (hash(JSON.stringify({ manifest: worktreeManifest, patches: await Promise.all((proposal.patches || []).map(async (patch) => ({ ...patch, content: await readFile(join(worktree, patch.path), 'utf8') }))) })) !== lastPass.result.appliedHash) throw new Error('Worktree changed after checks. Run check again.');
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
  return { roadmap, slices, events: ledger };
}
