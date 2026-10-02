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

/** Add validated family manifests to the existing project graph in place. */
export function attachFamilies(graph, { load, project, history }) {
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
  graph.families = families.map((family, floor) => ({ id: family.id, floor: family.floor ?? floor, title: family.map?.title ?? family.id, blurb: family.map?.blurb ?? '', linkKinds: sorted((family.links || []).map((link) => link.kind)), count: accepted.filter(({ item }) => item.family === family.id).length }));
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
    };
    graph.fingerprint = createHash('sha256').update(canonicalJson(content)).digest('hex').slice(0, 16);
  }
  return graph;
}
