import { createHash } from 'node:crypto';
import { captureManifestId } from './glob.mjs';
import { readProjectFile, writeProjectFiles } from '../project-files.mjs';

export class KitError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

export function renderScaffold(family, id, input = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id || '')) throw new KitError('manifest-id-mismatch', 'Invalid block id');
  if (typeof input.rationale !== 'string' || !input.rationale.trim()) throw new KitError('manifest-schema', 'A non-empty rationale is required', { field: '$.rationale' });
  if (!family.scaffold?.files?.length) throw new KitError('contract-invalid', `Family '${family.id}' has no scaffold`);
  const words = id.split(/[._-]+/).filter(Boolean);
  const pascalId = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  const name = input.name ?? id, description = input.description ?? name;
  if (typeof name !== 'string' || typeof description !== 'string') throw new KitError('manifest-schema', 'Name and description must be strings');
  const tokens = { id, family: family.id, camelId: pascalId[0].toLowerCase() + pascalId.slice(1), pascalId, name, description, rationale: input.rationale };
  const render = (template) => template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, key) => {
    const json = key.startsWith('json.'), token = json ? key.slice(5) : key;
    if (!Object.hasOwn(tokens, token)) throw new KitError('scaffold-token-unknown', `Unknown scaffold token '${key}'`);
    return json ? JSON.stringify(tokens[token]) : tokens[token];
  });
  const files = family.scaffold.files.map(({ path, template }) => ({ path: render(path), content: render(template), before: null }));
  const paths = new Set();
  for (const file of files) {
    if (file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some((part) => !part || part === '.' || part === '..') || file.path.startsWith('.blocks/')) throw new KitError('output-unsafe', `Unsafe scaffold path '${file.path}'`);
    if (paths.has(file.path)) throw new KitError('output-collision', `Scaffold claims '${file.path}' more than once`);
    paths.add(file.path);
  }
  const matching = files.filter((file) => captureManifestId(file.path, family.config.manifests) !== undefined);
  if (matching.length !== 1 || captureManifestId(matching[0].path, family.config.manifests) !== id) throw new KitError('manifest-id-mismatch', 'Scaffold must produce exactly one manifest matching its family glob and block id');
  return { files, manifestPath: matching[0].path, manualSteps: (family.scaffold.manualSteps || []).map(render) };
}

export async function planScaffold(root, family, id, input) {
  const plan = renderScaffold(family, id, input);
  const existing = [];
  for (const file of plan.files) {
    try { if (await readProjectFile(root, file.path) !== null) existing.push(file.path); }
    catch (error) { throw new KitError('output-unsafe', error.message, { path: file.path }); }
  }
  // An output must not also be another output's parent directory.
  for (const file of plan.files) if (plan.files.some((other) => other.path.startsWith(`${file.path}/`))) throw new KitError('output-collision', `Scaffold file '${file.path}' is also a parent directory`);
  if (existing.length) throw new KitError('create-exists', 'Scaffold targets already exist', { paths: existing });
  return plan;
}

const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const unsafePath = (path) => typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..') || path.startsWith('.blocks/');

/** Simple line diff (LCS) in unified style, with 3 lines of context. */
export function unifiedDiff(path, before, after) {
  const a = before.split('\n'), b = after.split('\n');
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < a.length) ops.push(['-', a[i++]]);
  while (j < b.length) ops.push(['+', b[j++]]);
  const keep = ops.map(([kind], index) => kind !== ' ' || ops.slice(Math.max(0, index - 3), index + 4).some(([other]) => other !== ' '));
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  let gap = false;
  ops.forEach(([kind, text], index) => {
    if (!keep[index]) { gap = true; return; }
    if (gap) lines.push('@@'); gap = false;
    lines.push(kind + text);
  });
  return lines.join('\n');
}

/** Validate a plan returned by a contract's scaffold.plan; the manifest must be one of its created files. */
export async function planComputedScaffold(root, family, id, planned) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id || '')) throw new KitError('manifest-id-mismatch', 'Invalid block id');
  const files = (planned?.files || []).map((file) => ({ path: file.path, content: file.content, before: null }));
  const updates = planned?.updates || [];
  const paths = new Set();
  for (const file of [...files, ...updates]) {
    if (unsafePath(file.path)) throw new KitError('output-unsafe', `Unsafe scaffold path '${file.path}'`);
    if (paths.has(file.path)) throw new KitError('output-collision', `Scaffold claims '${file.path}' more than once`);
    paths.add(file.path);
  }
  for (const path of paths) if ([...paths].some((other) => other.startsWith(`${path}/`))) throw new KitError('output-collision', `Scaffold file '${path}' is also a parent directory`);
  const matching = files.filter((file) => captureManifestId(file.path, family.config.manifests) !== undefined);
  if (matching.length !== 1 || captureManifestId(matching[0].path, family.config.manifests) !== id) throw new KitError('manifest-id-mismatch', 'Scaffold must create exactly one manifest matching its family glob and block id');
  const existing = [];
  for (const file of files) {
    try { if (await readProjectFile(root, file.path) !== null) existing.push(file.path); }
    catch (error) { throw new KitError('output-unsafe', error.message, { path: file.path }); }
  }
  if (existing.length) throw new KitError('create-exists', 'Scaffold targets already exist', { paths: existing });
  const planUpdates = [];
  for (const update of updates) {
    let current;
    try { current = await readProjectFile(root, update.path); }
    catch (error) { throw new KitError('output-unsafe', error.message, { path: update.path }); }
    if (current === null) throw new KitError('scaffold-update-missing', `Scaffold update target '${update.path}' does not exist`, { paths: [update.path] });
    if (sha256(current) !== update.before) throw new KitError('scaffold-stale', `'${update.path}' changed since the scaffold was planned`, { paths: [update.path] });
    planUpdates.push({ path: update.path, content: update.content, before: current, expected: update.before, diff: unifiedDiff(update.path, current, update.content) });
  }
  return { files, updates: planUpdates, manifestPath: matching[0].path, manualSteps: planned.manualSteps || [] };
}

/** All-or-nothing: returns the written paths and a rollback that restores updates and deletes creates. */
export async function applyScaffold(root, plan) {
  // Repeat the full preflight at apply time, then retain rollback preconditions.
  for (const file of plan.files) {
    if (await readProjectFile(root, file.path) !== null) throw new KitError('create-exists', `Scaffold target '${file.path}' now exists`, { paths: [file.path] });
  }
  for (const update of plan.updates || []) {
    if (await readProjectFile(root, update.path) !== update.before) throw new KitError('scaffold-stale', `'${update.path}' changed since the scaffold was planned`, { paths: [update.path] });
  }
  const done = [];
  const rollback = async () => {
    const rollbackErrors = [];
    for (const step of done.reverse()) {
      try { await writeProjectFiles(root, [{ path: step.path, before: step.content, content: step.before }]); }
      catch (error) { rollbackErrors.push({ path: step.path, message: error.message }); }
    }
    return rollbackErrors;
  };
  try {
    for (const update of plan.updates || []) {
      await writeProjectFiles(root, [{ path: update.path, before: update.before, content: update.content }]);
      done.push(update);
    }
    for (const file of plan.files) {
      await writeProjectFiles(root, [file]);
      done.push(file);
    }
    return { paths: [...plan.files, ...(plan.updates || [])].map((file) => file.path), rollback };
  } catch (error) {
    const rollbackErrors = await rollback();
    throw new KitError('output-unsafe', error.message, rollbackErrors.length ? { rollbackErrors } : undefined);
  }
}
