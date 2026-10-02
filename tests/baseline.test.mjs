import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installProject } from '../src/install.mjs';
import { auditProject } from '../src/compliance.mjs';
import { lowerBaseline, planBaselineLowering } from '../src/baseline.mjs';
import { installationFixture, packageRunner, snapshot } from './helpers/install-fixture.mjs';

const cliPath = fileURLToPath(new URL('../bin/block-beaver.mjs', import.meta.url));
const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test'];
const commitAll = (root, message) => {
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, ...identity, 'commit', '-q', '--no-verify', '-m', message]);
};
const currentVersion =async () => JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const readBaseline = async (root) => JSON.parse(await readFile(join(root, '.blocks/baseline.json'), 'utf8'));
const editConfig = async (root, change) => {
  const path = join(root, '.blocks/config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  change(config);
  await writeFile(path, JSON.stringify(config, null, 2) + '\n');
};

async function installedWithLegacy(t) {
  const root = await installationFixture(t);
  await mkdir(join(root, 'src/legacy'), { recursive: true });
  await writeFile(join(root, 'src/legacy/one.ts'), 'export const one = 1;\n');
  await writeFile(join(root, 'src/legacy/two.ts'), 'export const two = 2;\n');
  const installed = await installProject(root, { version: await currentVersion(), agents: [], runner: packageRunner(root) });
  assert.equal(installed.complete, true, JSON.stringify(installed.conflicts));
  commitAll(root, 'adopt');
  return root;
}

test('planBaselineLowering only lowers ratchet counts, keeps zero keys and lint allowances', () => {
  const before = JSON.stringify({ schemaVersion: 1, coverage: 4, resolution: 0, lint: { 'no-block-id-literal': { 'src/a.ts': 2 } } }, null, 2) + '\n';
  const lowered = planBaselineLowering(before, { coverage: 1, resolution: 3 });
  assert.deepEqual(JSON.parse(lowered.file.content), { schemaVersion: 1, coverage: 1, resolution: 0, lint: { 'no-block-id-literal': { 'src/a.ts': 2 } } });
  assert.deepEqual(lowered.lowered, { coverage: { from: 4, to: 1 } });
  assert.equal(lowered.file.before, before);
  const unchanged = planBaselineLowering(before, { coverage: 9, resolution: 9 });
  assert.equal(unchanged.file.content, before, 'Increases are never recorded.');
  assert.deepEqual(unchanged.lowered, {});
  assert.equal(planBaselineLowering(null, { coverage: 0, resolution: 0 }), null);
  assert.throws(() => planBaselineLowering('{"schemaVersion":2,"coverage":1,"resolution":0}', { coverage: 0, resolution: 0 }), /Unsupported/);
  assert.throws(() => planBaselineLowering('{', { coverage: 0, resolution: 0 }), /Invalid JSON/);
});

test('baseline --lower records the drop after an ignore entry, respects dry-run and never rises', async (t) => {
  const root = await installedWithLegacy(t);
  const initial = await readBaseline(root);
  assert.ok(initial.coverage >= 2, JSON.stringify(initial));
  await editConfig(root, (config) => { config.ignore = ['src/legacy/**']; });
  const before = await snapshot(root);
  const preview = await lowerBaseline(root, { dryRun: true });
  assert.deepEqual(preview.lowered, { coverage: { from: initial.coverage, to: initial.coverage - 2 } });
  assert.equal(preview.changed, true);
  assert.equal(preview.written, false);
  assert.deepEqual(await snapshot(root), before, 'Dry run writes nothing.');
  const applied = await lowerBaseline(root);
  assert.equal(applied.written, true);
  assert.deepEqual(await readBaseline(root), { ...initial, coverage: initial.coverage - 2 });
  // Growth after lowering is a ratchet failure, never a new baseline.
  await writeFile(join(root, 'src/added.ts'), 'export const added = 1;\n');
  const again = await lowerBaseline(root);
  assert.equal(again.changed, false);
  assert.deepEqual(again.lowered, {});
  assert.deepEqual(await readBaseline(root), { ...initial, coverage: initial.coverage - 2 });
  const audit = await auditProject(root);
  assert.equal(audit.rules.find((rule) => rule.id === 'coverage-ratchet').pass, false);
});

test('the baseline CLI requires --lower, reports a summary and fails without a baseline', async (t) => {
  const root = await installedWithLegacy(t);
  await editConfig(root, (config) => { config.ignore = ['src/legacy/one.ts']; });
  assert.throws(() => execFileSync(process.execPath, [cliPath, 'baseline', '--root', root], { stdio: 'pipe' }), (error) => /baseline --lower/.test(String(error.stderr)));
  const preview = JSON.parse(execFileSync(process.execPath, [cliPath, 'baseline', '--lower', '--dry-run', '--root', root]).toString());
  assert.equal(preview.dryRun, true);
  assert.equal(preview.lowered.coverage.to, preview.lowered.coverage.from - 1);
  const applied = JSON.parse(execFileSync(process.execPath, [cliPath, 'baseline', '--lower', '--root', root]).toString());
  assert.equal(applied.written, true);
  assert.equal((await readBaseline(root)).coverage, applied.lowered.coverage.to);
  const bare = await installationFixture(t);
  assert.throws(() => execFileSync(process.execPath, [cliPath, 'baseline', '--lower', '--root', bare], { stdio: 'pipe' }), (error) => /No \.blocks\/baseline\.json/.test(String(error.stderr)));
});

test('a lowered baseline commits through the receipts-required staged audit', async (t) => {
  const root = await installedWithLegacy(t);
  await editConfig(root, (config) => { config.enforcement = { ...config.enforcement, receipts: 'required' }; });
  commitAll(root, 'require receipts');
  await editConfig(root, (config) => { config.ignore = ['src/legacy/**']; });
  // The owner's config edit is reviewed separately; the lowered baseline is covered by its setup exception.
  await lowerBaseline(root);
  execFileSync('git', ['-C', root, 'add', '.blocks/baseline.json', '.blocks/exceptions']);
  const staged = await auditProject(root, { mode: 'staged' });
  const reviewed = staged.rules.find((rule) => rule.id === 'reviewed-content');
  assert.equal(reviewed.findings.some((entry) => entry.path === '.blocks/baseline.json'), false, JSON.stringify(reviewed));
  assert.equal(staged.files.find((file) => file.path === '.blocks/baseline.json').status, 'verified-exception');
});
