import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installProject, upgradeProject } from '../src/install.mjs';
import { auditProject } from '../src/compliance.mjs';
import { initializeProject } from '../src/project-integration.mjs';
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

test('upgrade lowers the baseline after an ignore entry, reports it in the plan and never raises it', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await mkdir(join(root, 'src/legacy'), { recursive: true });
  await writeFile(join(root, 'src/legacy/one.ts'), 'export const one = 1;\n');
  await writeFile(join(root, 'src/legacy/two.ts'), 'export const two = 2;\n');
  await installProject(root, { agents: [], version: '0.3.0', runner });
  const initial = JSON.parse(await readFile(join(root, '.blocks/baseline.json'), 'utf8'));
  const configPath = join(root, '.blocks/config.json');
  await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, 'utf8')), ignore: ['src/legacy/**'] }, null, 2) + '\n');
  const before = await snapshot(root);
  const preview = await upgradeProject(root, { version: '0.4.0', dryRun: true, runner });
  assert.deepEqual(preview.baseline.lowered, { coverage: { from: initial.coverage, to: initial.coverage - 2 } });
  assert.ok(preview.diff.some((file) => file.path === '.blocks/baseline.json'));
  assert.deepEqual(await snapshot(root), before, 'Dry run writes nothing.');
  const upgraded = await upgradeProject(root, { version: '0.4.0', runner });
  assert.ok(upgraded.changed.includes('.blocks/baseline.json'));
  assert.deepEqual(JSON.parse(await readFile(join(root, '.blocks/baseline.json'), 'utf8')), { ...initial, coverage: initial.coverage - 2 });
  await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, 'utf8')), ignore: [] }, null, 2) + '\n');
  const restored = await upgradeProject(root, { version: '0.4.0', runner });
  assert.deepEqual(restored.baseline.lowered, {});
  assert.equal(restored.changed.includes('.blocks/baseline.json'), false);
  assert.equal(JSON.parse(await readFile(join(root, '.blocks/baseline.json'), 'utf8')).coverage, initial.coverage - 2, 'Removing the ignore entry never raises the baseline.');
});

test('a 0.6.0 hash-trusted hook and CI workflow are rewritten to the summary format without a conflict', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/workflows/ci.yml'), 'on: push\n');
  await installProject(root, { agents: ['codex'], version: '0.6.0', runner });
  await upgradeProject(root, { version: '0.6.0', runner }); // the runner's lockfile now exists, so the CI install command settles
  const paths = ['.git/hooks/pre-commit', '.github/workflows/block-beaver.yml'];
  // The 0.6.0 bytes differ only by the missing flag, and the managed-region hash covers the region without its hash line.
  const rehash = (text) => text.replace(/(# block-beaver:start\n)(# block-beaver:hash )[0-9a-f]{64}\n([\s\S]*?# block-beaver:end\n)/, (_, start, label, rest) => `${start}${label}${createHash('sha256').update(start + rest).digest('hex')}\n${rest}`);
  const current = {};
  for (const path of paths) {
    current[path] = await readFile(join(root, path), 'utf8');
    assert.equal(rehash(current[path]), current[path], `${path} hash helper matches the real hash`);
    assert.match(current[path], /--format summary/);
    const old = rehash(current[path].replaceAll(' --format summary', ''));
    assert.ok(!old.includes('--format summary') && old !== current[path]);
    await writeFile(join(root, path), old);
  }
  const upgraded = await upgradeProject(root, { version: '0.6.0', runner });
  assert.deepEqual(upgraded.conflicts, []);
  assert.equal(upgraded.complete, true);
  for (const path of paths) assert.equal(await readFile(join(root, path), 'utf8'), current[path], path);
  const repeat = await upgradeProject(root, { version: '0.6.0', runner });
  assert.deepEqual(repeat.conflicts, []);
  assert.deepEqual(repeat.changed, []);
});

test('an owner edit inside a 0.6.0 hook region still conflicts instead of being rewritten', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await installProject(root, { agents: ['codex'], version: '0.6.0', runner });
  const hook = join(root, '.git/hooks/pre-commit');
  const edited = (await readFile(hook, 'utf8')).replace(' --format summary', '').replace('# block-beaver:end', 'echo owner\n# block-beaver:end');
  await writeFile(hook, edited);
  const upgraded = await upgradeProject(root, { version: '0.6.0', runner });
  assert.ok(upgraded.conflicts.some((conflict) => conflict.code === 'managed-edited' && conflict.path === '.git/hooks/pre-commit'));
  assert.equal(await readFile(hook, 'utf8'), edited);
});


test('init and start leave an installed, hash-trusted hook and CI workflow alone, so upgrade stays conflict-free', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/workflows/ci.yml'), 'on: push\n');
  await installProject(root, { agents: ['codex'], version: '0.7.0', runner });
  commitAll(root, 'base');
  const paths = ['.git/hooks/pre-commit', '.github/workflows/block-beaver.yml'];
  const installed = {};
  for (const path of paths) installed[path] = await readFile(join(root, path), 'utf8');
  assert.match(installed[paths[0]], /audit --staged --format summary --root \./);
  await initializeProject(root, { editor: 'agents' });
  for (const path of paths) assert.equal(await readFile(join(root, path), 'utf8'), installed[path], path);
  const upgraded = await upgradeProject(root, { version: '0.7.0', runner });
  assert.deepEqual(upgraded.conflicts, []);
  assert.match(await readFile(join(root, paths[0]), 'utf8'), /audit --staged --format summary/);
});

test('a plain init writes the summary-format hook and CI audit commands', async (t) => {
  const root = await installationFixture(t);
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/workflows/ci.yml'), 'on: push\n');
  commitAll(root, 'base');
  const result = await initializeProject(root, { editor: 'agents' });
  assert.equal(result.enforcement.hook.status, 'installed', JSON.stringify(result.enforcement));
  assert.match(await readFile(join(root, '.git/hooks/pre-commit'), 'utf8'), /block-beaver audit --staged --format summary --root \. \|\| exit \$\?/);
  assert.match(await readFile(join(root, '.github/workflows/block-beaver.yml'), 'utf8'), /audit --root \. --base "[^"]+" --format summary\n/);
});

// Rebuilds the managed region of an installed file with another line ending or indent and a hash that matches those bytes.
function restamp(text, { indent = '', eol = '\n' }) {
  const lines = text.split('\n'), start = lines.findIndex((line) => line.trim() === '# block-beaver:start'), stop = lines.findIndex((line) => line.trim() === '# block-beaver:end');
  const region = lines.slice(start, stop + 1).filter((line) => !line.includes('block-beaver:hash')).map((line) => indent + line);
  const hash = createHash('sha256').update(region.map((line) => line + eol).join('')).digest('hex');
  return lines.slice(0, start).map((line) => line + eol).join('') + region[0] + eol + `${indent}# block-beaver:hash ${hash}${eol}` + region.slice(1).map((line) => line + eol).join('') + lines.slice(stop + 1).join(eol);
}
const owned = {
  // install-host's CI adoption needs the marker line to end in LF, so an intact CRLF workflow is a ci-collision on upgrade, as before.
  crlf: { change: (text) => restamp(text, { eol: '\r\n' }), conflicts: 0, ci: 'ci-collision' },
  indented: { change: (text) => restamp(text, { indent: '  ' }), conflicts: 0 },
  'malformed hash': { change: (text) => text.replace(/block-beaver:hash [0-9a-f]{64}/, 'block-beaver:hash not-a-digest'), conflicts: 1 },
  'edited body': { change: (text) => text.replace('# block-beaver:end', '# owner edit\n# block-beaver:end'), conflicts: 1 },
};

for (const [name, { change, conflicts, ci }] of Object.entries(owned)) {
  test(`init leaves an installer-owned hook and CI workflow alone when the region is ${name}, and upgrade behaves as before`, async (t) => {
    const root = await installationFixture(t), runner = packageRunner(root);
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    await writeFile(join(root, '.github/workflows/ci.yml'), 'on: push\n');
    await installProject(root, { agents: ['codex'], version: '0.7.0', runner });
    commitAll(root, 'base');
    const paths = ['.git/hooks/pre-commit', '.github/workflows/block-beaver.yml'], changed = {};
    for (const path of paths) { changed[path] = change(await readFile(join(root, path), 'utf8')); await writeFile(join(root, path), changed[path]); }
    const result = await initializeProject(root, { editor: 'agents' });
    assert.equal(result.enforcement.hook.changed, false, JSON.stringify(result.enforcement.hook));
    for (const path of paths) assert.equal(await readFile(join(root, path), 'utf8'), changed[path], path);
    const upgraded = await upgradeProject(root, { version: '0.7.0', runner });
    assert.deepEqual(upgraded.conflicts.filter((conflict) => paths.includes(conflict.path)).map((conflict) => `${conflict.code}:${conflict.path}`).sort(),
      conflicts ? paths.map((path) => `managed-edited:${path}`).sort() : ci ? [`${ci}:${paths[1]}`] : []);
    if (!conflicts) for (const path of ci ? paths.slice(0, 1) : paths) assert.match(await readFile(join(root, path), 'utf8'), /audit (--staged --format summary|--base merge-base --strict --format summary)/);
  });
}

test('init leaves a GitLab job file and include region with a malformed hash alone', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await writeFile(join(root, '.gitlab-ci.yml'), 'stages:\n  - test\n');
  await installProject(root, { agents: ['codex'], version: '0.7.0', runner });
  commitAll(root, 'base');
  const paths = ['.blocks/ci/gitlab.yml', '.gitlab-ci.yml'], changed = {};
  for (const path of paths) { changed[path] = (await readFile(join(root, path), 'utf8')).replace(/block-beaver:hash [0-9a-f]{64}/, 'block-beaver:hash bad'); await writeFile(join(root, path), changed[path]); assert.match(changed[path], /hash bad/); }
  await initializeProject(root, { editor: 'agents' });
  for (const path of paths) assert.equal(await readFile(join(root, path), 'utf8'), changed[path], path);
});

test('init never overwrites a CI file or hook with ambiguous markers', async (t) => {
  const root = await installationFixture(t);
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  const workflow = '# block-beaver:managed-ci\n# block-beaver:start\n# block-beaver:start\nname: x\n# block-beaver:end\n';
  await writeFile(join(root, '.github/workflows/block-beaver.yml'), workflow);
  commitAll(root, 'base');
  const hook = join(root, '.git/hooks/pre-commit'), owner = '#!/bin/sh\n# block-beaver:start\necho one\n# block-beaver:end\n# block-beaver:end\n';
  await writeFile(hook, owner, { mode: 0o755 });
  const result = await initializeProject(root, { editor: 'agents' });
  assert.equal(result.enforcement.hook.status, 'incomplete');
  assert.equal(result.enforcement.ci.github.status, 'incomplete');
  assert.equal(await readFile(hook, 'utf8'), owner);
  assert.equal(await readFile(join(root, '.github/workflows/block-beaver.yml'), 'utf8'), workflow);
});

const familyFiles = async (root, extra = {}) => {
  await mkdir(join(root, 'definitions'), { recursive: true });
  await mkdir(join(root, 'catalog/widgets'), { recursive: true });
  await writeFile(join(root, 'definitions/widget.family.ts'), "import { defineFamily, s } from 'block-beaver/kernel'; export default defineFamily({id:'widget',fields:s.object({}),implementation:['module'],generators:['registry']});\n");
  await writeFile(join(root, 'catalog/widgets/alpha.item.ts'), `export default ${JSON.stringify({ id: 'alpha', family: 'widget', version: 1, name: 'Alpha', description: 'Fixture', rationale: 'Fixture', implementation: { kind: 'module', module: '../../src/index' } })};\n`);
  const path = join(root, '.blocks/config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...config, families: [{ id: 'widget', contract: 'definitions/widget.family.ts', manifests: 'catalog/widgets/*.item.ts', registry: { out: 'src/widgets.generated.ts' } }], ...extra }, null, 2) + '\n');
};
const managedCurrent = (audit) => audit.rules.find((rule) => rule.id === 'managed-current');

test('families config renders guidance on upgrade, rewriting only the managed region', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root), version = await currentVersion();
  await installProject(root, { agents: ['codex', 'claude'], version, runner });
  commitAll(root, 'install');
  const plain = await snapshot(root);
  assert.ok(!plain['AGENTS.md'].includes('Typed families'));
  await writeFile(join(root, 'AGENTS.md'), `Owner intro\n\n${plain['AGENTS.md']}\nOwner outro\n`);
  await familyFiles(root, { enforcement: { receipts: 'optional' } });
  const audit = await auditProject(root, { mode: 'working' });
  const rule = managedCurrent(audit);
  assert.equal(rule.pass, true);
  assert.ok(rule.advisories.some((entry) => entry.severity === 'warning' && entry.message === 'run `block-beaver upgrade`'));
  await upgradeProject(root, { version, runner });
  const after = await snapshot(root);
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.blocks/WORKFLOW.md', '.claude/skills/block-beaver/SKILL.md', '.agents/skills/block-beaver/SKILL.md']) {
    assert.match(after[path], /\| `widget` \| `catalog\/widgets\/\*\.item\.ts` \| `definitions\/widget\.family\.ts` \|/, path);
    assert.match(after[path], /block-beaver gen/);
    assert.match(after[path], /typed-family manifests are reviewed in the pull request/);
  }
  assert.ok(after['AGENTS.md'].startsWith('Owner intro\n\n') && after['AGENTS.md'].endsWith('\nOwner outro\n'));
  assert.equal(after['.blocks/WORKFLOW.md'].replace(/\n*<!-- block-beaver:families:start -->[\s\S]*?<!-- block-beaver:families:end -->\n?/, '\n').replace(/<!-- block-beaver:hash [a-f0-9]{64} -->\n/, ''), plain['.blocks/WORKFLOW.md'].replace(/<!-- block-beaver:hash [a-f0-9]{64} -->\n/, ''));
  assert.equal(managedCurrent(await auditProject(root, { mode: 'working' })).advisories.some((entry) => entry.code === 'managed-families-stale'), false);
  assert.deepEqual((await upgradeProject(root, { version, runner })).changed, []);
});

test('an edited managed section still fails managed-current when the families config also changed', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root), version = await currentVersion();
  await installProject(root, { agents: ['codex'], version, runner });
  commitAll(root, 'install');
  await familyFiles(root);
  const text = await readFile(join(root, 'AGENTS.md'), 'utf8');
  await writeFile(join(root, 'AGENTS.md'), text.replace('Report affected blocks', 'Report all affected blocks'));
  const rule = managedCurrent(await auditProject(root, { mode: 'working' }));
  assert.equal(rule.pass, false);
  assert.ok(rule.findings.some((finding) => finding.path === 'AGENTS.md'));
});

test('update hints that family outputs are stale only when families are configured and drifted', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const cli = new URL('../bin/block-beaver.mjs', import.meta.url).pathname;
  const run = (root) => JSON.parse(spawnSync(process.execPath, [cli, 'update', '--root', root], { encoding: 'utf8' }).stdout);
  const root = await installationFixture(t), runner = packageRunner(root), version = await currentVersion();
  await installProject(root, { agents: [], version, runner });
  assert.equal('hint' in run(root), false);
  await familyFiles(root);
  assert.match(run(root).hint, /family outputs are stale; run block-beaver gen/);
  const gen = spawnSync(process.execPath, [cli, 'gen', '--root', root], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stdout + gen.stderr);
  assert.equal('hint' in run(root), false);
});
