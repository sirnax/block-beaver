import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateAuditRules, auditCounts } from '../src/audit-rules.mjs';
import { auditProject, recordException } from '../src/compliance.mjs';

const manifest = (id, files, dependencies = []) => ({ schemaVersion: 1, id, version: 1, name: id, description: `${id} block`, rationale: 'One cohesive feature.', files, dependencies, verification: [] });
function context() {
  const left = manifest('left', ['src/left.ts'], ['block:local:right']);
  const right = manifest('right', ['src/right.ts']);
  const graph = { nodes: [{ id: 'file:src/left.ts', kind: 'file', path: 'src/left.ts' }, { id: 'file:src/right.ts', kind: 'file', path: 'src/right.ts' }, { id: 'block:local:left', kind: 'block', manifest: left }, { id: 'block:local:right', kind: 'block', manifest: right }], edges: [{ from: 'block:local:left', to: 'file:src/left.ts', kind: 'implemented-by' }, { from: 'block:local:right', to: 'file:src/right.ts', kind: 'implemented-by' }, { from: 'file:src/left.ts', to: 'file:src/right.ts', kind: 'imports', evidence: { file: 'src/left.ts', line: 1 } }], resolutionReport: [], diagnostics: [] };
  return { graph, config: { schemaVersion: 1, apps: [] }, manifests: [{ path: '.blocks/manifests/left.json', value: left }, { path: '.blocks/manifests/right.json', value: right }], baseline: { schemaVersion: 1, coverage: 0, resolution: 0 }, paths: ['src/left.ts', 'src/right.ts'], installed: true, strict: true };
}
const result = (ctx, id) => evaluateAuditRules(ctx).find((entry) => entry.id === id);

test('stable audit rules accept valid context and each independent violation fails its gate', () => {
  assert.ok(evaluateAuditRules(context()).every((rule) => rule.pass));
  const mutations = {
    'managed-current': (ctx) => { ctx.managedFindings = [{ message: 'Old installed version.' }]; },
    'config-valid': (ctx) => { ctx.config.schemaVersion = 99; },
    'manifest-valid': (ctx) => { ctx.manifests[0].value.files.push('missing.ts'); },
    'view-fresh': (ctx) => { ctx.viewFindings = [{ path: '.blocks/view/index.html', message: 'Stale map.' }]; },
    'undeclared-link': (ctx) => { ctx.graph.nodes.find((node) => node.id === 'block:local:left').manifest.dependencies = []; },
    'coverage-ratchet': (ctx) => { ctx.graph.nodes.push({ id: 'file:src/new.ts', kind: 'file', path: 'src/new.ts' }); },
    'resolution-ratchet': (ctx) => { ctx.graph.resolutionReport.push({ file: 'src/left.ts', specifier: './missing' }); },
    'exception-valid': (ctx) => { ctx.exceptions = [{ path: '.blocks/exceptions/bad.json', value: { schemaVersion: 1, type: 'ratchet', id: 'bad', reason: '', paths: ['src/missing.ts'], rule: 'coverage-ratchet', allowance: 1 } }]; },
    'family-drift': (ctx) => { ctx.familyFindings = [{ message: 'Generated family output differs.' }]; },
  };
  for (const [id, mutate] of Object.entries(mutations)) { const ctx = context(); mutate(ctx); assert.equal(result(ctx, id).pass, false, id); }
});

test('ratchets are read-only, decreases pass, strict activates resolution, and exceptions stay scoped', () => {
  const ctx = context();
  ctx.baseline.coverage = 2;
  assert.equal(result(ctx, 'coverage-ratchet').pass, true);
  const before = JSON.stringify(ctx.baseline);
  ctx.graph.resolutionReport = [{ file: 'src/left.ts', specifier: './missing' }];
  ctx.strict = false;
  assert.equal(result(ctx, 'resolution-ratchet').skipped, true);
  ctx.strict = true;
  assert.equal(result(ctx, 'resolution-ratchet').pass, false);
  ctx.exceptions = [{ path: '.blocks/exceptions/resolution.json', value: { schemaVersion: 1, type: 'ratchet', id: 'resolution', reason: 'Legacy dependency migration.', paths: ['src/left.ts'], rule: 'resolution-ratchet', allowance: 1 } }];
  assert.equal(result(ctx, 'resolution-ratchet').pass, true);
  ctx.graph.resolutionReport[0].file = 'src/right.ts';
  assert.equal(result(ctx, 'resolution-ratchet').pass, false);
  assert.equal(JSON.stringify(ctx.baseline), before);
  assert.deepEqual(auditCounts(ctx.graph), { coverage: 0, resolution: 1 });
});

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-audit-rule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, content) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), typeof content === 'string' ? content : JSON.stringify(content)); };
  await put('src/main.ts', 'export const main = 1;');
  await put('.blocks/config.json', { schemaVersion: 1, apps: [{ id: 'app', root: '.', entries: ['src/main.ts'] }] });
  await put('.blocks/baseline.json', { schemaVersion: 1, coverage: 1, resolution: 0 });
  await put('.gitignore', '.blocks/worktrees/\n.blocks/view/\n');
  git(root, 'init', '-q'); git(root, 'add', '.'); git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
  return { root, put };
}

test('staged and range structural rules inspect selected Git content rather than working edits', async (t) => {
  const { root, put } = await fixture(t);
  const base = git(root, 'rev-parse', 'HEAD');
  await put('src/new.ts', 'export const added = 1;');
  git(root, 'add', 'src/new.ts');
  await rm(join(root, 'src/new.ts'));
  await put('.blocks/config.json', { schemaVersion: 99, apps: [] });
  const baselineBefore = await readFile(join(root, '.blocks/baseline.json'), 'utf8');
  const staged = await auditProject(root, { mode: 'staged' });
  assert.equal(staged.rules.find((rule) => rule.id === 'config-valid').pass, true);
  assert.equal(staged.rules.find((rule) => rule.id === 'coverage-ratchet').pass, false);
  assert.equal(staged.files.find((file) => file.path === 'src/new.ts').status, 'unreviewed-source');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'new staged source');
  const ranged = await auditProject(root, { mode: 'range', base });
  assert.equal(ranged.rules.find((rule) => rule.id === 'config-valid').pass, true);
  assert.equal(ranged.rules.find((rule) => rule.id === 'coverage-ratchet').pass, false);
  const working = await auditProject(root);
  assert.equal(working.rules.find((rule) => rule.id === 'config-valid').pass, false);
  assert.equal(await readFile(join(root, '.blocks/baseline.json'), 'utf8'), baselineBefore);
});

test('ratchet recording never grants reviewed source approval and invalid existing paths fail', async (t) => {
  const { root, put } = await fixture(t);
  await put('src/new.ts', 'export const added = 1;');
  await recordException(root, 'new-uncovered', { reason: 'Temporary adoption gap.', paths: ['src/new.ts'], rule: 'coverage-ratchet', allowance: 1 });
  const audit = await auditProject(root);
  assert.equal(audit.rules.find((rule) => rule.id === 'coverage-ratchet').pass, true);
  assert.equal(audit.rules.find((rule) => rule.id === 'exception-valid').pass, true);
  assert.equal(audit.rules.find((rule) => rule.id === 'reviewed-content').pass, false);
  assert.equal(audit.files.find((file) => file.path === 'src/new.ts').status, 'unreviewed-source');
  await assert.rejects(recordException(root, 'missing', { reason: 'Reason', paths: ['src/missing.ts'], rule: 'coverage-ratchet', allowance: 1 }), /existing repository file/);
});

test('installed audit detects managed drift and checks ignored view artifacts against selected source', async (t) => {
  const { root, put } = await fixture(t);
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { planManagedFiles } = await import('../src/managed-files.mjs');
  const { writeProjectFiles } = await import('../src/project-files.mjs');
  const { updateProject } = await import('../src/block-map.mjs');
  const config = { schemaVersion: 1, apps: [{ id: 'app', root: '.', entries: ['src/main.ts'] }], blockBeaver: { version } };
  await put('package.json', { type: 'module', devDependencies: { 'block-beaver': version } });
  await put('.blocks/config.json', config);
  await put('.blocks/install.json', { schemaVersion: 1, version, agents: [], paths: [] });
  const plan = await planManagedFiles({ root, version, config, agents: [], operation: 'install' });
  assert.equal(plan.conflicts.length, 0);
  await writeProjectFiles(root, plan.files);
  const { planHostSetup } = await import('../src/install-host.mjs');
  const { applyHostHooks, applyProjectModes } = await import('../src/host-hooks.mjs');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/project.git');
  const host = await planHostSetup(root, { version, config, agents: [], operation: 'install' });
  assert.equal(host.conflicts.length, 0);
  await writeProjectFiles(root, host.files);
  await applyProjectModes(root, host.files);
  await applyHostHooks(root, host.hooks);
  await put('.blocks/install.json', { schemaVersion: 1, version, agents: [], paths: [...plan.files.map((file) => file.path), ...host.files.map((file) => file.path), ...host.hooks.map((hook) => hook.path)] });
  await updateProject(root);
  git(root, 'add', '.');
  const clean = await auditProject(root, { mode: 'staged' });
  assert.equal(clean.rules.find((rule) => rule.id === 'managed-current').pass, true, JSON.stringify(clean.rules));
  assert.equal(clean.rules.find((rule) => rule.id === 'view-fresh').pass, true, JSON.stringify(clean.rules));
  await chmod(join(root, '.git/hooks/pre-commit'), process.platform === 'win32' ? 0o444 : 0o644);
  const disabledHook = await auditProject(root, { mode: 'staged' });
  assert.equal(disabledHook.rules.find((rule) => rule.id === 'managed-current').pass, false);
  await chmod(join(root, '.git/hooks/pre-commit'), 0o755);
  const ciPath = '.github/workflows/block-beaver.yml';
  const savedCi = await readFile(join(root, ciPath), 'utf8');
  await put(ciPath, savedCi.replace('block-beaver audit', 'block-beaver inspect'));
  const changedCi = await auditProject(root);
  assert.ok(changedCi.rules.find((rule) => rule.id === 'managed-current').findings.some((finding) => finding.path === ciPath));
  await put(ciPath, savedCi);
  const savedMap = await readFile(join(root, '.blocks/view/index.html'), 'utf8');
  await put('src/main.ts', 'export const main = 99;');
  const staged = await auditProject(root, { mode: 'staged' });
  assert.equal(staged.rules.find((rule) => rule.id === 'view-fresh').pass, true, 'Unstaged source cannot invalidate view derived from selected staged source.');
  const working = await auditProject(root);
  assert.equal(working.rules.find((rule) => rule.id === 'view-fresh').pass, false);
  assert.equal(await readFile(join(root, '.blocks/view/index.html'), 'utf8'), savedMap, 'Audit must not regenerate artifacts.');
  await put('src/main.ts', 'export const main = 1;');
  const rangeBase = git(root, 'rev-parse', 'HEAD');
  await rm(join(root, '.git/hooks/pre-commit'));
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'installed setup');
  const range = await auditProject(root, { mode: 'range', base: rangeBase });
  assert.equal(range.rules.find((rule) => rule.id === 'managed-current').pass, true, JSON.stringify(range.rules));
  assert.ok(range.rules.find((rule) => rule.id === 'managed-current').advisories.some((entry) => entry.code === 'bare-hook-range-skip'));
  const stagedWithoutHook = await auditProject(root, { mode: 'staged' });
  assert.equal(stagedWithoutHook.rules.find((rule) => rule.id === 'managed-current').pass, false);
  await put('.blocks/WORKFLOW.md', 'Edited managed content');
  const drift = await auditProject(root);
  assert.equal(drift.rules.find((rule) => rule.id === 'managed-current').pass, false);
});

test('typed dependencies and metadata roles join implementation governance', () => {
  const ctx = context();
  const left = ctx.graph.nodes.find((node) => node.id === 'block:local:left');
  left.manifest.dependencies = [];
  left.dependencies = ['block:local:right'];
  ctx.graph.nodes.push(...['contract', 'manifest', 'generator'].map((role) => ({ id: `file:meta/${role}.ts`, kind: 'file', path: `meta/${role}.ts`, familyRole: role })), { id: 'file:src/generated.ts', kind: 'file', path: 'src/generated.ts', generated: true });
  assert.deepEqual(auditCounts(ctx.graph), { coverage: 0, resolution: 0 });
  assert.equal(result(ctx, 'coverage-ratchet').pass, true);
  assert.equal(result(ctx, 'undeclared-link').pass, true);
  ctx.graph.familyDiagnostics = [{ rule: 'manifest-valid', severity: 'error', file: 'meta/manifest.ts', message: 'Typed link target is missing.' }];
  assert.equal(result(ctx, 'manifest-valid').pass, false);
  ctx.config.families = 'invalid';
  assert.equal(result(ctx, 'config-valid').pass, false);
});

test('lint allowance baselines only decrease and audit never writes their counts', async (t) => {
  const { root, put } = await fixture(t);
  const initial = { schemaVersion: 1, coverage: 1, resolution: 0, lint: { 'no-block-id-literal': { 'src/main.ts': 2 } } };
  await put('.blocks/baseline.json', initial);
  git(root, 'add', '.blocks/baseline.json');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial lint allowances');
  const lowered = structuredClone(initial);
  lowered.lint['no-block-id-literal']['src/main.ts'] = 1;
  await put('.blocks/baseline.json', lowered);
  assert.equal((await auditProject(root)).rules.find((rule) => rule.id === 'lint-baseline-ratchet').pass, true);
  lowered.lint['no-block-id-literal']['src/main.ts'] = 3;
  await put('.blocks/baseline.json', lowered);
  assert.equal((await auditProject(root)).rules.find((rule) => rule.id === 'lint-baseline-ratchet').pass, false);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.blocks/baseline.json'), 'utf8')), lowered);
});

test('public audit joins typed family implementation ownership and refuses malformed family config', async (t) => {
  const { root, put } = await fixture(t);
  const config = { schemaVersion: 1, apps: [{ id: 'app', root: '.', entries: ['src/main.ts'] }], families: [{ id: 'unit', contract: 'meta/unit.family.ts', manifests: 'meta/units/*.ts', registry: { out: 'src/generated-units.ts' } }] };
  await put('.blocks/config.json', config);
  await put('meta/unit.family.ts', `import { defineFamily, s } from 'block-beaver/kernel';
export default defineFamily({ id: 'unit', fields: s.object({ next: s.optional(s.string()) }), implementation: ['module'], links: [{ field: 'next', to: 'unit', kind: 'uses' }], generators: ['index', 'registry'] });`);
  await put('meta/units/main.ts', `export default { id: 'main', family: 'unit', version: 1, name: 'Main', description: 'Entry feature', rationale: 'One entry feature', implementation: { kind: 'module', module: '../../src/main' }, next: 'other' };`);
  await put('meta/units/other.ts', `export default { id: 'other', family: 'unit', version: 1, name: 'Other', description: 'Shared feature', rationale: 'One shared feature', implementation: { kind: 'module', module: '../../src/other' } };`);
  await put('src/main.ts', 'import "./other"; export const main = 1;');
  await put('src/other.ts', 'export const other = 2;');
  const audit = await auditProject(root);
  assert.equal(audit.rules.find((rule) => rule.id === 'manifest-valid').pass, true, JSON.stringify(audit.rules));
  assert.equal(audit.rules.find((rule) => rule.id === 'coverage-ratchet').pass, true, JSON.stringify(audit.rules));
  assert.equal(audit.rules.find((rule) => rule.id === 'undeclared-link').pass, true, JSON.stringify(audit.rules));
  assert.equal(audit.rules.find((rule) => rule.id === 'family-drift').pass, false, 'Missing family outputs fail without writing them.');
  const { generateProject } = await import('../src/families/commands.mjs');
  const generated = await generateProject(root);
  assert.equal(generated.ok, true, JSON.stringify(generated));
  const clean = await auditProject(root);
  assert.equal(clean.rules.find((rule) => rule.id === 'family-drift').pass, true, JSON.stringify(clean.rules));
  await put('package.json', { name: 'audit-fixture', version: '1.0.0', type: 'module' });
  const { installProject } = await import('../src/install.mjs');
  const { packageRunner } = await import('./helpers/install-fixture.mjs');
  const installed = await installProject(root, { agents: [], runner: packageRunner(root) });
  assert.equal(installed.complete, true, JSON.stringify(installed.conflicts));
  git(root, 'add', '.');
  const staged = await auditProject(root, { mode: 'staged' });
  assert.equal(staged.rules.find((rule) => rule.id === 'view-fresh').pass, true, JSON.stringify(staged.rules));
  assert.equal(staged.rules.find((rule) => rule.id === 'family-drift').pass, true, JSON.stringify(staged.rules));
  const output = await readFile(join(root, 'src/generated-units.ts'), 'utf8');
  await put('.blocks/cache/generators.json', { schemaVersion: 1, entries: {} });
  const cache = await readFile(join(root, '.blocks/cache/generators.json'), 'utf8');
  await put('src/generated-units.ts', '// generated by block-beaver; do not edit\nexport const stale = true;');
  const drift = await auditProject(root);
  assert.equal(drift.rules.find((rule) => rule.id === 'family-drift').pass, false);
  assert.equal(await readFile(join(root, '.blocks/cache/generators.json'), 'utf8'), cache, 'Audit cannot update the generation cache.');
  assert.ok((await readFile(join(root, 'src/generated-units.ts'), 'utf8')).includes('stale = true'));
  await put('src/generated-units.ts', output);
  await put('meta/units/main.ts', `export default { id: 'main', family: 'unit', version: 1, name: 'Main', description: 'Entry feature', rationale: 'One entry feature', implementation: { kind: 'module', module: '../../src/main' } };`);
  const undeclared = await auditProject(root);
  assert.equal(undeclared.rules.find((rule) => rule.id === 'undeclared-link').pass, false);
  config.families = 'invalid';
  await put('.blocks/config.json', config);
  assert.equal((await auditProject(root)).rules.find((rule) => rule.id === 'config-valid').pass, false);
});

test('family drift checks registered modules without families and never writes outputs or cache', async (t) => {
  const { root, put } = await fixture(t);
  const { scanRepository } = await import('../src/scanner.mjs');
  const { attachProjectRegistry } = await import('../src/adapter.mjs');
  const { renderViewModule } = await import('../src/view-exports.mjs');
  await put('.blocks/view-exports.json', [{ path: 'snapshot.mjs', format: 'module' }]);
  const graph = await attachProjectRegistry(await scanRepository(root, { writeConfig: false }));
  const expected = renderViewModule(graph);
  await put('snapshot.mjs', expected);
  const current = await auditProject(root);
  assert.equal(current.rules.find((rule) => rule.id === 'family-drift').pass, true, JSON.stringify(current.rules));
  assert.equal(current.rules.find((rule) => rule.id === 'family-drift').skipped, false);
  await put('snapshot.mjs', '// generated by block-beaver from the project graph; do not edit\nexport const BLOCK_BEAVER_VIEW = "stale";\n');
  const before = await readFile(join(root, 'snapshot.mjs'), 'utf8');
  const stale = await auditProject(root);
  assert.equal(stale.rules.find((rule) => rule.id === 'family-drift').pass, false);
  assert.ok(stale.rules.find((rule) => rule.id === 'family-drift').findings.some((finding) => finding.path === 'snapshot.mjs'));
  assert.equal(await readFile(join(root, 'snapshot.mjs'), 'utf8'), before);
  await assert.rejects(readFile(join(root, '.blocks/cache/generators.json')), { code: 'ENOENT' });
});

test('malformed export registries return structured audit failures and CLI exit 2', async (t) => {
  for (const [name, registry] of [['JSON', '{'], ['shape', { exports: [] }], ['path', [{ path: '../escaped.mjs', format: 'module' }]]]) {
    await t.test(name, async (t) => {
      const { root, put } = await fixture(t);
      await put('.blocks/view-exports.json', registry);
      const before = await readFile(join(root, '.blocks/view-exports.json'), 'utf8');
      const audit = await auditProject(root);
      assert.equal(audit.pass, false);
      const configRule = audit.rules.find((rule) => rule.id === 'config-valid');
      assert.equal(configRule.pass, false);
      assert.ok(configRule.findings.some((finding) => finding.path === '.blocks/view-exports.json'));
      assert.equal(audit.rules.find((rule) => rule.id === 'manifest-valid').skipped, true, 'Unscanned manifests cannot be presented as verified.');
      assert.ok(audit.rules.find((rule) => rule.id === 'reviewed-content'), 'Receipt results remain present.');
      git(root, 'add', '.blocks/view-exports.json');
      const staged = await auditProject(root, { mode: 'staged' });
      assert.equal(staged.rules.find((rule) => rule.id === 'config-valid').pass, false);
      assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../bin/block-beaver.mjs', import.meta.url)), 'audit', '--root', root], { encoding: 'utf8' }), (error) => {
        assert.equal(error.status, 2);
        const output = JSON.parse(error.stdout);
        assert.equal(output.pass, false);
        assert.equal(output.rules.find((rule) => rule.id === 'config-valid').pass, false);
        return true;
      });
      assert.equal(await readFile(join(root, '.blocks/view-exports.json'), 'utf8'), before);
    });
  }
});

test('family validation findings keep their rule and appear once across graph and generation checks', async (t) => {
  const { root, put } = await fixture(t);
  const config = { schemaVersion: 1, apps: [], families: [{ id: 'unit', contract: 'meta/unit.family.ts', manifests: 'meta/units/*.ts' }] };
  await put('.blocks/config.json', config);
  await put('meta/unit.family.ts', `import { defineFamily, s } from 'block-beaver/kernel'; export default defineFamily({ id: 'unit', fields: s.object({}), implementation: ['module'] });`);
  await put('meta/units/bad.ts', `export default { id: 'bad', family: 'unit', version: 0, name: 'Bad', description: 'Invalid version', rationale: 'Validation fixture', implementation: { kind: 'module', module: '../../src/main' } };`);
  const audit = await auditProject(root);
  const invalid = audit.rules.find((rule) => rule.id === 'manifest-valid');
  assert.equal(invalid.pass, false, JSON.stringify(audit.rules));
  assert.equal(new Set(invalid.findings.map((finding) => `${finding.path}:${finding.message}`)).size, invalid.findings.length);
  const drift = audit.rules.find((rule) => rule.id === 'family-drift');
  assert.ok(invalid.findings.every((finding) => !drift.findings.some((entry) => entry.message === finding.message)), 'Validation failures must not be mislabeled as generated output drift.');
  config.families = 'invalid';
  await put('.blocks/config.json', config);
  const malformed = await auditProject(root);
  const findings = malformed.rules.find((rule) => rule.id === 'config-valid').findings;
  assert.equal(findings.filter((finding) => finding.message === 'families must be an array').length, 1);
  assert.ok(malformed.rules.find((rule) => rule.id === 'family-drift').findings.every((finding) => finding.message !== 'families must be an array'));
});
