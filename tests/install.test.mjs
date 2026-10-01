import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, symlink, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installProject, upgradeProject } from '../src/install.mjs';
import { auditProject, recordException } from '../src/compliance.mjs';
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
  assert.deepEqual(config.enforcement, { agents: 'guide', gate: 'audit', receipts: 'optional' });
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

const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test'];
const commit = (root, message, env = process.env) => execFileSync('git', ['-C', root, ...identity, 'commit', '-qm', message], { env, stdio: 'pipe' });
const cliPath = fileURLToPath(new URL('../bin/block-beaver.mjs', import.meta.url));
const currentVersion = async () => JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const rule = (audit, id) => audit.rules.find((entry) => entry.id === id);

// The hook runs `npx --no-install block-beaver ...`; stand in for the host's local binary.
async function shimmedPath(root) {
  const bin = join(root, '..', 'shim-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'npx'), `#!/bin/sh\nshift 2\nexec "${process.execPath}" "${cliPath}" "$@"\n`);
  await chmod(join(bin, 'npx'), 0o755);
  return `${bin}:${process.env.PATH}`;
}

for (const fixIgnores of [false, true]) {
  test(`a fresh install passes its own audit and its first commit${fixIgnores ? ' with --fix-ignores' : ''}`, { skip: process.platform === 'win32' }, async (t) => {
    const root = await installationFixture(t), version = await currentVersion();
    execFileSync('git', ['-C', root, 'add', '.']);
    commit(root, 'base');
    const installed = await installProject(root, { version, agents: ['claude', 'codex'], fixIgnores, runner: packageRunner(root) });
    assert.equal(installed.complete, true, JSON.stringify(installed.conflicts));
    const working = await auditProject(root, { mode: 'working' });
    assert.equal(working.pass, true, JSON.stringify(working.rules.filter((entry) => !entry.pass)));
    assert.equal(rule(working, 'reviewed-content').pass, true);
    assert.equal(installed.exception.recorded, true);
    assert.match(installed.exception.path, /^\.blocks\/exceptions\/block-beaver-setup-[0-9a-f]{12}\.json$/);
    execFileSync('git', ['-C', root, 'add', '-A']);
    const staged = await auditProject(root, { mode: 'staged' });
    assert.equal(staged.pass, true, JSON.stringify(staged.rules.filter((entry) => !entry.pass)));
    assert.equal(rule(staged, 'reviewed-content').pass, true);
    // The real pre-commit hook runs the same audit, so the adoption commit must succeed.
    commit(root, 'adopt block beaver', { ...process.env, PATH: await shimmedPath(root) });
    assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain']).toString().trim(), '');
  });
}

test('the setup exception satisfies owner-required receipts on a fresh install', async (t) => {
  const root = await installationFixture(t), version = await currentVersion();
  await mkdir(join(root, '.blocks'));
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], enforcement: { receipts: 'required' } }));
  execFileSync('git', ['-C', root, 'add', '.']);
  commit(root, 'base');
  const installed = await installProject(root, { version, agents: ['claude', 'codex'], runner: packageRunner(root) });
  assert.equal(installed.enforcement.receipts, 'required');
  const audit = await auditProject(root, { mode: 'working' });
  assert.equal(audit.pass, true, JSON.stringify(audit.rules.filter((entry) => !entry.pass)));
  assert.equal(audit.enforcement.receipts, 'required');
  assert.equal(rule(audit, 'reviewed-content').advisories, undefined);
  assert.ok(audit.files.length > 5 && audit.files.every((file) => file.status === 'verified-exception'));
});

async function installedFixture(t) {
  const root = await installationFixture(t), version = await currentVersion();
  execFileSync('git', ['-C', root, 'add', '.']);
  commit(root, 'base');
  const installed = await installProject(root, { version, agents: ['claude', 'codex'], runner: packageRunner(root) });
  return { root, installed };
}
const editConfig = async (root, edit) => {
  const path = join(root, '.blocks/config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  edit(config);
  await writeFile(path, JSON.stringify(config, null, 2) + '\n');
};
const configFile = (audit) => audit.files.find((file) => file.path === '.blocks/config.json');

test('a config edit after install is owner-controlled: advisory under optional receipts', async (t) => {
  const { root, installed } = await installedFixture(t);
  assert.equal(installed.enforcement.receipts, 'optional');
  await editConfig(root, (config) => { config.ignore = ['dist/**']; });
  const audit = await auditProject(root, { mode: 'working' });
  assert.equal(audit.enforcement.receipts, 'optional');
  assert.equal(audit.pass, true, JSON.stringify(audit.rules.filter((entry) => !entry.pass)));
  assert.equal(configFile(audit).status, 'missing-exception');
  assert.ok(rule(audit, 'reviewed-content').advisories.some((entry) => entry.path === '.blocks/config.json'));
  assert.equal(rule(audit, 'config-valid').pass, true);
});

test('a config edit after install needs evidence only when receipts are required', async (t) => {
  const { root } = await installedFixture(t);
  await editConfig(root, (config) => { config.enforcement.receipts = 'required'; });
  const audit = await auditProject(root, { mode: 'working' });
  assert.equal(audit.enforcement.receipts, 'required');
  assert.equal(audit.pass, false);
  const reviewed = rule(audit, 'reviewed-content');
  assert.equal(reviewed.pass, false);
  assert.deepEqual(reviewed.findings, [{ path: '.blocks/config.json', message: 'missing-exception' }]);
  // Only config is flagged; the setup exception still covers every other installed file.
  assert.ok(audit.files.filter((file) => file.path !== '.blocks/config.json').every((file) => file.status === 'verified-exception'));
  // An owner exception for the edit satisfies the requirement.
  await recordException(root, 'owner-config-review', { reason: 'Owner config edit', paths: ['.blocks/config.json'], check: 'node --version' });
  const covered = await auditProject(root, { mode: 'working' });
  assert.equal(configFile(covered).status, 'verified-exception');
  assert.equal(covered.pass, true, JSON.stringify(covered.rules.filter((entry) => !entry.pass)));
});

test('an invalid config edit after install fails config-valid', async (t) => {
  const { root } = await installedFixture(t);
  await editConfig(root, (config) => { config.enforcement.receipts = 'sometimes'; });
  const audit = await auditProject(root, { mode: 'working' });
  assert.equal(audit.pass, false);
  assert.equal(rule(audit, 'config-valid').pass, false);
});

test('an existing 0.5.0 setup exception that covers config no longer goes stale on a config edit', async (t) => {
  const { root, installed } = await installedFixture(t);
  const exception = JSON.parse(await readFile(join(root, installed.exception.path), 'utf8'));
  // The 0.5.0 shape: a managed setup exception whose paths include the config as install wrote it.
  assert.ok(exception.paths.some((entry) => entry.path === '.blocks/config.json'));
  assert.equal(exception.verification[0].command, 'Block Beaver managed setup');
  assert.equal(configFile(await auditProject(root, { mode: 'working' })).status, 'verified-exception');
  await editConfig(root, (config) => { config.ignore = ['coverage/**']; config.enforcement.gate = 'audit'; });
  const audit = await auditProject(root, { mode: 'working' });
  assert.notEqual(configFile(audit).status, 'changed-after-review');
  assert.equal(audit.pass, true, JSON.stringify(audit.rules.filter((entry) => !entry.pass)));
  assert.equal(rule(audit, 'reviewed-content').findings.length, 0);
});

test('editing a managed file after install makes the setup exception stale and the audit fails', async (t) => {
  const root = await installationFixture(t), version = await currentVersion();
  execFileSync('git', ['-C', root, 'add', '.']);
  commit(root, 'base');
  await installProject(root, { version, agents: ['claude', 'codex'], runner: packageRunner(root) });
  assert.equal((await auditProject(root, { mode: 'working' })).pass, true);
  await writeFile(join(root, 'AGENTS.md'), (await readFile(join(root, 'AGENTS.md'), 'utf8')) + '\nOwner note.\n');
  const audit = await auditProject(root, { mode: 'working' });
  assert.equal(audit.files.find((file) => file.path === 'AGENTS.md').status, 'changed-after-review');
  assert.equal(audit.pass, false);
});

test('install without a committed base still succeeds and reports the setup exception as incomplete', async (t) => {
  const root = await installationFixture(t), version = await currentVersion();
  const installed = await installProject(root, { version, agents: ['codex'], runner: packageRunner(root) });
  assert.equal(installed.complete, true);
  assert.equal(installed.exception.status, 'incomplete');
  assert.ok(installed.exception.reason);
});

test('install writes optional receipts for a fresh adoption and says which level gates commits', async (t) => {
  const root = await installationFixture(t), version = await currentVersion();
  const preview = await installProject(root, { version, agents: [], dryRun: true });
  assert.deepEqual(preview.enforcement, { agents: 'guide', gate: 'audit', receipts: 'optional' });
  assert.match(preview.gate, /review receipts are optional/);
  const installed = await installProject(root, { version, agents: [], runner: packageRunner(root) });
  assert.deepEqual(JSON.parse(await readFile(join(root, '.blocks/config.json'), 'utf8')).enforcement, { agents: 'guide', gate: 'audit', receipts: 'optional' });
  assert.deepEqual(installed.enforcement, { agents: 'guide', gate: 'audit', receipts: 'optional' });
});

test('upgrade of an existing install leaves a config without receipts on the required default', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await installProject(root, { version: '0.4.0', agents: [], runner });
  const path = join(root, '.blocks/config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  delete config.enforcement.receipts;
  await writeFile(path, JSON.stringify(config, null, 2) + '\n');
  const upgraded = await upgradeProject(root, { version: '0.5.0', agents: [], runner });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).enforcement.receipts, undefined);
  assert.equal(upgraded.enforcement.receipts, 'required');
  assert.match(upgraded.gate, /review receipts are required/);
});

test('install refuses an invalid enforcement.receipts value before writing anything', async (t) => {
  const root = await installationFixture(t), calls = [], runner = packageRunner(root, calls);
  await mkdir(join(root, '.blocks'));
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], enforcement: { receipts: 'maybe' } }));
  const before = await snapshot(root);
  await assert.rejects(installProject(root, { agents: [], version: '0.5.0', runner }), /receipts must be required, optional, or off/);
  assert.deepEqual(await snapshot(root), before);
  assert.equal(calls.length, 0);
});

for (const [receipts, blocked] of [['optional', false], ['required', true]]) {
  test(`the real pre-commit hook follows enforcement.receipts ${receipts} for unreviewed source`, { skip: process.platform === 'win32' }, async (t) => {
    const root = await installationFixture(t), version = await currentVersion();
    await mkdir(join(root, '.blocks'));
    await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], enforcement: { receipts } }));
    execFileSync('git', ['-C', root, 'add', '.']);
    commit(root, 'base');
    assert.equal((await installProject(root, { version, agents: [], runner: packageRunner(root) })).complete, true);
    const env = { ...process.env, PATH: await shimmedPath(root) };
    execFileSync('git', ['-C', root, 'add', '-A']);
    commit(root, 'adopt', env);
    await writeFile(join(root, 'src/index.ts'), 'export const ready = false;\n');
    // The hook command is unchanged; it reads the configured level through audit.
    execFileSync(process.execPath, [cliPath, 'update', '--root', root], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'add', '-A']);
    if (blocked) assert.throws(() => commit(root, 'unreviewed', env), (error) => /reviewed-content|unreviewed-source/.test(`${error.stdout}${error.stderr}`));
    else {
      commit(root, 'unreviewed', env);
      assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain']).toString().trim(), '');
    }
  });
}

test('structural rules still gate commits when receipts are off', async (t) => {
  const root = await installationFixture(t), version = await currentVersion();
  await mkdir(join(root, '.blocks'));
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], enforcement: { receipts: 'off' } }));
  execFileSync('git', ['-C', root, 'add', '.']);
  commit(root, 'base');
  await installProject(root, { version, agents: ['codex'], runner: packageRunner(root) });
  const clean = await auditProject(root, { mode: 'working' });
  assert.equal(clean.pass, true, JSON.stringify(clean.rules.filter((entry) => !entry.pass)));
  assert.equal(rule(clean, 'reviewed-content').skipped, true);
  await writeFile(join(root, 'src/index.ts'), 'export const ready = false;\n');
  await writeFile(join(root, '.blocks/WORKFLOW.md'), 'owner rewrite\n');
  const audit = await auditProject(root, { mode: 'working' });
  assert.equal(audit.pass, false);
  assert.deepEqual(audit.rules.filter((entry) => !entry.pass).map((entry) => entry.id).sort(), ['managed-current', 'view-fresh']);
});

test('ignored managed paths are local-only: staged audits advise, working audits still check them', { skip: process.platform === 'win32' }, async (t) => {
  const root = await installationFixture(t), version = await currentVersion();
  await writeFile(join(root, '.gitignore'), '.claude\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  commit(root, 'base');
  const installed = await installProject(root, { version, agents: ['claude'], runner: packageRunner(root) });
  assert.equal(installed.complete, true, JSON.stringify(installed.conflicts));
  const warning = installed.diagnostics.find((entry) => entry.code === 'ignored-target' && entry.path === '.claude/settings.json');
  assert.ok(warning, 'install still warns about the ignored target');
  assert.match(warning.message, /pre-commit and CI audits cannot see/);
  assert.match(warning.message, /--fix-ignores/);
  assert.match(warning.remediation, /--fix-ignores/);
  assert.ok(await readFile(join(root, '.claude/settings.json'), 'utf8'));
  execFileSync('git', ['-C', root, 'add', '-A']);
  assert.equal(execFileSync('git', ['-C', root, 'ls-files', '.claude']).toString().trim(), '');
  const staged = await auditProject(root, { mode: 'staged' });
  assert.equal(staged.pass, true, JSON.stringify(staged.rules.filter((entry) => !entry.pass)));
  const current = rule(staged, 'managed-current');
  assert.equal(current.pass, true);
  const local = current.advisories.filter((entry) => entry.code === 'ignored-managed-local');
  assert.ok(local.some((entry) => entry.path === '.claude/settings.json'), JSON.stringify(current.advisories));
  assert.match(local[0].message, /ignored by git/);
  assert.match(local[0].remediation, /--fix-ignores/);
  // The real hook runs the staged audit, so the adoption commit succeeds.
  const baseHash = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  commit(root, 'adopt block beaver', { ...process.env, PATH: await shimmedPath(root) });
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain']).toString().trim(), '');
  const range = await auditProject(root, { mode: 'range', base: baseHash });
  assert.equal(rule(range, 'managed-current').pass, true, JSON.stringify(rule(range, 'managed-current').findings));
  assert.ok(rule(range, 'managed-current').advisories.some((entry) => entry.code === 'ignored-managed-local'));
  // Working mode is unchanged: the local file exists and is checked.
  assert.equal(rule(await auditProject(root, { mode: 'working' }), 'managed-current').pass, true);
  const settings = join(root, '.claude/settings.json');
  await writeFile(settings, (await readFile(settings, 'utf8')).replace('{', '{ "owner": true,'));
  const edited = await auditProject(root, { mode: 'working' });
  assert.equal(rule(edited, 'managed-current').pass, false);
  assert.ok(rule(edited, 'managed-current').findings.some((entry) => entry.path === '.claude/settings.json'));
});

test('ignoring a tracked managed file in the change that deletes it still fails managed-current', { skip: process.platform === 'win32' }, async (t) => {
  const root = await installationFixture(t), version = await currentVersion();
  execFileSync('git', ['-C', root, 'add', '.']);
  commit(root, 'base');
  const installed = await installProject(root, { version, agents: ['claude'], runner: packageRunner(root) });
  assert.equal(installed.complete, true, JSON.stringify(installed.conflicts));
  execFileSync('git', ['-C', root, 'add', '-A']);
  commit(root, 'adopt block beaver', { ...process.env, PATH: await shimmedPath(root) });
  const baseHash = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', root, 'rm', '-q', '--cached', '.claude/settings.json']);
  await rm(join(root, '.claude/settings.json'));
  await writeFile(join(root, '.gitignore'), '.claude\n');
  execFileSync('git', ['-C', root, 'add', '.gitignore']);
  const staged = await auditProject(root, { mode: 'staged' });
  assert.equal(rule(staged, 'managed-current').pass, false);
  assert.ok(rule(staged, 'managed-current').findings.some((entry) => entry.path === '.claude/settings.json'), JSON.stringify(rule(staged, 'managed-current')));
  execFileSync('git', ['-C', root, ...identity, 'commit', '--no-verify', '-qm', 'drop hooks'], { stdio: 'pipe' });
  const range = await auditProject(root, { mode: 'range', base: baseHash });
  assert.ok(rule(range, 'managed-current').findings.some((entry) => entry.path === '.claude/settings.json'), JSON.stringify(rule(range, 'managed-current')));
});
