import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installProject, upgradeProject } from '../src/install.mjs';
import { auditProject } from '../src/compliance.mjs';
import { auditCounts } from '../src/audit-rules.mjs';
import { installationFixture, packageRunner, snapshot } from './helpers/install-fixture.mjs';

test('install selects CI by exact remote host and preserves directory detection', async (t) => {
  const root = await installationFixture(t);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.test/project.git']);
  const cases = [
    ['https://github.com/owner/project.git', 'github'],
    ['ssh://git@github.com:2222/owner/project.git', 'github'],
    ['git@github.com:owner/project.git', 'github'],
    ['git://gitlab.com/owner/project.git', 'gitlab'],
    ['https://user@gitlab.com/owner/project.git', 'gitlab'],
    ['git@gitlab.com:owner/project.git', 'gitlab'],
    ['https://evilgithub.com/owner/project.git', null],
    ['https://github.com.evil.test/project.git', null],
    ['https://example.test/github.com/project.git', null],
    ['git@evilgitlab.com:owner/project.git', null],
    ['https://example.test/gitlab.com/project.git', null],
    ['../github.com/project.git', null],
  ];
  for (const [origin, provider] of cases) {
    execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', origin]);
    const preview = await installProject(root, { version: '0.4.0', agents: [], dryRun: true });
    assert.equal(preview.diff.some(file => file.path === '.github/workflows/block-beaver.yml'), provider === 'github', origin);
    assert.equal(preview.diff.some(file => file.path === '.blocks/ci/gitlab.yml'), provider === 'gitlab', origin);
  }
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.gitlab-ci.yml'), '# owner pipeline\n');
  const preview = await installProject(root, { version: '0.4.0', agents: [], dryRun: true });
  assert.ok(preview.diff.some(file => file.path === '.github/workflows/block-beaver.yml'));
  assert.ok(preview.diff.some(file => file.path === '.blocks/ci/gitlab.yml'));
});

test('install previews complete onboarding without writes or package commands, then installs idempotently', async (t) => {
  const root = await installationFixture(t), calls = [], runner = packageRunner(root, calls);
  await writeFile(join(root, 'AGENTS.md'), '# Owner rules\n');
  const before = await snapshot(root);
  const preview = await installProject(root, { version: '0.3.0', dryRun: true, runner });
  assert.deepEqual(await snapshot(root), before);
  assert.equal(calls.length, 0);
  assert.deepEqual(preview.agents, ['codex']);
  for (const path of ['package.json', 'AGENTS.md', '.blocks/config.json', '.blocks/baseline.json', '.blocks/WORKFLOW.md', '.blocks/view/index.html', '.blocks/view/graph.json']) assert.ok(preview.diff.some((file) => file.path === path), path);
  const installed = await installProject(root, { version: '0.3.0', runner });
  assert.equal(installed.complete, true);
  assert.match(await readFile(join(root, '.git/hooks/pre-commit'), 'utf8'), /block-beaver audit --staged/);
  assert.equal((await stat(join(root, '.git/hooks/pre-commit'))).mode & (process.platform === 'win32' ? 0o200 : 0o111), process.platform === 'win32' ? 0o200 : 0o111);
  const config = JSON.parse(await readFile(join(root, '.blocks/config.json'), 'utf8'));
  assert.equal(config.blockBeaver, '0.3.0');
  assert.deepEqual(config.enforcement, { agents: 'guide', gate: 'audit' });
  assert.deepEqual(JSON.parse(await readFile(join(root, '.blocks/baseline.json'), 'utf8')), { schemaVersion: 1, coverage: 1, resolution: 0 });
  assert.ok((await readFile(join(root, 'AGENTS.md'), 'utf8')).startsWith('# Owner rules\n'));
  const bytes = await snapshot(root);
  const repeated = await installProject(root, { version: '0.3.0', runner });
  assert.deepEqual(repeated.changed, []);
  assert.deepEqual(repeated.commands, []);
  assert.deepEqual(await snapshot(root), bytes);
  assert.equal(calls.length, 1);
});

test('CRLF native hook and state JSON stays current through install, upgrade and audit', async (t) => {
  const root = await installationFixture(t), calls = [], runner = packageRunner(root, calls);
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Read'] }, owner: 'keep me' }, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base']);
  const options = { version, agents: ['claude', 'codex'], runner };
  assert.equal((await installProject(root, options)).complete, true);
  const paths = ['.claude/settings.json', '.codex/hooks.json', '.blocks/managed-files.json'];
  const bytes = new Map();
  for (const path of paths) {
    const content = (await readFile(join(root, path), 'utf8')).replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
    await writeFile(join(root, path), content);
    bytes.set(path, content);
  }
  const managed = await auditProject(root);
  assert.equal(managed.rules.find(rule => rule.id === 'managed-current').pass, true, JSON.stringify(managed.rules));
  for (const action of [installProject, upgradeProject]) {
    const result = await action(root, options);
    assert.equal(result.complete, true, JSON.stringify(result.conflicts));
    assert.deepEqual(result.changed, []);
    for (const path of paths) assert.equal(await readFile(join(root, path), 'utf8'), bytes.get(path));
  }
  assert.equal(calls.length, 1);
  const settings = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  assert.equal(settings.owner, 'keep me');
  settings.hooks.PreToolUse.find(group => group.hooks.some(hook => hook.command.includes('--hook-id block-beaver'))).hooks[0].timeout = 99;
  const edited = JSON.stringify(settings, null, 2).replaceAll('\n', '\r\n') + '\r\n';
  await writeFile(join(root, '.claude/settings.json'), edited);
  const refused = await upgradeProject(root, options);
  assert.equal(refused.complete, false);
  assert.ok(refused.conflicts.some(conflict => conflict.path === '.claude/settings.json' && /Owner edits/.test(conflict.message)));
  assert.equal(await readFile(join(root, '.claude/settings.json'), 'utf8'), edited);
});

test('installer refuses unsafe targets and package failures before installing guidance', async (t) => {
  const root = await installationFixture(t);
  const outside = join(root, 'owner.md');
  await writeFile(outside, 'owner\n');
  await symlink(outside, join(root, 'AGENTS.md'));
  const unsafe = await installProject(root, { agents: ['codex'], version: '0.3.0', runner: packageRunner(root) });
  assert.ok(unsafe.conflicts.some((conflict) => /symlink/.test(conflict.message)));
  assert.equal(unsafe.complete, false);
  await rm(join(root, 'AGENTS.md'));
  const before = await snapshot(root);
  await assert.rejects(installProject(root, { agents: ['codex'], version: '0.3.0', runner: async () => ({ exitCode: 1, stderr: 'network unavailable' }) }), /failed/);
  assert.deepEqual(await snapshot(root), before);
});

test('install preserves owner config and rejects invalid or future config before commands', async (t) => {
  const root = await installationFixture(t), calls = [], runner = packageRunner(root, calls);
  await mkdir(join(root, '.blocks'));
  const config = { schemaVersion: 1, apps: [], ignore: ['custom/**'], owner: { note: 'Keep me' }, enforcement: { agents: 'block' } };
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify(config));
  await installProject(root, { agents: [], version: '0.3.0', runner });
  const installed = JSON.parse(await readFile(join(root, '.blocks/config.json'), 'utf8'));
  assert.deepEqual(installed.owner, config.owner);
  assert.deepEqual(installed.ignore, config.ignore);
  assert.equal(installed.enforcement.agents, 'block');
  for (const invalid of [null, { schemaVersion: 999, apps: [] }]) {
    await writeFile(join(root, '.blocks/config.json'), JSON.stringify(invalid));
    const before = await snapshot(root), count = calls.length;
    await assert.rejects(installProject(root, { agents: [], version: '0.3.0', runner }), /object|future/);
    assert.deepEqual(await snapshot(root), before);
    assert.equal(calls.length, count);
  }
});

test('family onboarding renders typed implementation ownership and initializes the matching coverage baseline', async (t) => {
  const root = await installationFixture(t), calls = [], runner = packageRunner(root, calls);
  await mkdir(join(root, '.blocks'));
  await mkdir(join(root, 'definitions'));
  await mkdir(join(root, 'catalog/widgets'), { recursive: true });
  await writeFile(join(root, 'src/unclaimed.ts'), 'export const unclaimed = true;\n');
  const config = { schemaVersion: 1, apps: [{ id: 'host', root: '.', source: 'config', entries: ['src/index.ts'] }], families: [{ id: 'widget', contract: 'definitions/widget.family.ts', manifests: 'catalog/widgets/*.item.ts' }] };
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify(config));
  await writeFile(join(root, 'definitions/widget.family.ts'), "import { defineFamily, s } from 'block-beaver/kernel'; export default defineFamily({id:'widget',fields:s.object({}),implementation:['module'],map:{title:'Owner widgets'}});\n");
  await writeFile(join(root, 'catalog/widgets/alpha.item.ts'), `export default ${JSON.stringify({ id: 'alpha', family: 'widget', version: 1, name: 'Alpha widget', description: 'Fixture widget', rationale: 'A fixture boundary', implementation: { kind: 'module', module: '../../src/index' } })};\n`);
  const before = await snapshot(root);
  const preview = await installProject(root, { agents: [], version: '0.4.0', dryRun: true, runner });
  assert.deepEqual(await snapshot(root), before);
  assert.match(preview.diff.find((file) => file.path === '.blocks/view/index.html').content, /Owner widgets/);
  const manifestPath = join(root, 'catalog/widgets/alpha.item.ts');
  const manifestBefore = await readFile(manifestPath, 'utf8');
  await writeFile(manifestPath, "export default {id:'alpha',family:'widget',version:1,name:'Invalid',description:'Fixture widget',implementation:{kind:'module',module:'../../src/index'}};\n");
  const invalidBytes = await snapshot(root);
  const invalidPreview = await installProject(root, { agents: [], version: '0.4.0', dryRun: true, runner });
  assert.ok(invalidPreview.diagnostics.some((item) => item.rule === 'manifest-valid'));
  const invalid = await installProject(root, { agents: [], version: '0.4.0', runner });
  assert.equal(invalid.complete, false);
  assert.ok(invalid.conflicts.some((item) => item.kind === 'family'));
  assert.equal(calls.length, 0);
  assert.deepEqual(await snapshot(root), invalidBytes);
  await writeFile(manifestPath, manifestBefore);
  const installed = await installProject(root, { agents: [], version: '0.4.0', runner });
  assert.equal(installed.complete, true);
  const graph = JSON.parse(await readFile(join(root, '.blocks/view/graph.json'), 'utf8'));
  assert.equal(graph.adapter, 'families');
  assert.deepEqual(graph.familyDiagnostics, []);
  assert.ok(graph.edges.some((edge) => edge.from === 'block:widget:alpha' && edge.to === 'file:src/index.ts' && edge.kind === 'implemented-by'));
  const baseline = JSON.parse(await readFile(join(root, '.blocks/baseline.json'), 'utf8'));
  assert.deepEqual(baseline, { schemaVersion: 1, ...auditCounts(graph) });
  assert.equal(baseline.coverage, 1);
});
