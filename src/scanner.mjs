import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { jsTsReactPlugin } from './plugins/js-ts-react.mjs';

const ignored = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel', '.blocks', 'vendor']);
const fileHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const slash = (path) => path.split('\\').join('/');

/** A language plugin accepts paths, parses a file, emits declarations and evidenced links. */
export async function findSourceFiles(root, { maxFiles = 20000, plugins = [jsTsReactPlugin] } = {}) {
  const paths = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name) && !entry.name.startsWith('.')) await walk(join(directory, entry.name));
      } else if (entry.isFile() && plugins.some((plugin) => plugin.accepts(entry.name))) {
        paths.push(slash(relative(root, join(directory, entry.name))));
        if (paths.length > maxFiles) throw new Error(`Source limit exceeded (${maxFiles} files)`);
      }
    }
  }
  await walk(root);
  return paths;
}

export async function scanRepository(inputRoot, options = {}) {
  const root = resolve(inputRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('Repository path must be a directory');
  const plugins = options.plugins || [jsTsReactPlugin];
  const paths = await findSourceFiles(root, { ...options, plugins });
  const fileSet = new Set(paths);
  const files = new Map();
  const nodes = [];
  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (from, to, kind, proof) => {
    const key = `${from}|${to}|${kind}|${proof.file}:${proof.line}:${proof.column}`;
    if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push({ from, to, kind, evidence: proof }); }
  };

  for (const path of paths) {
    const plugin = plugins.find((candidate) => candidate.accepts(path));
    const text = await readFile(join(root, path), 'utf8');
    const source = plugin.parse(path, text);
    const declarations = plugin.declarations(source, path);
    const hash = fileHash(text);
    files.set(path, { source, declarations, hash, plugin });
    nodes.push({ id: `file:${path}`, kind: 'file', name: posix.basename(path), path, lines: text.split(/\r?\n/).length, hash });
    for (const declaration of declarations) {
      const proof = plugin.evidence(path, source, declaration.node);
      nodes.push({ id: declaration.id, kind: declaration.kind, name: declaration.name, path, exported: declaration.exported, evidence: proof });
      addEdge(`file:${path}`, declaration.id, 'declares', proof);
    }
  }
  for (const plugin of plugins) plugin.links(files, fileSet, addEdge);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const resolvedEdges = edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const hashes = Object.fromEntries([...files].map(([path, value]) => [path, value.hash]));
  const fingerprint = fileHash(JSON.stringify(hashes));
  return { schemaVersion: 1, root, scannedAt: new Date().toISOString(), fingerprint, summary: { files: paths.length, pieces: nodes.length - paths.length, relationships: resolvedEdges.length }, nodes, edges: resolvedEdges, hashes };
}
