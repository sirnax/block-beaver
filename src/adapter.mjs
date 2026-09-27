import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);

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
}

/** Delegate read-only developer queries to TeaCake's own kit. */
export async function runTeacakeKit(root, command, input = {}) {
  if (!['list_blocks', 'describe_family', 'validate_block', 'compose_blocks'].includes(command)) throw new Error('This adapter exposes only read-only TeaCake kit commands.');
  const { stdout } = await exec('pnpm', ['blocks:kit', command, JSON.stringify(input)], { cwd: root, timeout: 120_000, maxBuffer: 4_000_000 });
  return JSON.parse(stdout);
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

/** Recognize an existing block registry without making it a core dependency. */
export async function attachTeacakeRegistry(graph) {
  let manifests;
  try { manifests = JSON.parse(await readFile(join(graph.root, 'docs/blocks/index.json'), 'utf8')); }
  catch { return graph; }
  if (!Array.isArray(manifests) || !manifests.every((m) => m && typeof m.id === 'string' && typeof m.family === 'string')) return graph;
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const blockIds = new Set();
  for (const manifest of manifests) {
    const id = `block:${manifest.family}:${manifest.id}`;
    blockIds.add(id);
    graph.nodes.push({ id, kind: 'block', family: manifest.family, name: manifest.name, description: manifest.description, manifest, path: 'docs/blocks/index.json' });
    const module = manifest.implementation?.module;
    if (typeof module === 'string' && module.startsWith('@/')) {
      const base = `src/${module.slice(2)}`;
      const path = [...graph.nodes].find((node) => node.kind === 'file' && (node.path === base || node.path.startsWith(base + '.')))?.path;
      if (path && nodeIds.has(`file:${path}`)) graph.edges.push({ from: id, to: `file:${path}`, kind: 'implemented-by', evidence: { file: 'docs/blocks/index.json', line: 1, column: 1, text: `${manifest.family}:${manifest.id} → ${module}` } });
    }
  }
  try {
    const html = await readFile(join(graph.root, 'docs/blocks/block-map.html'), 'utf8');
    const raw = html.match(/<script type="application\/json" id="block-map-data">([\s\S]*?)<\/script>/)?.[1];
    if (raw) {
      const map = JSON.parse(raw);
      const mapLine = html.slice(0, html.indexOf('<script type="application/json" id="block-map-data">')).split('\n').length;
      for (const [from, to, kind] of map.links || []) {
        const source = `block:${from}`, target = `block:${to}`;
        if (blockIds.has(source) && blockIds.has(target)) graph.edges.push({ from: source, to: target, kind, evidence: { file: 'docs/blocks/block-map.html', line: mapLine, column: 1, text: `${from} ${kind} ${to}` } });
      }
      graph.history = map.history || [];
    }
  } catch { /* The manifest index alone is enough. */ }
  graph.summary.blocks = graph.nodes.filter((node) => node.kind === 'block').length;
  attachLocalDependencies(graph);
  graph.adapter = 'teacake';
  return graph;
}
