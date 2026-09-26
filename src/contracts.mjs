import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import ts from 'typescript';

export const idPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Independent Block Beaver contract. Existing registries are checked by their own adapter. */
export function validateBlock(manifest, graph, { existing = [], createdPaths = [] } = {}) {
  const errors = [];
  const issue = (path, message) => errors.push({ path, message });
  if (!isObject(manifest)) return { valid: false, errors: [{ path: '$', message: 'Manifest must be an object.' }] };
  if (!idPattern.test(manifest.id || '')) issue('$.id', 'Use a kebab-case ID starting with a letter.');
  if (typeof manifest.version !== 'number' || !Number.isInteger(manifest.version) || manifest.version < 1) issue('$.version', 'Version must be a positive integer.');
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) issue('$.name', 'Name is required.');
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) issue('$.description', 'Description is required.');
  if (typeof manifest.rationale !== 'string' || !manifest.rationale.trim()) issue('$.rationale', 'Explain why this feature is one block.');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) issue('$.files', 'Choose at least one implementation file.');
  else {
    const paths = new Set([...(graph?.nodes.filter((node) => node.kind === 'file').map((node) => node.path) || []), ...createdPaths]);
    for (const [index, path] of manifest.files.entries()) if (typeof path !== 'string' || !paths.has(path)) issue(`$.files[${index}]`, createdPaths.length ? `File is neither scanned nor created by this proposal: ${path}` : `File is not in the scanned graph: ${path}`);
  }
  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies)) issue('$.dependencies', 'Dependencies must be an array.');
    else for (const [index, id] of manifest.dependencies.entries()) if (typeof id !== 'string' || !graph?.nodes.some((node) => node.id === id && node.kind === 'block')) issue(`$.dependencies[${index}]`, 'Dependency must reference a declared block ID in the scan.');
  }
  if (manifest.verification !== undefined && (!Array.isArray(manifest.verification) || !manifest.verification.every((x) => typeof x === 'string'))) issue('$.verification', 'Verification must be a list of commands.');
  const declared = graph?.nodes.find((node) => node.kind === 'block' && node.manifest?.id === manifest.id);
  if ((declared && (declared.family !== 'local' || manifest.version <= declared.manifest.version)) || existing.some((m) => m.id === manifest.id && m !== manifest)) issue('$.id', 'This ID exists; local block updates need a higher version. Existing product registries stay authoritative.');
  return { valid: errors.length === 0, errors };
}

const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const sourceKind = (path) => path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.jsx') ? ts.ScriptKind.JSX : ['.js', '.mjs', '.cjs'].includes(extname(path)) ? ts.ScriptKind.JS : ts.ScriptKind.TS;

/** Check patch shape, scope, hashes, parse errors and created manifest-file coverage. */
export function validateProposalPatches(proposal, graph, { scope = [], createScope = [] } = {}) {
  const errors = [];
  const patches = proposal?.patches === undefined ? [] : proposal.patches;
  if (!Array.isArray(patches)) return { valid: false, errors: [{ path: '$.patches', message: 'Patches must be an array.' }], createdPaths: [] };
  const seen = new Set();
  const createdPaths = [];
  let createdBytes = 0;
  for (const [index, patch] of patches.entries()) {
    const location = `$.patches[${index}]`;
    if (!isObject(patch) || typeof patch.path !== 'string' || typeof patch.content !== 'string') {
      errors.push({ path: location, message: 'Patch needs a path and complete string content.' });
      continue;
    }
    const { path, content } = patch;
    if (seen.has(path)) errors.push({ path: `${location}.path`, message: `Duplicate patch path: ${path}` });
    seen.add(path);
    if (patch.op === 'create') {
      if (!createScope.includes(path)) errors.push({ path: `${location}.path`, message: `Create patch exceeds creation scope: ${path}` });
      if (patch.baseHash !== undefined) errors.push({ path: `${location}.baseHash`, message: 'Create patch must not claim an existing source hash.' });
      createdBytes += Buffer.byteLength(content);
      if (createdBytes > 2_000_000) errors.push({ path: `${location}.content`, message: 'Create patches exceed the 2 MB content limit.' });
      if (createScope.includes(path)) createdPaths.push(path);
    } else if (patch.op === undefined) {
      if (!scope.includes(path)) errors.push({ path: `${location}.path`, message: `Replacement patch exceeds existing scope: ${path}` });
      if (!Object.hasOwn(graph.hashes, path) || graph.hashes[path] !== patch.baseHash) errors.push({ path: `${location}.baseHash`, message: `Patch hash does not match: ${path}` });
    } else {
      errors.push({ path: `${location}.op`, message: `Unsupported patch operation: ${patch.op}` });
      continue;
    }
    const extension = extname(path);
    if (extension === '.json') {
      try { JSON.parse(content); } catch (error) { errors.push({ path: `${location}.content`, message: `Invalid JSON in ${path}: ${error.message}` }); }
    } else if (sourceExtensions.has(extension)) {
      const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, sourceKind(path));
      for (const diagnostic of source.parseDiagnostics) errors.push({ path: `${location}.content`, message: `${path}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}` });
    } else errors.push({ path: `${location}.path`, message: `Unsupported patch file type: ${path}` });
  }
  for (const [index, path] of (Array.isArray(proposal?.manifest?.files) ? proposal.manifest.files : []).entries()) {
    if (createScope.includes(path) && !createdPaths.includes(path)) errors.push({ path: `$.manifest.files[${index}]`, message: `Created implementation file requires a create patch: ${path}` });
  }
  return { valid: errors.length === 0, errors, createdPaths };
}

export function suggestBoundaries(graph, { limit = 20 } = {}) {
  const files = graph.nodes.filter((node) => node.kind === 'file');
  const byFolder = new Map();
  for (const file of files) {
    const folder = file.path.split('/').slice(0, -1).join('/') || '.';
    const current = byFolder.get(folder) || [];
    current.push(file.path);
    byFolder.set(folder, current);
  }
  const result = [];
  for (const [folder, paths] of byFolder) {
    if (paths.length < 2) continue;
    const ids = new Set(paths.map((path) => `file:${path}`));
    const internal = graph.edges.filter((edge) => edge.kind === 'imports' && ids.has(edge.from) && ids.has(edge.to)).length;
    const external = graph.edges.filter((edge) => edge.kind === 'imports' && ids.has(edge.from) && !ids.has(edge.to)).length;
    const score = internal * 2 + paths.length - external * 0.2;
    result.push({ folder, files: paths, score: Number(score.toFixed(1)), internal, external, reason: `${paths.length} files, ${internal} internal imports, ${external} outward imports` });
  }
  return result.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function makeProposal({ id, name, description, rationale, files, dependencies = [], verification = [], patches = [] }, graph) {
  const manifest = { schemaVersion: 1, id, version: 1, name, description, rationale, files, dependencies, verification };
  const check = validateBlock(manifest, graph);
  return { manifest, patches, check, fingerprint: graph.fingerprint, proposedAt: new Date().toISOString() };
}

export function connectionProposal(graph, blockId, dependencyId) {
  const block = graph.nodes.find((node) => node.id === blockId && node.kind === 'block' && node.family === 'local');
  const dependency = graph.nodes.find((node) => node.id === dependencyId && node.kind === 'block');
  if (!block || !dependency || block.id === dependency.id) throw new Error('Choose a local block and a different declared block.');
  const before = block.manifest;
  const dependencies = [...new Set([...(before.dependencies || []), dependency.id])];
  const after = { ...before, version: before.version + 1, dependencies };
  return { before, manifest: after, patches: [], check: validateBlock(after, graph), fingerprint: graph.fingerprint, proposedAt: new Date().toISOString() };
}

export function hashProposal(proposal) { return createHash('sha256').update(JSON.stringify(proposal)).digest('hex').slice(0, 12); }
