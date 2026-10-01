import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installProject, upgradeProject } from '../src/install.mjs';
import { auditProject } from '../src/compliance.mjs';
import { installationFixture, packageRunner, snapshot } from './helpers/install-fixture.mjs';

function withoutScanTime(files) {
  const graph = JSON.parse(files['.blocks/view/graph.json']);
  delete graph.scannedAt;
  return { ...files, '.blocks/view/graph.json': graph };
}

test('frozen 0.1.1 init files upgrade to the same current guidance as a fresh install', async (t) => {
  const historical = await installationFixture(t), fresh = await installationFixture(t);
  const fixture = new URL('./fixtures/upgrades/init-0.1.1/', import.meta.url);
  await cp(new URL('AGENTS.md', fixture), join(historical, 'AGENTS.md'));
  await cp(new URL('.blocks/', fixture), join(historical, '.blocks'), { recursive: true });
  await upgradeProject(historical, { version: '0.3.0', agents: ['codex'], runner: packageRunner(historical) });
  await installProject(fresh, { version: '0.3.0', agents: ['codex'], runner: packageRunner(fresh) });
  const upgraded = await snapshot(historical), installed = await snapshot(fresh);
  const canonical = files => Object.fromEntries(Object.entries(withoutScanTime(files)).map(([path, content]) => [path, typeof content === 'string' ? content.replaceAll('\r\n', '\n') : content]));
  assert.deepEqual(canonical(upgraded), canonical(installed));
});

test('an earlier install upgrades to fresh current managed bytes and a second upgrade is inert', async (t) => {
  const earlier = await installationFixture(t), fresh = await installationFixture(t);
  const options = { agents: ['claude', 'codex'], version: '0.3.0' };
  await installProject(earlier, { ...options, runner: packageRunner(earlier) });
  const before = await snapshot(earlier);
  const preview = await upgradeProject(earlier, { version: '0.4.0', dryRun: true });
  assert.deepEqual(await snapshot(earlier), before);
  assert.ok(preview.diff.some((file) => file.path === '.blocks/config.json'));
  await upgradeProject(earlier, { version: '0.4.0', runner: packageRunner(earlier) });
  await installProject(fresh, { ...options, version: '0.4.0', runner: packageRunner(fresh) });
  const upgraded = await snapshot(earlier), installed = await snapshot(fresh);
  assert.deepEqual(withoutScanTime(upgraded), withoutScanTime(installed));
  const after = await snapshot(earlier);
  const repeat = await upgradeProject(earlier, { version: '0.4.0', runner: packageRunner(earlier) });
  assert.deepEqual(repeat.changed, []);
  assert.deepEqual(repeat.commands, []);
  assert.deepEqual(await snapshot(earlier), after);
});

test('upgrade preserves local instructions, refuses edited managed sections and force repairs only owned bytes', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await installProject(root, { agents: ['codex'], version: '0.3.0', runner });
  const path = join(root, 'AGENTS.md');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace('<!-- block-beaver:end -->', 'An owner edit inside managed content.\n<!-- block-beaver:end -->') + '\n<!-- block-beaver:local:start -->\nKeep local rules.\n<!-- block-beaver:local:end -->\n');
  const before = await snapshot(root);
  const result = await upgradeProject(root, { version: '0.4.0', runner });
  assert.ok(result.conflicts.length);
  assert.equal(result.complete, false);
  assert.deepEqual(await snapshot(root), before);
  await upgradeProject(root, { version: '0.4.0', force: true, runner });
  const repaired = await readFile(path, 'utf8');
  assert.match(repaired, /Keep local rules/);
  assert.doesNotMatch(repaired, /An owner edit inside managed content/);
});

test('future versioned data blocks every upgrade write and command', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await installProject(root, { agents: [], version: '0.3.0', runner });
  await mkdir(join(root, '.blocks/roadmaps/task'), { recursive: true });
  await writeFile(join(root, '.blocks/roadmaps/task/roadmap.json'), JSON.stringify({ schemaVersion: 999, id: 'task' }));
  const before = await snapshot(root);
  await assert.rejects(upgradeProject(root, { version: '0.4.0', runner }), /future roadmap/);
  assert.deepEqual(await snapshot(root), before);
});

test('upgrade migrates frozen legacy roadmap data and preserves the original ratchet baseline', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await installProject(root, { agents: [], version: '0.3.0', runner });
  const baseline = await readFile(join(root, '.blocks/baseline.json'), 'utf8');
  await mkdir(join(root, '.blocks/roadmaps/legacy'), { recursive: true });
  // A schema-zero document, frozen here independently of the current writer.
  const legacy = { id: 'legacy', title: 'Owner roadmap', scope: ['src/index.ts'], slices: [], ownerNotes: 'Keep these notes' };
  await writeFile(join(root, '.blocks/roadmaps/legacy/roadmap.json'), JSON.stringify(legacy));
  await writeFile(join(root, 'src/another.ts'), 'export const another = true;\n');
  await upgradeProject(root, { version: '0.4.0', runner });
  assert.deepEqual(JSON.parse(await readFile(join(root, '.blocks/roadmaps/legacy/roadmap.json'), 'utf8')), { ...legacy, schemaVersion: 1 });
  assert.equal(await readFile(join(root, '.blocks/baseline.json'), 'utf8'), baseline);
});

test('future installation and baseline schemas refuse upgrades before writes', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await installProject(root, { agents: [], version: '0.3.0', runner });
  for (const path of ['.blocks/install.json', '.blocks/baseline.json']) {
    const original = await readFile(join(root, path), 'utf8');
    await writeFile(join(root, path), JSON.stringify({ ...JSON.parse(original), schemaVersion: 999 }));
    const before = await snapshot(root);
    await assert.rejects(upgradeProject(root, { version: '0.4.0', runner }), /Unsupported/);
    assert.deepEqual(await snapshot(root), before);
    await writeFile(join(root, path), original);
  }
});

test('upgrade moves legacy export exclusion metadata to its committed path without scanning the generated module', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await installProject(root, { agents: [], version: '0.3.0', runner });
  await writeFile(join(root, 'src/exported-view.mjs'), 'export const graph = {};\n');
  const exports = [{ path: 'src/exported-view.mjs', format: 'module' }];
  await writeFile(join(root, '.blocks/view/exports.json'), JSON.stringify(exports));
  await upgradeProject(root, { version: '0.4.0', runner });
  assert.deepEqual(JSON.parse(await readFile(join(root, '.blocks/view-exports.json'), 'utf8')), exports);
  await assert.rejects(readFile(join(root, '.blocks/view/exports.json')), { code: 'ENOENT' });
  const graph = JSON.parse(await readFile(join(root, '.blocks/view/graph.json'), 'utf8'));
  assert.ok(!graph.nodes.some((node) => node.path === 'src/exported-view.mjs'));
});

test('family upgrade preserves a generated bare-array index and refreshes typed ownership without resetting the baseline', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await mkdir(join(root, '.blocks'));
  await mkdir(join(root, 'definitions'));
  await mkdir(join(root, 'catalog/widgets'), { recursive: true });
  const config = { schemaVersion: 1, apps: [{ id: 'host', root: '.', source: 'config', entries: ['src/index.ts'] }], families: [{ id: 'widget', contract: 'definitions/widget.family.ts', manifests: 'catalog/widgets/*.item.ts' }] };
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify(config));
  await writeFile(join(root, 'definitions/widget.family.ts'), "import { defineFamily, s } from 'block-beaver/kernel'; export default defineFamily({id:'widget',fields:s.object({}),implementation:['module']});\n");
  const manifest = { id: 'alpha', family: 'widget', version: 1, name: 'Alpha widget', description: 'Fixture widget', rationale: 'A fixture boundary', implementation: { kind: 'module', module: '../../src/index' } };
  await writeFile(join(root, 'catalog/widgets/alpha.item.ts'), `export default ${JSON.stringify(manifest)};\n`);
  await installProject(root, { agents: [], version: '0.3.0', runner });
  const baseline = await readFile(join(root, '.blocks/baseline.json'), 'utf8');
  const index = JSON.stringify([manifest], null, 2) + '\n';
  await writeFile(join(root, '.blocks/index.json'), index);
  await writeFile(join(root, 'src/replacement.ts'), 'export const replacement = true;\n');
  await writeFile(join(root, 'catalog/widgets/alpha.item.ts'), `export default ${JSON.stringify({ ...manifest, name: 'Updated widget', implementation: { kind: 'module', module: '../../src/replacement' } })};\n`);
  const before = await snapshot(root);
  await upgradeProject(root, { version: '0.4.0', dryRun: true, runner });
  assert.deepEqual(await snapshot(root), before);
  await upgradeProject(root, { version: '0.4.0', runner });
  assert.equal(await readFile(join(root, '.blocks/index.json'), 'utf8'), index);
  assert.equal(await readFile(join(root, '.blocks/baseline.json'), 'utf8'), baseline);
  const graph = JSON.parse(await readFile(join(root, '.blocks/view/graph.json'), 'utf8'));
  assert.deepEqual(graph.familyDiagnostics, []);
  assert.ok(graph.edges.some((edge) => edge.from === 'block:widget:alpha' && edge.to === 'file:src/replacement.ts' && edge.kind === 'implemented-by'));
  assert.match(await readFile(join(root, '.blocks/view/index.html'), 'utf8'), /Updated widget/);
  const after = await snapshot(root);
  assert.deepEqual((await upgradeProject(root, { version: '0.4.0', runner })).changed, []);
  assert.deepEqual(await snapshot(root), after);
  await writeFile(join(root, '.blocks/index.json'), JSON.stringify({ schemaVersion: 999, entries: [manifest] }));
  const future = await snapshot(root);
  await assert.rejects(upgradeProject(root, { version: '0.4.0', runner }), /future index/);
  assert.deepEqual(await snapshot(root), future);
});

const commitAll = (root, message) => {
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '--no-verify', '-m', message]);
};
const setupException = /^\.blocks\/exceptions\/block-beaver-setup-[0-9a-f]{12}\.json$/;
const setupExceptions = (files) => Object.keys(files).filter((path) => setupException.test(path));
// Each run records a content-addressed setup exception, so fresh and upgraded trees legitimately differ there.
const withoutSetupExceptions = (files) => Object.fromEntries(Object.entries(withoutScanTime(files)).filter(([path]) => !setupException.test(path)));
const currentVersion = async () => JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

test('upgrading the frozen 0.1.1 init files records a setup exception, passes its audit and matches a fresh install', async (t) => {
  const historical = await installationFixture(t), fresh = await installationFixture(t), version = await currentVersion();
  const fixture = new URL('./fixtures/upgrades/init-0.1.1/', import.meta.url);
  await cp(new URL('AGENTS.md', fixture), join(historical, 'AGENTS.md'));
  await cp(new URL('.blocks/', fixture), join(historical, '.blocks'), { recursive: true });
  commitAll(historical, 'init');
  commitAll(fresh, 'base');
  const options = { version, agents: ['codex'] };
  const upgraded = await upgradeProject(historical, { ...options, runner: packageRunner(historical) });
  await installProject(fresh, { ...options, runner: packageRunner(fresh) });
  assert.equal(upgraded.complete, true, JSON.stringify(upgraded.conflicts));
  assert.equal(upgraded.exception.recorded, true);
  const audit = await auditProject(historical, { mode: 'working' });
  assert.equal(audit.pass, true, JSON.stringify(audit.rules.filter((rule) => !rule.pass)));
  const after = await snapshot(historical), installed = await snapshot(fresh);
  assert.equal(setupExceptions(after).length, 1);
  assert.equal(setupExceptions(installed).length, 1);
  const canonical = (files) => Object.fromEntries(Object.entries(withoutSetupExceptions(files)).map(([path, content]) => [path, typeof content === 'string' ? content.replaceAll('\r\n', '\n') : content]));
  assert.deepEqual(canonical(after), canonical(installed));
});

test('upgrading an earlier install records a new setup exception beside the first and passes its audit', async (t) => {
  const earlier = await installationFixture(t), fresh = await installationFixture(t), version = await currentVersion();
  const options = { agents: ['claude', 'codex'] };
  commitAll(earlier, 'base');
  commitAll(fresh, 'base');
  const first = await installProject(earlier, { ...options, version: '0.3.0', runner: packageRunner(earlier) });
  assert.equal(first.exception.recorded, true);
  commitAll(earlier, 'adopt 0.3.0');
  const upgraded = await upgradeProject(earlier, { ...options, version, runner: packageRunner(earlier) });
  await installProject(fresh, { ...options, version, runner: packageRunner(fresh) });
  assert.equal(upgraded.complete, true, JSON.stringify(upgraded.conflicts));
  assert.equal(upgraded.exception.recorded, true);
  assert.notEqual(upgraded.exception.path, first.exception.path);
  const audit = await auditProject(earlier, { mode: 'working' });
  assert.equal(audit.pass, true, JSON.stringify(audit.rules.filter((rule) => !rule.pass)));
  assert.equal(audit.enforcement.receipts, 'optional');
  const after = await snapshot(earlier);
  assert.equal(setupExceptions(after).length, 2);
  assert.deepEqual(withoutSetupExceptions(after), withoutSetupExceptions(await snapshot(fresh)));
  // A second upgrade changes nothing, so it records nothing.
  const repeat = await upgradeProject(earlier, { ...options, version, runner: packageRunner(earlier) });
  assert.deepEqual(repeat.changed, []);
  assert.equal(repeat.exception, null);
});

test('a 0.4.0 init workflow section without a hash upgrades to the current workflow without a conflict', async (t) => {
  const root = await installationFixture(t), version = await currentVersion();
  const legacy = (await readFile(new URL('../templates/legacy/0.4.0-workflow.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  await mkdir(join(root, '.blocks'));
  // initializeProject wrote the body between plain markers, with no version or hash line.
  await writeFile(join(root, '.blocks/WORKFLOW.md'), `<!-- block-beaver:start -->\n${legacy.trimEnd()}\n<!-- block-beaver:end -->\n`);
  const upgraded = await upgradeProject(root, { version, agents: [], runner: packageRunner(root) });
  assert.deepEqual(upgraded.conflicts, []);
  assert.equal(upgraded.complete, true);
  const workflow = await readFile(join(root, '.blocks/WORKFLOW.md'), 'utf8');
  assert.match(workflow, /## Enforcement levels/);
  assert.match(workflow, /<!-- block-beaver:hash [0-9a-f]{64} -->/);
});

test('editing the 0.4.0 workflow body is still refused without force', async (t) => {
  const root = await installationFixture(t), version = await currentVersion();
  const legacy = (await readFile(new URL('../templates/legacy/0.4.0-workflow.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  await mkdir(join(root, '.blocks'));
  await writeFile(join(root, '.blocks/WORKFLOW.md'), `<!-- block-beaver:start -->\n${legacy.trimEnd()}\nOwner edit.\n<!-- block-beaver:end -->\n`);
  const upgraded = await upgradeProject(root, { version, agents: [], runner: packageRunner(root) });
  assert.ok(upgraded.conflicts.some((conflict) => conflict.path === '.blocks/WORKFLOW.md'));
  assert.equal(upgraded.complete, false);
});
