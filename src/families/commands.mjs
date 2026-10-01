import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readProjectFile, writeProjectFiles } from '../project-files.mjs';
import { registeredViewOutputs } from '../view-exports.mjs';
import { applyGeneration, checkGeneration, planGeneration } from './generate.mjs';
import { HistoryError, historyPath, importHistory, readHistory, serializeHistory } from './history.mjs';

const configProblem = (message) => ({ rule: 'config-valid', code: 'family-path-invalid', severity: 'error', message, file: '.blocks/config.json', field: '$' });
const hasError = (diagnostics) => diagnostics.some((item) => item.severity === 'error');

async function readConfig(root) {
  let text;
  try { text = await readProjectFile(root, '.blocks/config.json'); }
  catch (error) { return { diagnostics: [configProblem(error.message)] }; }
  if (text === null) return { config: {}, diagnostics: [] };
  try { return { config: JSON.parse(text), diagnostics: [] }; }
  catch (error) { return { diagnostics: [configProblem(`Invalid .blocks/config.json: ${error.message}`)] }; }
}

/**
 * The graph the loader and custom generators work from. A caller that already scanned passes
 * it in; otherwise scan without writing config and attach the generic family registry.
 */
async function projectGraph(root, graph) {
  if (graph) return graph;
  const { scanRepository } = await import('../scanner.mjs');
  const scanned = await scanRepository(root, { writeConfig: false });
  const adapter = await import('../adapter.mjs');
  if (typeof adapter.attachProjectRegistry === 'function') await adapter.attachProjectRegistry(scanned);
  return scanned;
}

const graphPaths = (graph) => (graph.nodes ?? []).filter((node) => node.kind === 'file').map((node) => node.path).sort();

async function prepare(root, options) {
  const { config, diagnostics } = options.config ? { config: options.config, diagnostics: [] } : await readConfig(root);
  if (!config) return { diagnostics };
  const graph = await projectGraph(root, options.graph);
  return { config, graph, paths: options.paths ?? graphPaths(graph), diagnostics };
}

/**
 * `block-beaver gen`: write every generated output. With `check` nothing is written (not even
 * the cache) and drift is reported; with `dryRun` the plan is made but nothing is written.
 */
export async function generateProject(inputRoot, { check = false, label, dryRun = false, now, graph, paths, config, loadFamilies, extraOutputs } = {}) {
  const root = await realpath(resolve(inputRoot));
  const mode = check ? 'check' : dryRun ? 'dry-run' : 'write';
  const ready = await prepare(root, { config, graph, paths });
  if (!ready.config) return { ok: false, mode, outputs: [], written: [], pending: [], diagnostics: ready.diagnostics };
  const viewOutputs = extraOutputs ?? await registeredViewOutputs(root, ready.graph);
  const plan = await planGeneration({ root, config: ready.config, graph: ready.graph, paths: ready.paths, label: label ?? null, now, extraOutputs: viewOutputs, loadFamilies });
  const outputs = plan.outputs.map(({ key, out, status }) => ({ key, out, status }));
  const pending = plan.outputs.filter((item) => item.status === 'stale' || item.status === 'missing').map((item) => item.out);
  if (check) {
    const diagnostics = checkGeneration(plan);
    return { ok: !hasError(diagnostics), mode, outputs, written: [], pending, diagnostics };
  }
  if (dryRun) return { ok: !hasError(plan.diagnostics), mode, outputs, written: [], pending, diagnostics: plan.diagnostics };
  const applied = await applyGeneration(root, plan);
  if (!hasError(applied.diagnostics) && extraOutputs === undefined && viewOutputs.length) {
    // Registries add source files and history changes the view. Render exports
    // from the completed generation rather than its pre-generation snapshot.
    const { updateProject } = await import('../block-map.mjs');
    const refreshed = await updateProject(root);
    const finalViews = await registeredViewOutputs(root, refreshed.graph);
    const viewPlan = await planGeneration({ root, config: ready.config, graph: refreshed.graph, now,
      extraOutputs: finalViews, loadFamilies: async () => ({ families: [], manifests: [], generators: [], diagnostics: [] }) });
    // This view-only pass must not prune custom-generator cache entries.
    viewPlan.cacheUpdate = null;
    const final = await applyGeneration(root, viewPlan);
    applied.written = [...new Set([...applied.written, ...refreshed.changed, ...final.written])];
    applied.diagnostics = [...applied.diagnostics, ...final.diagnostics];
  }
  return { ok: !hasError(applied.diagnostics), mode, outputs, written: applied.written, pending: [], diagnostics: applied.diagnostics };
}

const importProblem = (message) => ({ rule: 'family-drift', code: 'import-invalid', severity: 'error', message });

async function readJson(file, what) {
  try { return { value: JSON.parse(await readFile(resolve(file), 'utf8')) }; }
  catch (error) { return { diagnostic: importProblem(`Cannot read ${what} ${file}: ${error.message}`) }; }
}

/**
 * `block-beaver history import <file> --map <map.json>`: convert a hand-built history. The
 * source and mapping paths are resolved from the working directory; the result is written
 * to `.blocks/history.json` only if replaying it reaches exactly the current blocks.
 */
export async function importProjectHistory(inputRoot, file, mappingFile, { dryRun = false, graph, paths, config, loadFamilies } = {}) {
  const root = await realpath(resolve(inputRoot));
  const fail = (diagnostics) => ({ ok: false, dryRun, entries: 0, written: [], diagnostics });
  const source = await readJson(file, 'history file');
  if (source.diagnostic) return fail([source.diagnostic]);
  const mapping = await readJson(mappingFile, 'mapping file');
  if (mapping.diagnostic) return fail([mapping.diagnostic]);
  const ready = await prepare(root, { config, graph, paths });
  if (!ready.config) return fail(ready.diagnostics);

  const load = loadFamilies ?? (await import('./loader.mjs')).loadFamilies;
  const loaded = await load({ root, config: ready.config, paths: ready.paths });
  if (hasError(loaded.diagnostics ?? [])) return fail(loaded.diagnostics);
  const current = new Map((loaded.manifests ?? []).map((item) => [item.ref, item.hash]));

  const text = await readProjectFile(root, historyPath);
  let existing;
  try { existing = readHistory(text); }
  catch (error) {
    if (error instanceof HistoryError) return fail([{ rule: 'family-drift', code: 'import-history-exists', severity: 'error', message: `${historyPath} is not a valid history: ${error.message}`, file: historyPath }]);
    throw error;
  }
  const result = importHistory(source.value, mapping.value, current, existing);
  if (!result.ok) return fail(result.diagnostics);
  const entries = result.doc.entries.length;
  if (dryRun) return { ok: true, dryRun, entries, written: [], diagnostics: [] };
  await writeProjectFiles(root, [{ path: historyPath, before: text, content: serializeHistory(result.doc) }]);
  return { ok: true, dryRun, entries, written: [historyPath], diagnostics: [] };
}
