import { cp, mkdtemp, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { coreManifestSchema, validateManifest, createRegistry, compose } from '../kernel/index.mjs';
import { extractLinks } from './graph.mjs';
import { registeredViewOutputs } from '../view-exports.mjs';
import { KitError, planScaffold, applyScaffold } from './scaffold.mjs';

const failure = (code, message, details) => ({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });
const success = (result) => ({ ok: true, result });
const errorDiagnostics = (diagnostics = []) => diagnostics.filter((item) => item.severity === 'error');

function validateLinks(family, manifest, manifests) {
  const extracted = extractLinks(family, manifest);
  const targets = new Set(manifests.map((item) => item.graphId || `block:${item.family}:${item.id}`));
  targets.add(`block:${manifest.family}:${manifest.id}`);
  return [...extracted.diagnostics, ...extracted.links.filter((link) => !targets.has(link.target)).map((link) => ({ path: link.field, field: link.field, code: 'link-target-missing', message: `Link target '${link.target.slice(6)}' does not exist` }))].map((issue) => ({ path: issue.path || issue.field || '$', code: issue.code, message: issue.message }));
}

async function withScaffoldSnapshot(root, scaffold, action) {
  const container = await mkdtemp(join(tmpdir(), 'block-beaver-kit-'));
  const snapshot = join(container, basename(resolve(root)));
  try {
    await cp(root, snapshot, { recursive: true, dereference: false, filter: (source) => {
      const path = relative(root, source).replaceAll('\\', '/');
      return !['.git', 'node_modules', '.blocks/worktrees'].some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
    } });
    try {
      await lstat(join(root, 'node_modules'));
      await symlink(resolve(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await applyScaffold(snapshot, scaffold);
    return await action(snapshot);
  } finally { await rm(container, { recursive: true, force: true }); }
}

async function creationContext(root, config, loader, scaffold, family, id, paths) {
  const graph = await (await import('../scanner.mjs')).scanRepository(root, { writeConfig: false });
  const generationPaths = [...new Set([...paths, ...Object.keys(graph.hashes || {}), ...scaffold.files.map((file) => file.path)])];
  const project = await (await import('../project-model.mjs')).loadProjectModel(root, { paths: generationPaths, writeConfig: false });
  const load = await loader({ root, config, paths: generationPaths, resolutionSignature: project.resolutionSignature, fileHashes: graph.hashes });
  const issues = errorDiagnostics(load.diagnostics);
  const created = load.manifests.find((item) => item.family === family.id && item.id === id && item.path === scaffold.manifestPath);
  if (!created || issues.length) throw new KitError('manifest-schema', 'Scaffold validation failed', { diagnostics: issues });
  await (await import('../adapter.mjs')).attachProjectRegistry(graph, { config, loadFamilies: async () => load });
  const graphIssues = errorDiagnostics(graph.familyDiagnostics);
  if (graphIssues.length) throw new KitError('manifest-schema', 'Scaffold graph validation failed', { diagnostics: graphIssues });
  return { graph, paths: generationPaths, load };
}

/** JSON-only public kit dispatcher. The CLI owns parsing and stdout. */
export async function runKit(root, command, args = [], options = {}) {
  const { input = {}, dryRun = false } = options;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new KitError('kit-input-invalid', 'Kit input must be a JSON object');
    if (!['list', 'describe', 'validate', 'compose', 'create'].includes(command)) throw new KitError('kit-command-invalid', `Unknown kit command '${command}'`);
    let config = options.config;
    if (!config) {
      try { config = JSON.parse(await readFile(join(root, '.blocks/config.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') config = { schemaVersion: 1, families: [] }; else throw error; }
    }
    const loader = options.loadFamilies || (await import('./loader.mjs')).loadFamilies;
    let graph = options.graph;
    if ((!options.paths || !graph) && !options.loadFamilies) graph = await (await import('../scanner.mjs')).scanRepository(root, { writeConfig: false });
    const paths = options.paths || Object.keys(graph?.hashes || {});
    const loadOptions = { root, config, paths, resolutionSignature: options.resolutionSignature, fileHashes: options.fileHashes || graph?.hashes };
    const load = await loader(loadOptions);
    const diagnostics = errorDiagnostics(load.diagnostics);
    if (diagnostics.length) return failure(diagnostics[0].code, diagnostics[0].message, { diagnostics });
    const families = load.families || [], manifests = load.manifests || [];
    const getFamily = (id) => {
      const family = families.find((item) => item.id === id);
      if (!family) throw new KitError('family-unknown', `Unknown family '${id}'`);
      return family;
    };
    if (command === 'list') {
      if (input.family !== undefined) getFamily(input.family);
      const visible = input.family ? families.filter((item) => item.id === input.family) : families;
      return success({ families: visible.map((family, floor) => ({ id: family.id, floor: family.floor ?? floor, count: manifests.filter((item) => item.family === family.id).length })), blocks: manifests.filter((item) => !input.family || item.family === input.family).map((item) => ({ ref: item.ref || `${item.family}:${item.id}`, graphId: item.graphId || `block:${item.family}:${item.id}`, family: item.family, name: item.value.name })) });
    }
    if (command === 'describe') {
      const family = getFamily(args[0]);
      return success({ kernelSchemaVersion: 1, id: family.id, fields: family.fields, core: coreManifestSchema, implementation: family.implementation, links: family.links || [], generators: family.generators || [], map: family.map || {}, scaffold: { files: (family.scaffold?.files || []).map((file) => file.path), manualSteps: family.scaffold?.manualSteps || [] } });
    }
    if (command === 'validate') {
      const family = getFamily(input.family || input.manifest?.family);
      const mode = input.mode ?? 'build';
      if (!['build', 'runtime'].includes(mode)) throw new KitError('kit-input-invalid', 'Mode must be build or runtime');
      const result = validateManifest(input.manifest, { family, mode });
      if (mode === 'build' && result.valid) {
        const errors = validateLinks(family, input.manifest, manifests);
        if (errors.length) return success({ valid: false, errors });
      }
      // JSON cannot represent undefined; invalid results omit value on the wire.
      return success(result);
    }
    if (command === 'compose') {
      const family = getFamily(input.family);
      if (!Array.isArray(input.dynamic)) throw new KitError('kit-input-invalid', 'Dynamic manifests must be an array');
      const base = createRegistry(family.id, manifests.filter((item) => item.family === family.id).map((item) => item.value));
      const registry = compose(base, input.dynamic, { family });
      return success({ family: family.id, ids: registry.all.map((item) => item.id), dynamic: input.dynamic });
    }
    const family = getFamily(args[0]), id = args[1];
    if (manifests.some((item) => item.family === family.id && item.id === id)) throw new KitError('create-exists', `Block '${family.id}:${id}' already exists`, { paths: manifests.filter((item) => item.family === family.id && item.id === id).map((item) => item.path) });
    const scaffold = await planScaffold(root, family, id, input);
    const result = { written: scaffold.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content) })), manualSteps: scaffold.manualSteps, gen: { written: [], diagnostics: [] } };
    const planCreation = async (creationRoot) => {
      const context = await creationContext(creationRoot, config, loader, scaffold, family, id, paths);
      const planGeneration = options.planGeneration || (await import('./generate.mjs')).planGeneration;
      const extraOutputs = await registeredViewOutputs(creationRoot, context.graph);
      const plan = await planGeneration({ root: creationRoot, config, graph: context.graph, paths: context.paths, label: options.label ?? null, loadFamilies: loader, extraOutputs });
      if (errorDiagnostics(plan.diagnostics).length) throw new KitError('generator-failed', 'Generation planning failed', { diagnostics: plan.diagnostics });
      return { plan, context, extraOutputs };
    };
    const executeGeneration = async (creationRoot) => {
      const { plan, context, extraOutputs } = await planCreation(creationRoot);
      const applyGeneration = options.applyGeneration || (await import('./generate.mjs')).applyGeneration;
      const gen = await applyGeneration(creationRoot, plan);
      result.gen = gen;
      if (errorDiagnostics(gen.diagnostics).length) throw new KitError('generator-failed', 'Generation failed', { diagnostics: gen.diagnostics });
      const files = new Map((plan.outputs || []).filter((output) => ['missing', 'stale'].includes(output.status)).map((output) => [output.out, output.expected]));
      if (plan.cacheUpdate && plan.cacheUpdate.before !== plan.cacheUpdate.content) files.set(plan.cacheUpdate.path, plan.cacheUpdate.content);
      if (!options.planGeneration && extraOutputs.length) {
        const refreshed = await creationContext(creationRoot, config, loader, scaffold, family, id, context.paths);
        const planGeneration = (await import('./generate.mjs')).planGeneration;
        const viewPlan = await planGeneration({ root: creationRoot, config, graph: refreshed.graph, extraOutputs: await registeredViewOutputs(creationRoot, refreshed.graph), loadFamilies: async () => ({ families: [], manifests: [], generators: [], diagnostics: [] }) });
        viewPlan.cacheUpdate = null;
        const appliedViews = await applyGeneration(creationRoot, viewPlan);
        gen.written = [...new Set([...gen.written, ...appliedViews.written])];
        gen.diagnostics.push(...appliedViews.diagnostics);
        if (errorDiagnostics(gen.diagnostics).length) throw new KitError('generator-failed', 'View generation failed', { diagnostics: gen.diagnostics });
        for (const output of viewPlan.outputs.filter((output) => ['missing', 'stale'].includes(output.status))) files.set(output.out, output.expected);
      }
      result.written = [...scaffold.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content) })), ...[...files].map(([path, content]) => ({ path, bytes: Buffer.byteLength(content) }))];
      const reloaded = await loader({ ...loadOptions, root: creationRoot, paths: context.paths, fileHashes: context.graph.hashes });
      const issues = errorDiagnostics(reloaded.diagnostics);
      const created = reloaded.manifests.find((item) => item.family === family.id && item.id === id && item.path === scaffold.manifestPath);
      if (!created || issues.length) throw new KitError('manifest-schema', 'Reloading validation failed', { diagnostics: issues });
      return result;
    };
    if (dryRun) return success(await withScaffoldSnapshot(root, scaffold, executeGeneration));
    await applyScaffold(root, scaffold);
    try { return success(await executeGeneration(root)); }
    catch (error) {
      return failure(error.code || 'generator-failed', 'Scaffold files were created, but generation or reloading failed: ' + error.message, { ...result, ...(error.details === undefined ? {} : { cause: error.details }) });
    }
  } catch (error) {
    return failure(error.code || 'kit-failed', error.message, error.details);
  }
}
