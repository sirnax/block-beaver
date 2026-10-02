import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { matchGlob } from './glob.mjs';
import { canonicalJson } from './canonical.mjs';
import { readHistory, historySnapshots } from './history.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (values) => [...new Set(values)].sort(compare);
const graphId = (ref) => `block:${ref}`;
const diagnostic = (code, message, extra = {}) => ({ rule: 'manifest-valid', code, severity: 'error', message, ...extra });

/** Expand configured field paths into concrete, typed block references. */
export function extractLinks(family, manifest) {
  const links = [], diagnostics = [];
  const block = `${manifest.family || family.id}:${manifest.id}`;
  for (const definition of family.links || []) {
    const allowed = typeof definition.to === 'string' ? [definition.to] : definition.to;
    const segments = definition.field.split('.');
    const fail = (field, message) => diagnostics.push(diagnostic('link-value-invalid', message, { family: family.id, block, field, link: definition.kind }));
    function walk(value, index, field) {
      if (value == null) return;
      if (index === segments.length) {
        if (typeof value !== 'string' || !value) { fail(field, 'A link must be a non-empty block reference string'); return; }
        const parts = value.split(':');
        let targetFamily, id;
        if (parts.length === 1 && allowed.length === 1) [targetFamily, id] = [allowed[0], value];
        else if (parts.length === 2 && allowed.includes(parts[0])) [targetFamily, id] = parts;
        else { fail(field, `Link '${value}' must name one of: ${allowed.join(', ')}`); return; }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) { fail(field, `Invalid block reference '${value}'`); return; }
        links.push({ field, target: graphId(`${targetFamily}:${id}`), kind: definition.kind });
        return;
      }
      const segment = segments[index], key = segment.replace(/\[\]$/, ''), array = segment.endsWith('[]');
      if (typeof value !== 'object' || Array.isArray(value)) { fail(field, 'A link field path must traverse an object'); return; }
      const next = Object.hasOwn(value, key) ? value[key] : undefined;
      const nextField = `${field}.${key}`;
      if (next == null) return;
      if (array) {
        if (!Array.isArray(next)) { fail(nextField, 'A [] link field must contain an array'); return; }
        next.forEach((entry, position) => walk(entry, index + 1, `${nextField}[${position}]`));
      } else walk(next, index + 1, nextField);
    }
    walk(manifest, 0, '$');
  }
  return { links, diagnostics };
}

const fixtureSegments = new Set(['fixtures', '__fixtures__', 'test', 'tests']);

/**
 * Find sibling manifest folders that have not been assigned a configured family.
 * Files matching a family's `exclude` or the project's `ignore` are skipped; strays in fixture or test folders warn.
 */
export function findUnclaimed(families, filePaths, { isIgnored = () => false } = {}) {
  const patterns = families.map((family) => family.manifests);
  // A family's exclude globs remove files from its manifest neighbourhood, so they are never strays.
  const excluded = families.flatMap((family) => (Array.isArray(family.exclude) ? family.exclude : []).filter((pattern) => typeof pattern === 'string' && pattern));
  const shapes = sorted(patterns.flatMap((pattern) => {
    const parts = pattern.split('/'), first = parts.findIndex((part) => /[*?{[]/.test(part));
    // No preceding static folder means there is no discovery neighbourhood.
    if (first < 1) return [];
    parts[first - 1] = '*';
    return [parts.join('/')];
  }));
  const folders = new Map();
  for (const file of [...filePaths].sort(compare)) {
    if (isIgnored(file) || patterns.some((pattern) => matchGlob(file, pattern)) || excluded.some((pattern) => matchGlob(file, pattern)) || !shapes.some((shape) => matchGlob(file, shape))) continue;
    const folder = posix.dirname(file);
    if (!folders.has(folder)) {
      const stray = folder.split('/').some((segment) => fixtureSegments.has(segment));
      folders.set(folder, { ...diagnostic('family-unclaimed', `Manifest folder '${folder}' belongs to no configured family`, { file: folder }), ...(stray ? { severity: 'warning' } : {}) });
    }
  }
  return [...folders.values()];
}

const identifier = /^[A-Za-z_$][\w$]*$/;
const blockId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const literal = (name) => name.replace(/\$/g, '\\$');

/**
 * Map parity data (0.6.0, schema 2, additive; only written when families are configured).
 *
 * `graph.codeReach`: `[{ app, folder, block, via, files }]`, sorted by app ('' for null),
 * folder, block, then via. A folder reaches a block when one of its files
 * - `via: 'import'`: imports or re-exports a file that the block is `implemented-by`
 *   (its implementation module or a declared `files` entry), or
 * - `via: 'binding'`: calls `call(registry.<id>, …)`, `call(registry['<id>'], …)` or
 *   `call(registry["<id>"], …)` for a configured `map.bindings` entry `{ family, call, registry }`
 *   and `block:<family>:<id>` exists.
 * `app` is the file's app id or null; `folder` is the file's directory relative to its app
 * root ('.' at the root), the same grouping key as the map's ordinary-code slabs; `files` are
 * sorted project-relative paths. Files inside the reached block's own boundary, family
 * manifests, contracts, generators and block-beaver generated files never count as reach.
 *
 * `graph.unused`: sorted block node ids with no incoming edge from a different block (typed
 * family links or local `depends-on`) and no `codeReach` entry. Outgoing links do not count:
 * a block that only depends on others but that nothing links to or reaches is unused.
 */
export function attachMapParity(graph, { bindings = [], sourceText } = {}) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const appRoots = new Map((graph.apps || []).map((app) => [app.id, app.root]));
  const boundaries = new Map();
  for (const edge of graph.edges) {
    if (edge.kind !== 'implemented-by' || nodes.get(edge.from)?.kind !== 'block' || !edge.to.startsWith('file:')) continue;
    if (!boundaries.has(edge.from)) boundaries.set(edge.from, new Set());
    boundaries.get(edge.from).add(edge.to);
  }
  const excluded = (file) => !file || file.kind !== 'file' || file.generated === true || ['manifest', 'contract', 'generator'].includes(file.familyRole);
  const reach = new Map();
  const add = (file, block, via) => {
    if (excluded(file) || boundaries.get(block)?.has(file.id)) return;
    const root = appRoots.get(file.app);
    const relative = root && root !== '.' && file.path.startsWith(`${root}/`) ? file.path.slice(root.length + 1) : file.path;
    const folder = relative.split('/').slice(0, -1).join('/') || '.';
    const app = file.app ?? null;
    const key = `${app ?? ''}\0${folder}\0${block}\0${via}`;
    if (!reach.has(key)) reach.set(key, { app, folder, block, via, files: new Set() });
    reach.get(key).files.add(file.path);
  };
  const implementers = new Map();
  for (const [block, files] of boundaries) for (const file of files) {
    if (!implementers.has(file)) implementers.set(file, []);
    implementers.get(file).push(block);
  }
  for (const edge of graph.edges) {
    if (!['imports', 'reexports'].includes(edge.kind) || !edge.from.startsWith('file:')) continue;
    for (const block of implementers.get(edge.to) || []) add(nodes.get(edge.from), block, 'import');
  }
  const valid = (Array.isArray(bindings) ? bindings : []).filter((entry) => entry && typeof entry.family === 'string' && identifier.test(entry.call ?? '') && identifier.test(entry.registry ?? ''));
  if (valid.length && typeof sourceText === 'function') {
    const patterns = valid.map((entry) => ({ family: entry.family, call: entry.call, pattern: new RegExp(`(?<![\\w$])${literal(entry.call)}\\s*\\(\\s*${literal(entry.registry)}\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*)|\\[\\s*(['"\`])([A-Za-z0-9][A-Za-z0-9._-]*)\\2\\s*\\])`, 'g') }));
    for (const file of graph.nodes.filter((node) => node.kind === 'file').sort((a, b) => compare(a.path, b.path))) {
      if (excluded(file)) continue;
      const text = sourceText(file.path);
      if (typeof text !== 'string') continue;
      for (const { family, call, pattern } of patterns) {
        if (!text.includes(call)) continue;
        for (const match of text.matchAll(pattern)) {
          const id = match[1] ?? match[3];
          const block = graphId(`${family}:${id}`);
          if (blockId.test(id) && nodes.get(block)?.kind === 'block') add(file, block, 'binding');
        }
      }
    }
  }
  graph.codeReach = [...reach.values()]
    .map((entry) => ({ ...entry, files: sorted(entry.files) }))
    .sort((a, b) => compare(a.app ?? '', b.app ?? '') || compare(a.folder, b.folder) || compare(a.block, b.block) || compare(a.via, b.via));
  const touched = new Set(graph.codeReach.map((entry) => entry.block));
  for (const edge of graph.edges) if (edge.from !== edge.to && nodes.get(edge.from)?.kind === 'block' && nodes.get(edge.to)?.kind === 'block') touched.add(edge.to);
  graph.unused = sorted(graph.nodes.filter((node) => node.kind === 'block' && !touched.has(node.id)).map((node) => node.id));
  return graph;
}

/** Add validated family manifests to the existing project graph in place. */
export function attachFamilies(graph, { load, project, history, bindings, sourceText }) {
  const families = load.families || [], manifests = load.manifests || [];
  const diagnostics = [...(load.diagnostics || [])];
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const fileNodes = new Map(graph.nodes.filter((node) => node.kind === 'file').map((node) => [node.path, node]));
  const familyConfigs = families.map((family) => family.config).filter((config) => typeof config?.manifests === 'string');
  diagnostics.push(...findUnclaimed(familyConfigs, sorted([...fileNodes.keys(), ...(load.discoveredFiles || [])]), { isIgnored: typeof project?.isIgnored === 'function' ? (path) => project.isIgnored(path) : undefined }));
  const familyById = new Map(families.map((family) => [family.id, family]));
  const accepted = [];
  for (const item of manifests) {
    const id = item.graphId || graphId(`${item.family}:${item.id}`);
    if (nodes.has(id)) { diagnostics.push(diagnostic('block-duplicate', `Duplicate block '${item.family}:${item.id}'`, { family: item.family, block: `${item.family}:${item.id}`, file: item.path })); continue; }
    const family = familyById.get(item.family);
    if (!family) continue; // The loader reports unknown family definitions.
    const node = { id, kind: 'block', family: item.family, floor: family.floor ?? families.indexOf(family), name: item.value.name, description: item.value.description, manifest: item.value, path: item.path, dependencies: [], app: null, usedBy: [] };
    graph.nodes.push(node); nodes.set(id, node); accepted.push({ item, node, family });
  }
  for (const family of families) {
    const node = fileNodes.get(family.config?.contract);
    if (node) node.familyRole = 'contract';
  }
  for (const generator of load.generators || []) {
    const node = fileNodes.get(generator.path);
    if (node) node.familyRole = 'generator';
  }
  for (const { item, node, family } of accepted) {
    const details = { file: item.path, family: item.family, block: `${item.family}:${item.id}` };
    const manifestNode = fileNodes.get(item.path);
    if (manifestNode) { manifestNode.familyRole = 'manifest'; manifestNode.owningBlock = node.id; }
    const boundary = new Set();
    if (item.value.implementation?.kind === 'module') {
      const specifier = item.value.implementation.module;
      let resolution;
      try { resolution = project.resolveImport(item.path, specifier, { mode: 'import' }); }
      catch (error) { resolution = { error: error.message }; }
      if (resolution?.external) diagnostics.push(diagnostic('implementation-external', `Implementation '${specifier}' is outside the project source graph`, { ...details, field: '$.implementation.module' }));
      else if (!resolution?.path || !fileNodes.has(resolution.path)) diagnostics.push(diagnostic('implementation-unresolved', resolution?.error || `Implementation '${specifier}' is not a graph file`, { ...details, field: '$.implementation.module' }));
      else boundary.add(resolution.path);
    }
    for (const [index, file] of (item.value.files || []).entries()) {
      if (fileNodes.has(file)) boundary.add(file);
      else diagnostics.push(diagnostic('file-missing', `Block file '${file}' is not a graph file`, { ...details, field: `$.files[${index}]` }));
    }
    for (const file of sorted(boundary)) graph.edges.push({ from: node.id, to: fileNodes.get(file).id, kind: 'implemented-by', evidence: { file: item.path, line: 1, column: 1, text: file } });
    const owned = [...boundary].map((file) => fileNodes.get(file));
    const owners = new Set(owned.map((file) => file.app ?? null));
    node.app = owners.size === 1 ? [...owners][0] : null;
    node.usedBy = sorted(owned.flatMap((file) => file.usedBy || []));
    const extracted = extractLinks(family, item.value);
    diagnostics.push(...extracted.diagnostics.map((entry) => ({ ...entry, file: item.path })));
    const edges = new Map();
    for (const link of extracted.links) {
      if (!nodes.has(link.target)) { diagnostics.push(diagnostic('link-target-missing', `Link target '${link.target.slice(6)}' does not exist`, { ...details, field: link.field, link: link.kind })); continue; }
      const key = `${link.target}\0${link.kind}`;
      if (!edges.has(key)) edges.set(key, { from: node.id, to: link.target, kind: link.kind, link: true, fields: [], evidence: { file: item.path, line: 1, column: 1, text: '' } });
      edges.get(key).fields.push(link.field);
    }
    for (const edge of edges.values()) {
      edge.fields = sorted(edge.fields);
      edge.evidence.text = `${edge.fields.join(', ')} → ${edge.to.slice(6)}`;
      graph.edges.push(edge);
    }
    node.dependencies = sorted([...edges.values()].map((edge) => edge.to));
  }
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (from && to && from.app !== to.app) edge.crossApp = true;
  }
  graph.families = families.map((family, position) => ({ id: family.id, floor: family.floor ?? position, title: family.map?.title ?? family.id, blurb: family.map?.blurb ?? '', linkKinds: sorted((family.links || []).map((link) => link.kind)), count: accepted.filter(({ item }) => item.family === family.id).length })).sort((a, b) => a.floor - b.floor); // map floor order; sort is stable
  graph.familyDiagnostics = diagnostics;
  if (history !== undefined) {
    try { graph.history = historySnapshots(readHistory(JSON.stringify(history))); }
    catch (error) {
      graph.history = [];
      diagnostics.push({ rule: 'family-drift', code: 'history-invalid', severity: 'error', message: error.message, file: '.blocks/history.json' });
    }
  }
  for (const app of graph.apps || []) app.counts.blocks = graph.nodes.filter((node) => node.kind === 'block' && node.app === app.id).length;
  graph.summary.blocks = graph.nodes.filter((node) => node.kind === 'block').length;
  graph.summary.relationships = graph.edges.length;
  // Map parity fields exist only for family projects, so other graphs keep their 0.5.1 bytes.
  const mapBindings = Array.isArray(bindings) ? bindings : [];
  if (families.length) attachMapParity(graph, { bindings: mapBindings, sourceText });
  if (families.length || diagnostics.length) {
    // The loader cache key includes absolute resolver paths and process identity.
    // Persist only project-relative content so audit snapshots agree across checkouts.
    const loadedHashes = sorted(load.loadedFiles || []).map((path) => [path, load.fileHashes?.[path] ?? graph.hashes?.[path] ?? fileNodes.get(path)?.hash ?? null]);
    const content = {
      source: graph.fingerprint,
      families,
      manifests: manifests.map((item) => [item.family, item.id, item.path, item.hash]),
      generators: load.generators || [],
      loadedHashes,
      history: graph.history ?? null,
      diagnostics,
      // Bindings change codeReach without changing a source or manifest hash.
      ...(mapBindings.length ? { bindings: mapBindings } : {}),
    };
    graph.fingerprint = createHash('sha256').update(canonicalJson(content)).digest('hex').slice(0, 16);
  }
  return graph;
}
