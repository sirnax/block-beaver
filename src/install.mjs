import { readFile, readdir, lstat, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readProjectFile, writeProjectFiles } from './project-files.mjs';
import { detectProjectApps } from './project-model.mjs';
import { findSourceFiles, scanRepository } from './scanner.mjs';
import { attachProjectRegistry } from './adapter.mjs';
import { graphRevision, renderBlockMap } from './block-map.mjs';
import { planManagedFiles } from './managed-files.mjs';
import { planHostSetup } from './install-host.mjs';
import { preflightHostHooks, applyHostHooks, preflightProjectModes, applyProjectModes } from './host-hooks.mjs';
import { detectPackageManager, planPackageChange, runPackageChange } from './package-manager.mjs';
import { migrateDocument } from './migrations.mjs';
import { auditCounts } from './audit-rules.mjs';
import { recordManagedSetup } from './compliance.mjs';
import { gitHead } from './compliance-git.mjs';
import { BASELINE_PATH, baselineSummary, parseBaseline, planBaselineLowering } from './baseline.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const packageManagerFiles = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const agentTargets = { claude: ['CLAUDE.md', '.claude'], codex: ['AGENTS.md', '.codex', '.agents'], cursor: ['.cursor'], copilot: ['.github/copilot-instructions.md'] };

async function document(root, path) {
  const before = await readProjectFile(root, path);
  return { before, value: before === null ? null : JSON.parse(before) };
}

async function agentsFor(root, explicit, installed) {
  if (explicit !== undefined) {
    const agents = (Array.isArray(explicit) ? explicit : String(explicit).split(',')).map((id) => id === 'agents' ? 'codex' : id.trim());
    if (agents.some((id) => !Object.hasOwn(agentTargets, id))) throw new Error('Agents must be claude, codex, cursor, or copilot.');
    return [...new Set(agents)].sort();
  }
  if (installed?.agents) return agentsFor(root, installed.agents);
  const agents = [];
  for (const [id, targets] of Object.entries(agentTargets)) {
    for (const target of targets) {
      try { await lstat(join(root, target)); agents.push(id); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return agents.sort();
}

async function dataFiles(root, path = '.blocks', { migrationOnly = false, directories } = {}) {
  let entries;
  try { entries = await readdir(join(root, path), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const paths = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${path}/${entry.name}`;
    if (migrationOnly && (relative === '.blocks/worktrees' || relative === '.blocks/cache' || (path === '.blocks/view' && relative !== '.blocks/view/graph.json'))) continue;
    if (entry.isSymbolicLink()) throw new Error(`Integration path is a symlink: ${relative}`);
    if (entry.isDirectory()) {
      directories?.add(relative);
      paths.push(...await dataFiles(root, relative, { migrationOnly, directories }));
    }
    else paths.push(relative);
  }
  return paths;
}

async function migrations(root) {
  const files = [];
  const legacyExports = await readProjectFile(root, '.blocks/view/exports.json');
  if (legacyExports !== null) {
    const entries = JSON.parse(legacyExports);
    if (!Array.isArray(entries)) throw new Error('Invalid legacy view export registry; expected an array.');
    const currentExports = await readProjectFile(root, '.blocks/view-exports.json');
    if (currentExports !== null && JSON.stringify(JSON.parse(currentExports)) !== JSON.stringify(entries)) throw new Error('Conflicting legacy and current view export registries; preserve both and reconcile them before upgrade.');
    files.push({ path: '.blocks/view-exports.json', before: currentExports, content: currentExports ?? legacyExports, kind: 'migration' });
    files.push({ path: '.blocks/view/exports.json', before: legacyExports, content: null, kind: 'migration' });
  }
  for (const path of await dataFiles(root, '.blocks', { migrationOnly: true })) {
    const kind = path === '.blocks/view/graph.json' ? 'graph'
      : /^\.blocks\/manifests\/[^/]+\.json$/.test(path) ? 'manifest'
        : /^\.blocks\/roadmaps\/[^/]+\/roadmap\.json$/.test(path) ? 'roadmap'
          : /^\.blocks\/(?:history\.json|history\/[^/]+\.json)$/.test(path) ? 'history'
            : path === '.blocks/index.json' ? 'index' : null;
    if (!kind) continue;
    const { before, value } = await document(root, path);
    const migrated = migrateDocument(kind, value);
    if (migrated.applied.length) files.push({ path, before, content: json(migrated.value), kind: 'migration' });
  }
  return files;
}

async function viewFiles(root) {
  const scanned = await attachProjectRegistry(await scanRepository(root, { writeConfig: false }));
  if (scanned.diagnostics?.length) throw new Error(scanned.diagnostics.map((item) => item.message).join('\n'));
  const graph = { ...scanned, root: '.', generator: 'block-beaver' };
  const saved = await document(root, '.blocks/view/graph.json');
  const htmlBefore = await readProjectFile(root, '.blocks/view/index.html');
  if (saved.before !== null && (!saved.value || saved.value.generator !== 'block-beaver')) throw new Error('Existing file conflicts with generated graph: .blocks/view/graph.json');
  if (htmlBefore !== null && !htmlBefore.startsWith('<!doctype html>\n<!-- block-beaver:view -->')) throw new Error('Existing file conflicts with generated view: .blocks/view/index.html');
  if (saved.value && graphRevision(saved.value) === graphRevision(graph)) graph.scannedAt = saved.value.scannedAt;
  return { graph, diagnostics: graph.familyDiagnostics ?? [], files: [
    { path: '.blocks/view/graph.json', before: saved.before, content: json(graph), kind: 'generated' },
    { path: '.blocks/view/index.html', before: htmlBefore, content: renderBlockMap(graph), kind: 'generated' },
  ] };
}

function combine(plans) {
  const files = new Map();
  for (const file of plans.flat()) {
    const previous = files.get(file.path);
    if (previous && previous.before !== file.before) throw new Error(`Inconsistent planned preimage: ${file.path}`);
    files.set(file.path, file);
  }
  return [...files.values()];
}

function enforcementSummary(config) {
  const { agents, gate, receipts = 'required' } = config.enforcement;
  const message = {
    required: 'Structural rules gate commits; review receipts are required. Set enforcement.receipts to "optional" in .blocks/config.json to make them advisory.',
    optional: 'Structural rules gate commits; review receipts are optional (advisory). Set enforcement.receipts to "required" in .blocks/config.json to require them.',
    off: 'Structural rules gate commits; review receipts are off. Set enforcement.receipts to "optional" or "required" in .blocks/config.json to use them.',
  };
  return { enforcement: { agents, gate, receipts }, gate: message[receipts] };
}

async function execute(root, operation, options) {
  const version = options.version ?? JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const marker = await document(root, '.blocks/install.json');
  if (marker.before !== null && (!marker.value || typeof marker.value !== 'object' || Array.isArray(marker.value) || marker.value.schemaVersion !== 1 || !Array.isArray(marker.value.agents) || !Array.isArray(marker.value.paths))) throw new Error('Unsupported or invalid install marker schema; latest supported schemaVersion is 1.');
  const agents = await agentsFor(root, options.agents, marker.value);
  const diagnostics = [];
  if (!agents.length) diagnostics.push('No agents detected. Use --agents claude,codex,cursor,copilot to install agent guidance.');
  const configFile = await document(root, '.blocks/config.json');
  let config = configFile.value;
  let detectionFile;
  if (operation !== 'uninstall') {
    if (configFile.before === null) {
      const detected = await detectProjectApps(root, { paths: await findSourceFiles(root), write: false });
      if (detected.diagnostics.length) throw new Error(detected.diagnostics.map((item) => item.message).join('\n'));
      config = detected.config;
      detectionFile = { path: '.blocks/detection.json', before: await readProjectFile(root, '.blocks/detection.json'), content: json({ schemaVersion: 1, apps: Object.fromEntries(detected.added.map((app) => [app.root, app])) }), kind: 'detection' };
    }
    config = migrateDocument('config', config).value;
    if (config.enforcement !== undefined && (!config.enforcement || typeof config.enforcement !== 'object' || Array.isArray(config.enforcement))) throw new Error('config enforcement must be an object.');
    if (config.enforcement?.agents !== undefined && !['guide', 'block'].includes(config.enforcement.agents)) throw new Error('config enforcement.agents must be guide or block.');
    if (config.enforcement?.gate !== undefined && config.enforcement.gate !== 'audit') throw new Error('config enforcement.gate must be audit.');
    if (config.enforcement?.receipts !== undefined && !['required', 'optional', 'off'].includes(config.enforcement.receipts)) throw new Error('config enforcement.receipts must be required, optional, or off.');
    // A new config or a fresh adoption starts with advisory receipts. An existing install, or an
    // upgrade of an existing config, keeps the stricter "required" default when the key is absent.
    const freshAdoption = configFile.before === null || (operation === 'install' && marker.before === null);
    config.blockBeaver = version;
    config.enforcement = { agents: 'guide', gate: 'audit', ...(freshAdoption ? { receipts: 'optional' } : {}), ...config.enforcement };
  }
  config ??= { schemaVersion: 1, apps: [] };
  const manager = options.manager ?? await detectPackageManager(root);
  const managed = await planManagedFiles({ root, version, config, agents, manager, operation, force: options.force ?? false });
  const host = await planHostSetup(root, { config, agents, version, operation, force: options.force ?? false, fixIgnores: options.fixIgnores ?? false, fixExcludes: options.fixExcludes ?? false });
  const conflicts = [...(managed.conflicts ?? []), ...(host.conflicts ?? [])];
  diagnostics.push(...(managed.diagnostics ?? []), ...(host.diagnostics ?? []));
  const packagePlan = await planPackageChange(root, { manager, version, operation: operation === 'upgrade' ? 'install' : operation });
  diagnostics.push(...(packagePlan.diagnostics ?? []));
  const extra = [];
  const dataDirectories = new Set(['.blocks']);
  let view, baselinePlan = null;
  if (operation !== 'uninstall') {
    extra.push({ path: '.blocks/config.json', before: configFile.before, content: json(config), kind: 'config' });
    if (detectionFile) extra.push(detectionFile);
    extra.push(...await migrations(root));
    view = await viewFiles(root);
    diagnostics.push(...view.diagnostics);
    conflicts.push(...view.diagnostics.filter((item) => item.severity !== 'warning').map((item) => ({ path: item.file ?? '.blocks/config.json', message: item.message, kind: 'family', code: item.code })));
    extra.push(...view.files);
    const baselineBefore = await readProjectFile(root, BASELINE_PATH);
    parseBaseline(baselineBefore);
    if (baselineBefore === null) {
      extra.push({ path: BASELINE_PATH, before: null, content: json({ schemaVersion: 1, ...auditCounts(view.graph) }), kind: 'baseline' });
    } else if (operation === 'upgrade') {
      // Upgrade records any decrease (for example after an ignore entry) and never raises a count.
      baselinePlan = planBaselineLowering(baselineBefore, auditCounts(view.graph));
      extra.push(baselinePlan.file);
    }
    const paths = [...new Set([...(marker.value?.paths ?? []), ...[...managed.files, ...host.files, ...(host.hooks ?? [])].filter((file) => file.content !== null).map((file) => isAbsolute(file.path) ? '.git/hooks/pre-commit' : file.path)])].sort();
    extra.push({ path: '.blocks/install.json', before: marker.before, content: json({ schemaVersion: 1, version, agents, paths }), kind: 'installation' });
  } else {
    extra.push({ path: '.blocks/install.json', before: marker.before, content: null, kind: 'installation' });
    if (configFile.before !== null && config && typeof config === 'object' && Object.hasOwn(config, 'blockBeaver')) {
      const ownerConfig = structuredClone(config);
      delete ownerConfig.blockBeaver;
      extra.push({ path: '.blocks/config.json', before: configFile.before, content: json(ownerConfig), kind: 'config' });
    }
    if (options.removeData) for (const path of await dataFiles(root, '.blocks', { directories: dataDirectories })) extra.push({ path, before: await readProjectFile(root, path), content: null, kind: 'data' });
  }
  const files = combine([managed.files, host.files, extra, packagePlan.files ?? []]);
  const hooks = host.hooks ?? [];
  // Verify every path before any package command or project mutation, including no-op paths.
  for (const file of files) if (await readProjectFile(root, file.path) !== file.before) throw new Error(`File changed during integration: ${file.path}`);
  await preflightHostHooks(root, hooks);
  await preflightProjectModes(root, host.files);
  const diff = [...files, ...hooks].filter((file) => file.before !== file.content);
  const result = { operation, version, agents, changed: [], diff, diagnostics, conflicts, commands: packagePlan.commands, dryRun: Boolean(options.dryRun), complete: false, view: view && '.blocks/view/index.html' };
  if (operation !== 'uninstall') Object.assign(result, enforcementSummary(config));
  if (baselinePlan) result.baseline = baselineSummary(baselinePlan);
  if (options.dryRun || conflicts.length) return result;
  const packageOwned = new Map();
  for (const path of packageManagerFiles) packageOwned.set(path, await readProjectFile(root, path).catch(() => undefined));
  result.executions = await runPackageChange(root, packagePlan, { runner: options.runner, dryRun: false });
  const pkg = (await document(root, 'package.json')).value;
  if (operation === 'uninstall' ? (pkg.devDependencies?.['block-beaver'] !== undefined || pkg.dependencies?.['block-beaver'] !== undefined)
    : (pkg.devDependencies?.['block-beaver'] !== version || pkg.dependencies?.['block-beaver'] !== undefined)) throw new Error('Package manager did not apply the requested Block Beaver dependency change. Managed files were preserved.');
  result.changed = await writeProjectFiles(root, files.filter((file) => !file.commandOwned));
  result.changed.push(...await applyProjectModes(root, host.files));
  result.changed.push(...await applyHostHooks(root, hooks));
  for (const file of files.filter((item) => item.commandOwned)) if (await readProjectFile(root, file.path) !== file.before) result.changed.push(file.path);
  // The package manager also rewrites its lockfile and workspace file; the setup exception must cover them.
  for (const [path, before] of packageOwned) if (await readProjectFile(root, path).catch(() => undefined) !== before) result.changed.push(path);
  result.changed = [...new Set(result.changed)];
  if (operation === 'uninstall' && options.removeData) {
    const directories = dataDirectories;
    for (const file of files.filter((item) => item.path.startsWith('.blocks/'))) {
      const segments = file.path.split('/');
      for (let end = 1; end < segments.length; end++) directories.add(segments.slice(0, end).join('/'));
    }
    for (const path of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
      await readProjectFile(root, `${path}/.block-beaver-directory-check`);
      try { await rmdir(join(root, path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  result.complete = true;
  if (operation !== 'uninstall') {
    // Written last so it covers the final bytes; later owner edits correctly become stale. Uninstall
    // records none because it also removes the hook, which is a known limit.
    try { result.exception = await recordManagedSetup(root, { label: operation, paths: result.changed }); }
    catch (error) {
      result.exception = { status: 'incomplete', reason: error.message };
      // Without a committed base there is nothing to gate yet, so the install still counts.
      if (await gitHead(root).then(() => true, () => false)) result.complete = false;
    }
  }
  return result;
}

export const installProject = (root, options = {}) => execute(root, 'install', options);
export const upgradeProject = (root, options = {}) => execute(root, 'upgrade', options);
export const uninstallProject = (root, options = {}) => execute(root, 'uninstall', options);
