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

export async function applyScaffold(root, plan) {
  // Repeat the full preflight at apply time, then retain rollback preconditions.
  for (const file of plan.files) {
    if (await readProjectFile(root, file.path) !== null) throw new KitError('create-exists', `Scaffold target '${file.path}' now exists`, { paths: [file.path] });
  }
  const written = [];
  try {
    for (const file of plan.files) {
      await writeProjectFiles(root, [file]);
      written.push(file);
    }
    return written.map((file) => file.path);
  } catch (error) {
    const rollbackErrors = [];
    for (const file of written.reverse()) {
      try { await writeProjectFiles(root, [{ path: file.path, before: file.content, content: null }]); }
      catch (rollbackError) { rollbackErrors.push({ path: file.path, message: rollbackError.message }); }
    }
    throw new KitError('output-unsafe', error.message, rollbackErrors.length ? { rollbackErrors } : undefined);
  }
}
