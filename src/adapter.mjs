import { projectName } from './project-identity.mjs';
import { readHistory } from './families/history.mjs';
import { readProjectFile } from './project-files.mjs';
import { loadProjectModel } from './project-model.mjs';
import { attachFamilies } from './families/graph.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function attachAppMetadata(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const block of graph.nodes.filter((node) => node.kind === 'block')) {
    const implementation = graph.edges.filter((edge) => edge.from === block.id && edge.kind === 'implemented-by').map((edge) => nodes.get(edge.to)).filter(Boolean);
    const owners = [...new Set(implementation.map((file) => file.app ?? null))];
    block.app = owners.length === 1 ? owners[0] : null;
    block.usedBy = [...new Set(implementation.flatMap((file) => file.usedBy || []))].sort();
  }
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (from && to && from.app !== to.app) edge.crossApp = true;
  }
  for (const app of graph.apps || []) app.counts.blocks = graph.nodes.filter((node) => node.kind === 'block' && node.app === app.id).length;
}

function attachLocalDependencies(graph) {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const linked = new Set(graph.edges.map((edge) => `${edge.from}\0${edge.to}\0${edge.kind}`));
  for (const node of graph.nodes.filter((entry) => entry.kind === 'block' && entry.family === 'local')) {
    for (const dependency of Array.isArray(node.manifest.dependencies) ? node.manifest.dependencies : []) {
      const key = `${node.id}\0${dependency}\0depends-on`;
      if (ids.has(dependency) && !linked.has(key)) {
        graph.edges.push({ from: node.id, to: dependency, kind: 'depends-on', evidence: { file: node.path, line: 1, column: 1, text: dependency } });
        linked.add(key);
      }
    }
  }
  graph.summary.relationships = graph.edges.length;
  attachAppMetadata(graph);
}

export async function attachLocalRegistry(graph) {
  let names;
  try { names = await readdir(join(graph.root, '.blocks', 'manifests')); }
  catch { return graph; }
  const manifestHashes = [];
  for (const name of names.filter((name) => name.endsWith('.json')).sort()) {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(graph.root, '.blocks', 'manifests', name), 'utf8')); }
    catch { continue; }
    if (typeof manifest.id !== 'string' || !Array.isArray(manifest.files)) continue;
    manifestHashes.push([name, createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16)]);
    const id = `block:local:${manifest.id}`;
    graph.nodes.push({ id, kind: 'block', family: 'local', name: manifest.name || manifest.id, description: manifest.description, manifest, path: `.blocks/manifests/${name}` });
    for (const file of manifest.files) {
      if (graph.nodes.some((node) => node.id === `file:${file}`)) graph.edges.push({ from: id, to: `file:${file}`, kind: 'implemented-by', evidence: { file: `.blocks/manifests/${name}`, line: 1, column: 1, text: file } });
    }
  }
  attachLocalDependencies(graph);
  graph.summary.blocks = graph.nodes.filter((node) => node.kind === 'block').length;
  if (manifestHashes.length) graph.fingerprint = createHash('sha256').update(JSON.stringify([graph.fingerprint, manifestHashes])).digest('hex').slice(0, 16);
  return graph;
}

/** Attach repository-defined declarations; no domain registry is built in. */
export async function attachProjectRegistry(graph, { config: suppliedConfig, loadFamilies: suppliedLoader } = {}) {
  await attachLocalRegistry(graph);
  let config = suppliedConfig;
  if (config === undefined) {
    const configText = await readProjectFile(graph.root, '.blocks/config.json');
    try { config = configText === null ? null : JSON.parse(configText); } catch { return graph; }
  }
  graph.repoName = await projectName(graph.root);
  // Page text only; attached when set so graphs without it keep their bytes.
  const pageText = Object.fromEntries(['title', 'eyebrow', 'heading', 'intro'].filter((key) => typeof config?.view?.[key] === 'string').map((key) => [key, config.view[key]]));
  if (Object.keys(pageText).length) graph.view = pageText;
  if (config && ['families', 'generators', 'loader', 'history', 'checks'].some((key) => Object.hasOwn(config, key))) {
    const paths = Object.keys(graph.hashes || {});
    const project = await loadProjectModel(graph.root, { paths, writeConfig: false });
    const loadFamilies = suppliedLoader || (await import('./families/loader.mjs')).loadFamilies;
    const load = await loadFamilies({ root: graph.root, config, paths, resolutionSignature: project.resolutionSignature, fileHashes: graph.hashes });
    let history;
    const historyDiagnostics = [];
    try { history = readHistory(await readProjectFile(graph.root, '.blocks/history.json')); }
    catch (error) { historyDiagnostics.push({ rule: 'family-drift', code: 'history-invalid', severity: 'error', file: '.blocks/history.json', message: error.message }); }
    // map.bindings: a light text pass over scanned sources; skipped entirely when unset.
    const bindings = Array.isArray(config.map?.bindings) ? config.map.bindings : [];
    let sourceText = typeof graph.sourceText === 'function' ? graph.sourceText : undefined;
    if (bindings.length && !sourceText) {
      const texts = new Map();
      for (const path of paths) texts.set(path, await readProjectFile(graph.root, path));
      sourceText = (path) => texts.get(path) ?? null;
    }
    attachFamilies(graph, { load: { ...load, diagnostics: [...(load.diagnostics || []), ...historyDiagnostics] }, project, history, bindings, sourceText, groupBy: config.map?.groupBy });
    graph.adapter = 'families';
  }
  if (config?.map) {
    const { prepareMapStyle } = await import('./families/map-style.mjs');
    const style = await prepareMapStyle(graph.root, config);
    graph.mapStyle = style;
    if (config.map.railLimit !== undefined) style.railLimit = config.map.railLimit;
    graph.familyDiagnostics = [...(graph.familyDiagnostics || []), ...(style.diagnostics || [])];
  }
  return graph;
}
