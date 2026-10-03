import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { jsTsReactPlugin } from './plugins/js-ts-react.mjs';
import { loadProjectModel } from './project-model.mjs';
import { readProjectFile } from './project-files.mjs';
import { gitFileSet, gitScope } from './git-file-set.mjs';

const ignored = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel', '.blocks', 'vendor']);
const fileHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const scanCaches = new Map();
const slash = (path) => path.split('\\').join('/');

/** A language plugin accepts paths, parses a file, emits declarations and evidenced links. */
export async function findSourceFiles(root, { maxFiles = 20000, plugins = [jsTsReactPlugin], gitCache, onExcluded } = {}) {
  const paths = [];
  const tracked = await gitFileSet(root, gitCache);
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name) && !entry.name.startsWith('.')) await walk(join(directory, entry.name));
      } else if (entry.isFile() && plugins.some((plugin) => plugin.accepts(entry.name))) {
        const path = slash(relative(root, join(directory, entry.name)));
        if (tracked && !tracked.has(path)) { onExcluded?.(path); continue; }
        paths.push(path);
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
  const registeredExports = new Set();
  const exportRegistry = await readProjectFile(root, '.blocks/view-exports.json') ?? await readProjectFile(root, '.blocks/view/exports.json');
  if (exportRegistry !== null) {
    let entries;
    try { entries = JSON.parse(exportRegistry); } catch { throw new Error('Invalid .blocks/view-exports.json: expected JSON array'); }
    if (!Array.isArray(entries)) throw new Error('Invalid .blocks/view-exports.json: expected array');
    for (const entry of entries) {
      if (entry?.format !== 'module' || typeof entry.path !== 'string' || entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid .blocks/view-exports.json: each module path must stay inside the repository');
      registeredExports.add(entry.path);
    }
  }
  for (const path of options.extraExports || []) registeredExports.add(path);
  // Files Block Beaver deliberately leaves out of the graph but projects may import: registered
  // view exports and gitignored files present on disk. Imports of them are not unresolved.
  const excludedKnown = new Set(registeredExports);
  // One Git listing per scan, shared with the surrounding command's scope when there is one.
  const gitCache = gitScope.getStore() ?? new Map();
  const discoveredPaths = (await findSourceFiles(root, { ...options, plugins, gitCache, onExcluded: (path) => excludedKnown.add(path) })).filter((path) => !registeredExports.has(path));
  const project = await loadProjectModel(root, { paths: discoveredPaths, writeConfig: options.writeConfig ?? true, strict: false, gitCache });
  const paths = discoveredPaths.filter((path) => !project.isIgnored(path));
  const previous = scanCaches.get(root);
  const signature = project.resolutionSignature;
  const reusable = signature && previous?.signature === signature && previous.plugins.length === plugins.length && previous.plugins.every((plugin, index) => plugin === plugins[index]);
  const resolutionReport = [];
  const changed = new Set();
  const fileSet = new Set(paths);
  const files = new Map();
  const texts = new Map();
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
    const hash = fileHash(text);
    texts.set(path, text);
    const cached = previous?.files.get(path);
    const same = cached?.hash === hash && cached.plugin === plugin;
    if (!same) changed.add(path);
    const source = same ? cached.source : plugin.parse(path, text);
    const declarations = same ? cached.declarations : plugin.declarations(source, path);
    files.set(path, { source, declarations, hash, plugin, packages: [], packageImports: [] });
    nodes.push({ id: `file:${path}`, kind: 'file', app: project.ownerByFile.get(path) ?? null, usedBy: [], generated: /^\s*(?:\/\/|\/\*)[^\n]*generated by block-beaver/i.test(text), name: posix.basename(path), path, lines: text.split(/\r?\n/).length, hash });
    for (const declaration of declarations) {
      const proof = plugin.evidence(path, source, declaration.node);
      nodes.push({ id: declaration.id, kind: declaration.kind, app: project.ownerByFile.get(path) ?? null, usedBy: [], name: declaration.name, path, exported: declaration.exported, evidence: proof });
      addEdge(`file:${path}`, declaration.id, 'declares', proof);
    }
  }
  const relink = new Set(reusable ? changed : paths);
  if (reusable) {
    for (const edge of previous.edges) {
      if (edge.to.startsWith('file:') && changed.has(edge.to.slice(5))) relink.add(edge.evidence.file);
      if (edge.to.startsWith('symbol:') && changed.has(edge.to.slice(7).split('#')[0])) relink.add(edge.evidence.file);
    }
    for (const edge of previous.edges) if (!relink.has(edge.evidence.file)) addEdge(edge.from, edge.to, edge.kind, edge.evidence);
    resolutionReport.push(...previous.resolutionReport.filter((report) => !relink.has(report.file)).map((report) => ({ ...report, category: report.category || 'module' })));
    for (const path of paths) if (!relink.has(path)) { files.get(path).packages = previous.files.get(path)?.packages || []; files.get(path).packageImports = previous.files.get(path)?.packageImports || []; }
  }
  const context = {
    excludedKnown,
    recordPackageImport: (path, record) => files.get(path).packageImports.push(record),
    shouldLink: (path) => relink.has(path),
    resolveImport(path, specifier, resolutionOptions) {
      const result = project.resolveImport(path, specifier, resolutionOptions);
      if (result.package) files.get(path).packages.push(result.package);
      return result;
    },
    reportUnresolved(path, specifier, proof, message, category = 'module') {
      resolutionReport.push({ app: project.ownerByFile.get(path) ?? null, file: path, line: proof.line, column: proof.column, specifier, message, category });
    },
  };
  for (const plugin of plugins) plugin.links(files, fileSet, addEdge, context);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const resolvedEdges = edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).map((edge) => {
    const fromApp = nodesById.get(edge.from).app;
    const toApp = nodesById.get(edge.to).app;
    return fromApp !== toApp ? { ...edge, crossApp: true } : edge;
  });
  const adjacency = new Map();
  for (const edge of resolvedEdges) {
    if (!['imports', 'reexports'].includes(edge.kind) || !edge.from.startsWith('file:') || !edge.to.startsWith('file:')) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const usedByFile = new Map(paths.map((path) => [path, new Set()]));
  for (const app of project.apps) {
    const visited = new Set();
    const pending = app.entries.filter((path) => fileSet.has(path)).map((path) => `file:${path}`);
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      usedByFile.get(id.slice(5))?.add(app.id);
      pending.push(...(adjacency.get(id) || []));
    }
  }
  for (const node of nodes) node.usedBy = [...usedByFile.get(node.path)].sort();
  const unreachableFiles = paths.filter((path) => usedByFile.get(path).size === 0);
  const unreachableSet = new Set(unreachableFiles);
  for (const [path, file] of files) {
    const app = project.apps.find((candidate) => candidate.id === project.ownerByFile.get(path));
    if (app) app.packages = [...new Set([...app.packages, ...file.packages])].sort();
  }
  const apps = project.apps.map((app) => {
    const owned = nodes.filter((node) => node.app === app.id);
    const unresolvedImports = resolutionReport.filter((report) => report.app === app.id).length;
    const missingAssets = resolutionReport.filter((report) => report.app === app.id && report.category === 'asset').length;
    const unreachable = owned.filter((node) => node.kind === 'file' && unreachableSet.has(node.path)).length;
    const tsconfigErrors = app.errors || [];
    return {
      id: app.id, root: app.root, ...(app.tsconfig ? { tsconfig: app.tsconfig } : {}), entries: app.entries, packages: app.packages,
      counts: { files: owned.filter((node) => node.kind === 'file').length, pieces: owned.filter((node) => node.kind !== 'file').length, blocks: 0, unreachable },
      health: { status: tsconfigErrors.length ? 'error' : unresolvedImports || unreachable ? 'warning' : 'healthy', unresolvedImports, missingAssets, unreachableFiles: unreachable, tsconfigErrors },
    };
  });
  scanCaches.delete(root);
  scanCaches.set(root, { signature, plugins, files, edges, resolutionReport });
  while (scanCaches.size > 4) scanCaches.delete(scanCaches.keys().next().value);
  if (options.strict && (project.diagnostics.length || resolutionReport.length)) {
    const details = [...project.diagnostics.map((item) => `${item.app || 'project'} ${item.field}: ${item.message}`),
      ...resolutionReport.map((item) => `${item.app || 'outside apps'} ${item.file}:${item.line}: ${item.message}`)];
    const error = new Error(`Strict scan failed (${details.length} problems):\n${details.join('\n')}`);
    error.diagnostics = project.diagnostics;
    error.resolutionReport = resolutionReport;
    throw error;
  }
  const hashes = Object.fromEntries([...files].map(([path, value]) => [path, value.hash]));
  const fingerprint = fileHash(JSON.stringify(hashes));
  const graph = { schemaVersion: 2, root, apps, resolutionReport, diagnostics: project.diagnostics, unreachableFiles, scannedAt: new Date().toISOString(), fingerprint, summary: { files: paths.length, pieces: nodes.length - paths.length, relationships: resolvedEdges.length, unresolvedImports: resolutionReport.length, missingAssets: resolutionReport.filter((report) => report.category === 'asset').length, unreachableFiles: unreachableFiles.length, tsconfigErrors: project.diagnostics.length }, nodes, edges: resolvedEdges, hashes };
  // Source text for later light passes (map.bindings). Non-enumerable: never serialized and
  // outside graphRevision, so graph.json bytes are unchanged.
  Object.defineProperty(graph, 'sourceText', { value: (path) => texts.get(path) ?? null, enumerable: false });
  Object.defineProperty(graph, 'excludedKnown', { value: excludedKnown, enumerable: false });
  // External package imports (#55): non-enumerable for the same reason.
  const packageImports = [...files].flatMap(([path, file]) => file.packageImports.map((record) => ({ file: path, ...record })));
  packageImports.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0));
  Object.defineProperty(graph, 'packageImports', { value: packageImports, enumerable: false });
  return graph;
}
