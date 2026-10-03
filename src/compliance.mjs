import { constants } from 'node:fs';
import { fileModeMatches, gitModeForWorktreeFile } from './file-mode.mjs';
import { readFile, readdir, mkdir, mkdtemp, rm, symlink, writeFile, lstat, open, realpath } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isTestFile } from './test-files.mjs';
import { evaluateAuditRules } from './audit-rules.mjs';
import { scanRepository } from './scanner.mjs';
import { attachProjectRegistry } from './adapter.mjs';
import { registeredViewOutputs, renderViewModule } from './view-exports.mjs';
import { graphRevision, renderBlockMap } from './block-map.mjs';
import { git } from './compliance-git.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashProposal } from './contracts.mjs';
import { readProjectFile, writeProjectFiles } from './project-files.mjs';
import { captureWorktreeSnapshot, compareWorktreeSnapshots } from './worktree-snapshot.mjs';
import { events, resume } from './workflow.mjs';
import { assertAncestor, assertGitRoot, baseBytes, baseMode, changedPaths, evidencePaths, gitHead, sha256, versionBytes, versionMode } from './compliance-git.mjs';

const exec = promisify(execFile);
const sourceExtensions = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
const safeId = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const manifestPath = (id) => `.blocks/manifests/${id}.json`;
const receiptPath = (roadmap, slice) => `.blocks/receipts/${roadmap}-${slice}.json`;
const exceptionPath = (id) => `.blocks/exceptions/${id}.json`;
const internalPath = (path) => /^\.blocks\/(?:view|worktrees|roadmaps|receipts|exceptions)\//.test(path);
const validDigest = (value) => value === null || typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const validMode = (value) => value === null || typeof value === 'string' && /^100[0-7]{3}$/.test(value);
const validPath = (path) => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') &&
  !path.includes('\0') && path.split('/').every((part) => part && part !== '.' && part !== '..');
const validEntry = (entry) => entry && validPath(entry.path) && validDigest(entry.beforeSha256) && validDigest(entry.afterSha256) &&
  validMode(entry.beforeMode) && validMode(entry.afterMode);
const hash = (bytes) => bytes === null ? null : sha256(bytes);
const parseJson = (bytes, path) => {
  if (bytes === null) throw new Error(`Missing review evidence: ${path}`);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`Invalid review evidence JSON: ${path}`); }
};
const samePaths = (left, right) => {
  const sorted = [...right].sort();
  return left.length === right.length && [...left].sort().every((path, i) => path === sorted[i]);
};

// Only managed: true exceptions carry this verification command, so an owner-authored exception cannot pose as setup.
const MANAGED_SETUP_COMMAND = 'Block Beaver managed setup';
const isManagedSetup = (receipt) => receipt.type === 'exception' && receipt.verification?.some((check) => check.command === MANAGED_SETUP_COMMAND);

// Strictness ascends so the stricter of two configured levels is the larger rank.
const RECEIPT_LEVELS = ['off', 'optional', 'required'];
const receiptLevel = (document) => {
  if (document === null) return null;
  const value = document?.enforcement?.receipts;
  return RECEIPT_LEVELS.includes(value) ? { level: value, explicit: true } : { level: 'required', explicit: false };
};
const parseConfig = (bytes) => {
  if (bytes === null) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { return {}; }
};

/**
 * The receipt gate is the stricter of the base revision's level and the audited tree's level.
 * Reading only the tree would let one commit loosen the gate and pass under its own new rules,
 * so loosening has to pass an audit at the old level first. On the adoption commit the base has
 * no config at all, so the audited tree's value applies. A config without the key means required.
 */
function receiptsEnforcement(baseDocument, treeDocument) {
  let winner = null;
  for (const [source, document] of [['base', baseDocument], ['tree', treeDocument]]) {
    const level = receiptLevel(document);
    if (level && (!winner || RECEIPT_LEVELS.indexOf(level.level) > RECEIPT_LEVELS.indexOf(winner.level))) winner = { ...level, source };
  }
  return { receipts: winner?.level ?? 'required', receiptsSource: winner?.explicit ? winner.source : 'default' };
}

async function readEvidence(root, path, mode) { return versionBytes(root, path, mode); }

async function validateBlockReceipt(root, receipt, mode) {
  if (receipt?.schemaVersion !== 1 || receipt.type !== 'block' || !safeId.test(receipt.roadmap || '') || !safeId.test(receipt.slice || '') ||
      !Array.isArray(receipt.paths) || !receipt.paths.length) throw new Error('Malformed block receipt.');
  const directory = `.blocks/roadmaps/${receipt.roadmap}`;
  const proposal = parseJson(await readEvidence(root, `${directory}/${receipt.slice}.proposal.json`, mode), 'proposal');
  const roadmap = parseJson(await readEvidence(root, `${directory}/roadmap.json`, mode), 'roadmap');
  const ledger = (await readEvidence(root, `${directory}/events.jsonl`, mode))?.toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) || [];
  const sliceEvents = ledger.filter((event) => event.slice === receipt.slice);
  const approval = sliceEvents.at(-1);
  const pass = [...sliceEvents].reverse().find((event) => event.type === 'checks-passed');
  if (roadmap.baseCommit !== receipt.baseCommit || proposal.manifest?.id !== receipt.slice ||
      hashProposal(proposal) !== receipt.proposalHash || approval?.type !== 'slice-approved' ||
      !pass?.result?.pass || pass.result.proposalHash !== receipt.proposalHash ||
      pass.result.snapshot?.digest !== receipt.snapshotDigest) throw new Error('Block receipt has no matching approved passing proposal.');
  const expected = [manifestPath(receipt.slice), ...(proposal.patches || []).map((patch) => patch.path)];
  if (!samePaths(receipt.paths.map((entry) => entry.path), expected)) throw new Error('Block receipt paths differ from the proposal.');
  const snapshot = new Map(pass.result.snapshot.files.map((entry) => [entry.path, entry]));
  for (const entry of receipt.paths) {
    const checked = snapshot.get(entry.path);
    if (!validEntry(entry) || !checked || checked.type !== 'file' || checked.sha256 !== entry.afterSha256 ||
        (checked.gitMode ?? gitModeForWorktreeFile(checked.mode, null, 'posix')) !== entry.afterMode) throw new Error(`Block receipt differs from checked content: ${entry.path}`);
  }
  return receipt;
}

function validateException(receipt) {
  if (receipt?.schemaVersion !== 1 || receipt.type !== 'exception' || !safeId.test(receipt.id || '') ||
      !receipt.reason?.trim() || !Array.isArray(receipt.paths) || !receipt.paths.length ||
      !Array.isArray(receipt.verification) || !receipt.verification.length ||
      receipt.verification.some((check) => check.pass !== true)) throw new Error('Malformed or unverified exception.');
  if (new Set(receipt.paths.map((entry) => entry.path)).size !== receipt.paths.length ||
      receipt.paths.some((entry) => !validEntry(entry) || sourceExtensions.test(entry.path) || internalPath(entry.path))) throw new Error('Exceptions cannot cover source, evidence, or malformed paths.');
  return receipt;
}

async function receiptsAt(root, mode) {
  const valid = [], invalid = [];
  for (const path of await evidencePaths(root, mode)) {
    if (!path.endsWith('.json')) continue;
    try {
      const value = parseJson(await readEvidence(root, path, mode), path);
      if (path.startsWith('.blocks/receipts/')) {
        if (path !== receiptPath(value.roadmap, value.slice)) throw new Error('Block receipt path disagrees with its identity.');
        valid.push(await validateBlockReceipt(root, value, mode));
      } else {
        if (path !== exceptionPath(value.id)) throw new Error('Exception path disagrees with its identity.');
        if (value.type !== 'ratchet') valid.push(validateException(value));
      }
    } catch (error) { invalid.push({ path, reason: error.message }); }
  }
  return { valid, invalid };
}

async function readJson(root, path) {
  const text = await readProjectFile(root, path);
  if (text === null) return { present: false, value: null };
  try { return { present: true, value: JSON.parse(text) }; }
  catch { return { present: true, value: null, error: `Invalid JSON: ${path}` }; }
}

async function treePaths(root) {
  const paths = [];
  async function walk(folder, prefix = '') {
    let entries; try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name) && !/^\.blocks\/(?:worktrees|cache)(?:\/|$)/.test(path)) await walk(join(folder, entry.name), path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  await walk(root); return paths.sort();
}

async function auditSnapshot(root, mode) {
  const temporary = await mkdtemp(join(tmpdir(), 'block-beaver-audit-'));
  const target = join(temporary, basename(root));
  await mkdir(target);
  try {
    const output = await git(root, mode === 'staged' ? ['ls-files', '--stage', '-z'] : ['ls-tree', '-r', '-z', 'HEAD']);
    const symlinks = [];
    for (const record of output.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t'), path = record.slice(tab + 1), parts = record.slice(0, tab).split(' ');
      if (!validPath(path)) throw new Error(`Unsafe snapshot path: ${path}`);
      if (mode === 'staged' && parts[2] !== '0') throw new Error(`Unmerged Git index entry: ${path}`);
      if (parts[0] === '160000') continue;
      if (!['100644', '100755', '120000'].includes(parts[0])) throw new Error(`Unsupported snapshot file type: ${path}`);
      const bytes = await versionBytes(root, path, mode);
      if (parts[0] === '120000') { symlinks.push({ path, text: bytes.toString('utf8') }); continue; }
      await mkdir(dirname(join(target, path)), { recursive: true });
      await writeFile(join(target, path), bytes, { mode: parts[0] === '100755' ? 0o755 : 0o644 });
    }
    // Links are installed last, after regular files, so Git paths cannot traverse them.
    for (const link of symlinks) {
      const destination = resolve(dirname(join(target, link.path)), link.text);
      if (link.text.startsWith('/') || relative(target, destination).startsWith('..')) throw new Error(`Snapshot symlink leaves repository: ${link.path}`);
      await mkdir(dirname(join(target, link.path)), { recursive: true });
      await symlink(link.text, join(target, link.path));
    }
    await snapshotGitState(root, target, { copyBare: mode !== 'range' });
    await snapshotDependencies(root, target);
    const { derived, copied } = await snapshotViewArtifacts(root, target);
    await writeProjectFiles(target, copied);
    return { root: target, derivedView: derived, dispose: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

const VIEW_ARTIFACTS = ['.blocks/view/graph.json', '.blocks/view/index.html'];

/**
 * Decides where each generated view artifact comes from in a staged or range snapshot (#26).
 * - Committed (present in the selected version): kept as selected and compared byte for byte.
 * - Absent and ignored by the selected .gitignore: derived. It can never be part of a commit, so
 *   view-fresh regenerates it from the snapshot graph instead of reading the working copy, and the
 *   pre-commit hook matches CI (which runs update first) without a manual update.
 * - Absent and not ignored: the working copy is copied in and compared, as before 0.6.0.
 * Registered view-export modules follow the same rule; they were never copied from the working tree.
 */
async function snapshotViewArtifacts(root, target) {
  let modules = [];
  try { modules = (await registeredViewOutputs(target, {})).map((output) => output.out); } catch { /* reported by structural rules */ }
  const absent = [];
  for (const path of [...VIEW_ARTIFACTS, ...modules]) {
    if (!validPath(path)) continue;
    const present = await readProjectFile(target, path).then((content) => content !== null, () => true);
    if (!present && !absent.includes(path)) absent.push(path);
  }
  const { ignoredPaths } = await import('./install-host.mjs');
  const ignored = await ignoredPaths(target, absent, { isolated: true }) ?? new Set();
  const derived = new Set(absent.filter((path) => ignored.has(path)));
  const copied = [];
  for (const path of VIEW_ARTIFACTS) {
    if (!absent.includes(path) || derived.has(path)) continue;
    const content = await readProjectFile(root, path);
    if (content !== null) copied.push({ path, before: null, content });
  }
  return { derived, copied };
}

async function safeHookBytes(path) {
  let parent = dirname(path);
  while (true) {
    const entry = await lstat(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe Git hook parent: ${parent}`);
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  let entry; try { entry = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Git hook must be an independent regular file.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat();
    if (actual.ino !== entry.ino || actual.dev !== entry.dev || actual.nlink !== 1 || !actual.isFile()) throw new Error('Git hook changed while reading.');
    return { content: await handle.readFile('utf8'), mode: actual.mode & 0o777 };
  } finally { await handle.close(); }
}

async function snapshotGitState(inputRoot, target, { copyBare = true } = {}) {
  const root = await realpath(inputRoot);
  await git(target, ['init', '-q'], { isolated: true });
  try {
    const origin = (await git(root, ['remote', 'get-url', 'origin'])).trim();
    if (origin) await git(target, ['remote', 'add', 'origin', origin], { isolated: true });
  } catch (error) { if (![2, 128].includes(error.code)) throw error; }
  let configured = null;
  try { configured = (await git(root, ['config', '--get', 'core.hooksPath'])).trim(); } catch (error) { if (error.code !== 1) throw error; }
  if (configured) {
    if (isAbsolute(configured) || configured.split(/[\\/]/).includes('..')) throw new Error('Audit snapshot cannot reproduce external core.hooksPath.');
    await git(target, ['config', 'core.hooksPath', configured], { isolated: true });
    // Tracked hook-manager files remain the selected index/HEAD version.
    return;
  }
  if (!copyBare) return;
  const raw = (await git(root, ['rev-parse', '--git-path', 'hooks'])).trim();
  const hook = await safeHookBytes(join(resolve(root, raw), 'pre-commit'));
  if (hook) await writeFile(join(target, '.git/hooks/pre-commit'), hook.content, { mode: hook.mode });
}

async function snapshotDependencies(source, target) {
  // Installed third-party dependencies are compiler inputs; workspace symlinks must
  // point into the selected snapshot rather than the working source checkout.
  const { realpath } = await import('node:fs/promises');
  const canonical = await realpath(source);
  async function copyDirectory(folder, destination) {
    let entries; try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await mkdir(destination, { recursive: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.pnpm') continue;
      const original = join(folder, entry.name), output = join(destination, entry.name);
      if (entry.name.startsWith('@') && entry.isDirectory()) { await copyDirectory(original, output); continue; }
      const resolved = await realpath(original);
      const rel = relative(canonical, resolved);
      const workspace = rel && !rel.startsWith('..') && !rel.split('/').includes('node_modules');
      await symlink(workspace ? join(target, rel) : resolved, output, 'dir');
    }
  }
  async function discover(folder, rel = '') {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === '.blocks') continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name === 'node_modules') await copyDirectory(join(source, child), join(target, child));
      else if (!entry.name.startsWith('.')) await discover(join(folder, entry.name), child);
    }
  }
  await discover(source);
}

/**
 * Managed paths that Git ignores in the audit snapshot and that the snapshot does not contain.
 * They exist only on the machine that installed them, so staged and range audits cannot check
 * them; working audits read the real files and never use this.
 */
async function localOnlyPaths(root, mode, paths, removed = new Set()) {
  // A managed path this change deletes was tracked, so ignoring it afterwards cannot make it local-only.
  const candidates = [...new Set(paths.filter((path) => typeof path === 'string' && validPath(path) && !removed.has(path)))];
  if (mode === 'working' || !candidates.length) return new Set();
  const { ignoredPaths } = await import('./install-host.mjs');
  const ignored = await ignoredPaths(root, candidates, { isolated: true });
  const local = new Set();
  for (const path of ignored || []) if (await readProjectFile(root, path).catch(() => undefined) === null) local.add(path);
  return local;
}

function routeManaged(finding, local, findings, advisories) {
  if (!finding.path || !local.has(finding.path)) { findings.push(finding); return; }
  if (advisories.some((entry) => entry.code === 'ignored-managed-local' && entry.path === finding.path)) return;
  advisories.push({ code: 'ignored-managed-local', severity: 'info', path: finding.path,
    message: `${finding.path} is managed but ignored by git, so it exists only on that machine and staged or CI audits cannot check it.`,
    remediation: 'Run block-beaver install --fix-ignores to un-ignore only the managed paths so they can be committed and checked.' });
}

async function structuralRules(root, { strict, familyDrift, mode, priorBaseline, removed, derivedView = new Set() }) {
  const configDocument = await readJson(root, '.blocks/config.json');
  const installDocument = await readJson(root, '.blocks/install.json');
  const baselineDocument = await readJson(root, '.blocks/baseline.json');
  const scanFailure = (error, path = '.blocks/config.json') => evaluateAuditRules({
    graph: { nodes: [], edges: [], diagnostics: [] }, config: configDocument.value,
    configPresent: configDocument.present,
    diagnostics: [{ path, message: `Cannot inspect selected project: ${error.message}` }],
  }).map((rule) => rule.id === 'config-valid' ? rule : { ...rule, pass: true, findings: [], skipped: true, skipReason: 'Project scan failed; this check could not be evaluated.' });
  // Validate before scanning: malformed registries otherwise abort source discovery
  // before audit can return its ordinary, structured failing result.
  let exportRegistryPath = '.blocks/view-exports.json';
  try {
    if (await readProjectFile(root, exportRegistryPath) === null) exportRegistryPath = '.blocks/view/exports.json';
    await registeredViewOutputs(root, {});
  } catch (error) { return scanFailure(error, exportRegistryPath); }
  let scanned;
  try { scanned = await attachProjectRegistry(await scanRepository(root, { writeConfig: false })); }
  catch (error) { return scanFailure(error); }
  const graph = { ...scanned, root: '.', generator: 'block-beaver' };
  const paths = await treePaths(root);
  const manifests = [], exceptions = [];
  for (const path of paths) {
    if (path.startsWith('.blocks/manifests/') && path.endsWith('.json')) { const doc = await readJson(root, path); manifests.push({ path, value: doc.value, error: doc.error }); }
    if (path.startsWith('.blocks/exceptions/') && path.endsWith('.json')) { const doc = await readJson(root, path); exceptions.push({ path, value: doc.value, error: doc.error }); }
  }
  const installed = !!configDocument.value?.blockBeaver || installDocument.present;
  const managedFindings = [];
  const managedAdvisories = [];
  if (installed) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const hostPackage = await readJson(root, 'package.json');
    const devPin = hostPackage.value?.devDependencies?.['block-beaver'];
    const prodPin = hostPackage.value?.dependencies?.['block-beaver'];
    // Either placement is valid; install --runtime pins under dependencies.
    if (devPin !== version && prodPin !== version) managedFindings.push({ path: 'package.json', message: `Installed dependency ${prodPin || devPin || 'missing'} must match package ${version} exactly (in dependencies or devDependencies).`, remediation: 'block-beaver upgrade' });
    // Uses the root package.json: the project model has no per-file package.json mapping.
    if (devPin !== undefined && prodPin === undefined) {
      // Family contracts and generators run only in Block Beaver's build tooling, never in the app.
      const tooling = new Set((scanned.nodes || []).filter((node) => node.kind === 'file' && ['contract', 'generator'].includes(node.familyRole)).map((node) => node.path));
      const importers = (scanned.packageImports || []).filter((record) => record.package === 'block-beaver' && !record.typeOnly && /^block-beaver(?:\/(?:kernel|view))?$/.test(record.specifier) && !isTestFile(record.file) && !tooling.has(record.file));
      if (importers.length) {
        const places = [...new Set(importers.map((record) => `${record.file}:${record.line}`))];
        managedAdvisories.push({ code: 'runtime-import-dev-dependency', severity: 'warning', path: 'package.json',
          message: `block-beaver is a devDependency but non-test code imports it at runtime: ${places.slice(0, 5).join(', ')}${places.length > 5 ? `, and ${places.length - 5} more` : ''}.`,
          remediation: 'Run block-beaver install --runtime to pin it under dependencies, or ignore this if the app bundles block-beaver at build time.' });
      }
    }
    if (installDocument.value?.version !== version) managedFindings.push({ path: '.blocks/install.json', message: `Installed files are from ${installDocument.value?.version || 'unknown'}, package is ${version} — run block-beaver upgrade`, remediation: 'block-beaver upgrade' });
    try {
      const { planManagedFiles } = await import('./managed-files.mjs');
      const plan = await planManagedFiles({ root, version, config: configDocument.value || {}, agents: installDocument.value?.agents || [], operation: 'upgrade', force: true });
      const differing = plan.files.filter((file) => file.before !== file.content);
      const local = await localOnlyPaths(root, mode, [...differing.map((file) => file.path), ...(plan.conflicts || []).map((conflict) => conflict?.path)], removed);
      for (const file of differing) routeManaged({ path: file.path, message: 'Managed content differs from this package version.', remediation: 'block-beaver upgrade' }, local, managedFindings, managedAdvisories);
      for (const conflict of plan.conflicts || []) routeManaged(typeof conflict === 'string' ? { message: conflict } : conflict, local, managedFindings, managedAdvisories);
    } catch (error) { managedFindings.push({ message: `Cannot validate managed content: ${error.message}`, remediation: 'block-beaver upgrade' }); }
    try {
      const { planHostSetup } = await import('./install-host.mjs');
      const host = await planHostSetup(root, { version, config: configDocument.value || {}, agents: installDocument.value?.agents || [], operation: 'upgrade', force: true, isolatedGit: mode !== 'working' });
      const hostLocal = await localOnlyPaths(root, mode, [...host.files.filter((file) => file.before !== file.content).map((file) => file.path), ...(host.conflicts || []).map((conflict) => conflict?.path)], removed);
      for (const file of host.files) {
        if (file.before !== file.content) routeManaged({ path: file.path, message: 'Managed host content differs from this package version.', remediation: 'block-beaver upgrade' }, hostLocal, managedFindings, managedAdvisories);
        if (file.mode !== undefined && file.before !== null && !fileModeMatches((await lstat(join(root, file.path))).mode, file.mode)) managedFindings.push({ path: file.path, message: 'Managed host file has an incorrect executable mode.', remediation: 'block-beaver upgrade' });
      }
      if (mode === 'range') managedAdvisories.push({ code: 'bare-hook-range-skip', severity: 'info', message: 'Bare Git metadata hook availability and mode are skipped in range audits because fresh CI clones do not contain installed .git/hooks; tracked hooks and CI remain checked.' });
      for (const hook of mode === 'range' ? [] : host.hooks) {
        const current = await safeHookBytes(hook.absolutePath);
        if (current?.content !== hook.content || !current || !fileModeMatches(current.mode, hook.mode ?? 0o755)) managedFindings.push({ path: hook.path, message: 'Git pre-commit hook differs from the required managed step.', remediation: 'block-beaver upgrade' });
      }
      for (const conflict of host.conflicts || []) routeManaged(conflict, hostLocal, managedFindings, managedAdvisories);
      for (const diagnostic of host.diagnostics || []) {
        if (diagnostic.severity === 'error' || ['git-unavailable', 'invalid-config', 'unknown-agent'].includes(diagnostic.code)) managedFindings.push(diagnostic);
        else managedAdvisories.push(diagnostic);
      }
      if (mode !== 'range' && installDocument.value?.paths?.includes('.git/hooks/pre-commit')) {
        const raw = (await git(root, ['rev-parse', '--git-path', 'hooks'], { isolated: mode !== 'working' })).trim();
        const current = await safeHookBytes(join(resolve(await realpath(root), raw), 'pre-commit'));
        if (!current || !fileModeMatches(current.mode, 0o755)) managedFindings.push({ path: '.git/hooks/pre-commit', message: 'Installed Git pre-commit hook is missing or not executable.', remediation: 'block-beaver upgrade' });
      }
    } catch (error) { managedFindings.push({ message: `Cannot validate managed host content: ${error.message}`, remediation: 'block-beaver upgrade' }); }

  }
  // Derived (ignored, uncommitted) view artifacts are regenerated inside the snapshot from its own
  // graph, so they are fresh by construction and family drift sees the same bytes update would write.
  if (derivedView.size) {
    const modules = new Map((await registeredViewOutputs(root, graph)).map((output) => [output.out, output.detail]));
    const rendered = (path) => path === '.blocks/view/graph.json' ? JSON.stringify(graph, null, 2) + '\n'
      : path === '.blocks/view/index.html' ? renderBlockMap(graph) : modules.has(path) ? renderViewModule(graph, { detail: modules.get(path) }) : null;
    await writeProjectFiles(root, [...derivedView].map((path) => ({ path, before: null, content: rendered(path) })).filter((file) => file.content !== null));
  }
  const viewFindings = [];
  if (installed) {
    const stored = await readJson(root, '.blocks/view/graph.json');
    if (!stored.value || graphRevision(stored.value) !== graphRevision(graph)) viewFindings.push({ path: '.blocks/view/graph.json', message: 'Graph does not match selected source and manifests.', remediation: 'block-beaver update' });
    const html = renderBlockMap(graph);
    if (await readProjectFile(root, '.blocks/view/index.html') !== html) viewFindings.push({ path: '.blocks/view/index.html', message: 'Map differs from the current renderer and source.', remediation: 'block-beaver update' });
    let exports = await readJson(root, '.blocks/view-exports.json');
    if (!exports.present) exports = await readJson(root, '.blocks/view/exports.json');
    for (const entry of Array.isArray(exports.value) ? exports.value : []) {
      if (!validPath(entry.path)) { viewFindings.push({ message: 'Unsafe view export path.' }); continue; }
      const expected = renderViewModule(graph, { detail: entry.detail });
      if (entry.format === 'module' && await readProjectFile(root, entry.path) !== expected) viewFindings.push({ path: entry.path, message: 'Exported view module is stale.', remediation: `block-beaver view --format module${entry.detail === 'map' ? ' --detail map' : ''}` });
    }
  }
  let familyFindings = [];
  let extraOutputs;
  try { extraOutputs = await registeredViewOutputs(root, graph); }
  catch (error) { return scanFailure(error, exportRegistryPath); }
  const familyEnabled = extraOutputs.length > 0 || !!(configDocument.value && ['families', 'generators', 'history', 'checks'].some((key) => Object.hasOwn(configDocument.value, key)));
  if (familyDrift) familyFindings = await familyDrift({ root, graph, config: configDocument.value });
  else if (familyEnabled) {
    try {
      const { planGeneration, checkGeneration } = await import('./families/generate.mjs');
      const plan = await planGeneration({ root, config: configDocument.value || {}, graph, paths: Object.keys(graph.hashes || {}), extraOutputs, readOnly: true });
      const generationDiagnostics = checkGeneration(plan).filter((entry) => !entry.severity || entry.severity === 'error');
      // Loader/config errors remain in their structural rule, including errors
      // discovered only when preparing generators. Drift owns output differences.
      graph.familyDiagnostics = [...(graph.familyDiagnostics || []), ...generationDiagnostics.filter((entry) => entry.rule !== 'family-drift')];
      familyFindings = generationDiagnostics.filter((entry) => entry.rule === 'family-drift').map((entry) => ({ ...(entry.file ? { path: entry.file } : {}), message: entry.message, remediation: 'block-beaver gen' }));
    } catch (error) { familyFindings.push({ message: `Cannot check generated family outputs: ${error.message}`, remediation: 'block-beaver gen' }); }
  }
  return evaluateAuditRules({ graph, config: configDocument.value, configPresent: configDocument.present, manifests, baseline: baselineDocument.value, exceptions, paths, strict, installed, managedFindings, managedAdvisories, viewFindings, familyFindings, familyEnabled, priorBaseline, diagnostics: configDocument.error ? [{ path: '.blocks/config.json', message: configDocument.error }] : [] });
}

export async function auditProject(inputRoot, { mode = 'working', base = null, strict = false, familyDrift = null } = {}) {
  const root = resolve(inputRoot);
  if (!['working', 'staged', 'range'].includes(mode)) throw new Error('Audit mode must be working, staged, or range.');
  await assertGitRoot(root);
  if (mode === 'range') await assertAncestor(root, base);
  const changed = (await changedPaths(root, mode, base)).filter((item) => !internalPath(item.path));
  const evidence = await receiptsAt(root, mode);
  const files = [];
  const staleReviewed = new Set();
  for (const item of changed) {
    const before = hash(await baseBytes(root, item.path, mode, base));
    const after = hash(await versionBytes(root, item.path, mode, base));
    const previousMode = await baseMode(root, item.path, mode, base);
    const currentMode = await versionMode(root, item.path, mode, base);
    const covering = evidence.valid.filter((receipt) => receipt.paths.some((entry) => entry.path === item.path));
    // Config is owner-controlled and validated by config-valid. A managed setup exception that
    // covers it may accept the exact bytes install wrote, but it never goes stale when the owner
    // edits it afterwards; the edit follows the effective receipts level like any other change.
    const candidates = item.path === '.blocks/config.json' ? covering.filter((receipt) => !isManagedSetup(receipt)) : covering;
    const matches = covering.filter((receipt) => receipt.paths.some((entry) => entry.path === item.path && entry.beforeSha256 === before && entry.afterSha256 === after && entry.beforeMode === previousMode && entry.afterMode === currentMode));
    const kind = sourceExtensions.test(item.path) ? 'source' : item.path.startsWith('.blocks/manifests/') ? 'manifest' : 'other';
    const accepted = matches.find((receipt) => kind === 'other' ? receipt.type === 'exception' : receipt.type === 'block');
    let status = accepted ? (accepted.type === 'block' ? 'approved-block' : 'verified-exception')
      : candidates.length ? 'changed-after-review' : kind === 'source' ? 'unreviewed-source' : kind === 'manifest' ? 'unreviewed-manifest' : 'missing-exception';
    if ((kind === 'source' || kind === 'manifest') && after === null) status = 'unsupported-deletion';
    if (currentMode !== null && !/^100[0-7]{3}$/.test(currentMode)) status = 'unsupported-file-type';
    // Evidence recorded against this same base but no longer matching the bytes is stale review
    // of the change in hand, unlike an older receipt left behind by an earlier commit.
    if (status === 'changed-after-review' && candidates.some((receipt) => receipt.paths.some((entry) => entry.path === item.path && entry.beforeSha256 === before && entry.beforeMode === previousMode))) staleReviewed.add(item.path);
    files.push({ path: item.path, change: item.status, kind, status, evidence: accepted ? (accepted.type === 'block' ? receiptPath(accepted.roadmap, accepted.slice) : exceptionPath(accepted.id)) : null });
  }
  const snapshot = mode === 'working' ? { root, dispose: async () => {} } : await auditSnapshot(root, mode);
  const baselineBytes = await baseBytes(root, '.blocks/baseline.json', mode, base);
  let priorBaseline;
  if (baselineBytes !== null) { try { priorBaseline = JSON.parse(baselineBytes.toString('utf8')); } catch { priorBaseline = {}; } }
  const baseConfig = parseConfig(await baseBytes(root, '.blocks/config.json', mode, base));
  let rules, treeConfig;
  try {
    treeConfig = await readJson(snapshot.root, '.blocks/config.json');
    rules = await structuralRules(snapshot.root, { strict, familyDrift, mode, priorBaseline, derivedView: snapshot.derivedView, removed: new Set(changed.filter((item) => item.status === 'D').map((item) => item.path)) });
  }
  finally { await snapshot.dispose(); }
  const treeValue = treeConfig.present ? (treeConfig.value ?? {}) : null;
  const { receipts, receiptsSource } = receiptsEnforcement(baseConfig, treeValue);
  const unreviewed = files.filter((file) => !['approved-block', 'verified-exception'].includes(file.status));
  const invalid = evidence.invalid.map((entry) => ({ path: entry.path, message: entry.reason }));
  const advisory = (file) => ({ code: 'reviewed-content', severity: 'info', path: file.path, message: file.status });
  if (receipts === 'required') rules.push({ id: 'reviewed-content', pass: unreviewed.length === 0 && invalid.length === 0, findings: [...unreviewed.map((file) => ({ path: file.path, message: file.status })), ...invalid] });
  else if (receipts === 'optional') {
    // Unreviewed work is advisory, but forged or invalid evidence and review that went stale
    // against this very change are still errors.
    const failing = unreviewed.filter((file) => staleReviewed.has(file.path));
    const findings = [...failing.map((file) => ({ path: file.path, message: file.status })), ...invalid];
    rules.push({ id: 'reviewed-content', pass: findings.length === 0, findings, advisories: unreviewed.filter((file) => !staleReviewed.has(file.path)).map(advisory) });
  } else {
    // Off skips the review requirement, never the integrity of evidence that is present: a forged
    // or malformed receipt still fails, because exception-valid does not inspect block receipts.
    rules.push(invalid.length
      ? { id: 'reviewed-content', pass: false, findings: invalid }
      : { id: 'reviewed-content', pass: true, findings: [], skipped: true, skipReason: 'enforcement.receipts is off', advisories: [] });
  }
  const enforcement = { agents: treeValue?.enforcement?.agents ?? 'guide', gate: treeValue?.enforcement?.gate ?? 'audit', receipts, receiptsSource };
  return { pass: rules.every((rule) => rule.pass), mode, base: mode === 'range' ? base : await gitHead(root), enforcement, files, invalidEvidence: evidence.invalid, rules };
}

export async function integrateApproved(inputRoot, roadmapId, sliceId) {
  const root = resolve(inputRoot);
  await assertGitRoot(root);
  if (!safeId.test(roadmapId || '') || !safeId.test(sliceId || '')) throw new Error('Roadmap and slice IDs must be kebab-case.');
  const state = await resume(root, roadmapId);
  if (state.slices[sliceId]?.status !== 'approved') throw new Error('Approve a passing slice before integration.');
  const proposal = JSON.parse(await readFile(join(root, '.blocks', 'roadmaps', roadmapId, `${sliceId}.proposal.json`), 'utf8'));
  const sliceEvents = (await events(root, roadmapId)).filter((event) => event.slice === sliceId);
  const pass = [...sliceEvents].reverse().find((event) => event.type === 'checks-passed');
  if (!pass?.result?.pass || pass.result.proposalHash !== hashProposal(proposal) || !pass.result.snapshot) throw new Error('Approved slice lacks current passing check evidence.');
  const worktree = join(root, '.blocks', 'worktrees', roadmapId, sliceId);
  const snapshot = await captureWorktreeSnapshot(worktree, state.roadmap.baseCommit, manifestPath(sliceId));
  if (!compareWorktreeSnapshots(pass.result.snapshot, snapshot).equal) throw new Error('Approved worktree changed after review.');
  if (process.platform === 'win32' && pass.result.snapshot.files.some((entry) => entry.type === 'file' && !entry.gitMode)) {
    throw new Error('Passing snapshot lacks Windows Git mode evidence. Run check and review again before integration.');
  }
  const expected = [manifestPath(sliceId), ...(proposal.patches || []).map((patch) => patch.path)];
  if (!samePaths(snapshot.files.map((entry) => entry.path), expected)) throw new Error('Approved worktree contains an unexpected change.');
  const outputs = [], paths = [];
  for (const entry of snapshot.files) {
    if (entry.type !== 'file') throw new Error(`Unsupported integrated file type: ${entry.path}`);
    const beforeBytes = await baseBytes(root, entry.path, 'range', state.roadmap.baseCommit);
    const currentBytes = await versionBytes(root, entry.path, 'working');
    if (hash(beforeBytes) !== hash(currentBytes)) throw new Error(`Source changed since the reviewed base: ${entry.path}`);
    const afterBytes = await readFile(join(worktree, entry.path));
    if (sha256(afterBytes) !== entry.sha256) throw new Error(`Approved content changed: ${entry.path}`);
    outputs.push({ path: entry.path, before: currentBytes?.toString('utf8') ?? null, content: afterBytes.toString('utf8') });
    paths.push({ path: entry.path, beforeSha256: hash(beforeBytes), afterSha256: entry.sha256,
      beforeMode: await baseMode(root, entry.path, 'range', state.roadmap.baseCommit), afterMode: entry.gitMode ?? entry.mode });
  }
  const receipt = { schemaVersion: 1, type: 'block', roadmap: roadmapId, slice: sliceId, baseCommit: state.roadmap.baseCommit,
    proposalHash: hashProposal(proposal), snapshotDigest: pass.result.snapshot.digest, paths: paths.sort((a, b) => a.path.localeCompare(b.path)) };
  const receiptName = receiptPath(roadmapId, sliceId);
  if (await readProjectFile(root, receiptName) !== null) throw new Error(`Receipt already exists: ${receiptName}`);
  await writeProjectFiles(root, [...outputs, { path: receiptName, before: null, content: JSON.stringify(receipt, null, 2) + '\n' }]);
  return { integrated: true, roadmap: roadmapId, slice: sliceId, paths: paths.map((entry) => entry.path), receipt: receiptName };
}

async function runCheck(root, command) {
  const args = command.trim().split(/\s+/);
  if (!args.length || args.some((part) => !part || /[;&|`$<>]/.test(part))) throw new Error('Verification command must not use shell operators.');
  try {
    const result = await exec(args[0], args.slice(1), { cwd: root, timeout: 120_000, maxBuffer: 2_000_000 });
    return { command, pass: true, output: `${result.stdout}${result.stderr}`.slice(-2000) };
  } catch (error) { return { command, pass: false, output: `${error.stdout || ''}${error.stderr || ''}${error.message}`.slice(-2000) }; }
}

export async function recordException(inputRoot, id, { reason, paths, check = null, managed = false, managedOutput = 'Generated by init', rule = null, allowance = null } = {}) {
  const root = resolve(inputRoot);
  await assertGitRoot(root);
  if (!safeId.test(id || '') || !reason?.trim() || !Array.isArray(paths) || !paths.length) throw new Error('Exception needs a kebab-case ID, reason, and paths.');
  if (rule !== null) {
    if (!['coverage-ratchet', 'resolution-ratchet'].includes(rule) || !Number.isInteger(allowance) || allowance < 1 || allowance > new Set(paths).size) throw new Error('Ratchet exception requires a supported rule and bounded positive allowance.');
    const unique = [...new Set(paths)].sort();
    for (const path of unique) {
      if (!validPath(path) || path.startsWith('.blocks/') || await readProjectFile(root, path) === null) throw new Error(`Ratchet exception path must be an existing repository file: ${path}`);
    }
    const target = exceptionPath(id);
    if (await readProjectFile(root, target) !== null) throw new Error(`Exception already exists: ${target}`);
    const value = { schemaVersion: 1, type: 'ratchet', id, reason, paths: unique, rule, allowance };
    await writeProjectFiles(root, [{ path: target, before: null, content: JSON.stringify(value, null, 2) + '\n' }]);
    return { recorded: true, path: target, paths: unique, rule, allowance };
  }
  const changed = new Set((await changedPaths(root, 'working')).map((entry) => entry.path));
  const unique = [...new Set(paths)].sort();
  for (const path of unique) {
    if (!changed.has(path)) throw new Error(`Exception path has no current change: ${path}`);
    if (sourceExtensions.test(path) || internalPath(path)) throw new Error(`Exception cannot cover source or evidence file: ${path}`);
  }
  const verification = managed ? [{ command: MANAGED_SETUP_COMMAND, pass: true, output: managedOutput }] : [await runCheck(root, check || '')];
  if (verification.some((item) => !item.pass)) throw new Error(`Exception verification failed: ${verification[0].output}`);
  const entries = [];
  for (const path of unique) {
    const afterMode = await versionMode(root, path, 'working');
    if (afterMode !== null && !/^100[0-7]{3}$/.test(afterMode)) throw new Error(`Exception path is not a regular file: ${path}`);
    entries.push({ path, beforeSha256: hash(await baseBytes(root, path, 'working')), afterSha256: hash(await versionBytes(root, path, 'working')),
      beforeMode: await baseMode(root, path, 'working'), afterMode });
  }
  const value = { schemaVersion: 1, type: 'exception', id, reason, paths: entries, verification };
  const target = exceptionPath(id);
  if (await readProjectFile(root, target) !== null) throw new Error(`Exception already exists: ${target}`);
  await writeProjectFiles(root, [{ path: target, before: null, content: JSON.stringify(value, null, 2) + '\n' }]);
  return { recorded: true, path: target, paths: unique };
}

/**
 * Records the managed-setup exception for files a Block Beaver command just wrote. Only files
 * with a current working change and existing content are covered; generated view output and
 * Block Beaver's own evidence paths never need one. Returns null when nothing is eligible.
 */
export async function recordManagedSetup(inputRoot, { label, paths }) {
  const root = resolve(inputRoot);
  await assertGitRoot(root);
  const current = new Set((await changedPaths(root, 'working')).map((entry) => entry.path));
  const eligible = [];
  for (const path of [...new Set(paths)].sort()) {
    if (!current.has(path) || internalPath(path)) continue;
    // A deleted file cannot be named by an exception, which must reference existing files.
    const bytes = await versionBytes(root, path, 'working');
    if (bytes !== null) eligible.push([path, sha256(bytes)]);
  }
  if (!eligible.length) return null;
  const suffix = createHash('sha256').update(JSON.stringify(eligible)).digest('hex').slice(0, 12);
  const id = `block-beaver-setup-${suffix}`;
  // The same files with the same bytes were already covered; recording again would only collide.
  if (await readProjectFile(root, exceptionPath(id)) !== null) return { recorded: false, path: exceptionPath(id), paths: eligible.map(([path]) => path), reason: 'already recorded' };
  return recordException(root, id, { reason: `Block Beaver managed ${label}`, paths: eligible.map(([path]) => path), managed: true, managedOutput: `Generated by ${label}` });
}
