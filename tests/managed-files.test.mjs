import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planManagedFiles } from '../src/managed-files.mjs';
import { renderAgentHook } from '../src/install-templates.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-managed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function apply(root, plan) {
  assert.deepEqual(plan.conflicts, []);
  for (const file of plan.files) {
    if (file.before === file.content) continue;
    if (file.content === null) await rm(join(root, file.path), { force: true });
    else { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.content); }
  }
}
const options = (root, extra = {}) => ({ root, version: '0.3.0', agents: ['claude', 'codex', 'cursor', 'copilot'], ...extra });

test('managed install plan is read-only and repeated application is byte-stable', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'AGENTS.md'), 'Owner guidance.\n');
  const first = await planManagedFiles(options(root));
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'Owner guidance.\n');
  await apply(root, first);
  const second = await planManagedFiles(options(root));
  assert.deepEqual(second.conflicts, []);
  assert.ok(second.files.every((file) => file.before === file.content));
  const skill = await readFile(join(root, '.agents/skills/block-beaver/SKILL.md'), 'utf8');
  assert.ok(skill.startsWith('---\nname: block-beaver\n'));
  assert.match(skill, /references\/workflow.md/);
  assert.match(skill, /block-beaver:hash [a-f0-9]{64}/);
  assert.match(skill, /block-beaver:version 0.3.0/);
});

test('upgrade preserves surrounding and local prose and refuses modified managed bodies', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'AGENTS.md'), 'Owner instructions\n');
  await apply(root, await planManagedFiles(options(root)));
  const path = join(root, 'AGENTS.md');
  const original = await readFile(path, 'utf8');
  const local = '\n<!-- block-beaver:local:start -->\nOwner local notes.\n<!-- block-beaver:local:end -->\n';
  await writeFile(path, original + local);
  const upgraded = await planManagedFiles(options(root, { version: '0.4.0', operation: 'upgrade' }));
  await apply(root, upgraded);
  assert.match(await readFile(path, 'utf8'), /Owner instructions/);
  assert.ok((await readFile(path, 'utf8')).endsWith(local));
  await writeFile(path, (await readFile(path, 'utf8')).replace('Inspect the owning block', 'Owner changed managed guidance'));
  const refused = await planManagedFiles(options(root, { version: '0.5.0', operation: 'upgrade' }));
  assert.ok(refused.conflicts.some((conflict) => conflict.path === 'AGENTS.md' && /Owner edits/.test(conflict.message)));
  const forced = await planManagedFiles(options(root, { version: '0.5.0', operation: 'upgrade', force: true }));
  await apply(root, forced);
  assert.ok((await readFile(path, 'utf8')).endsWith(local));
  assert.doesNotMatch(await readFile(path, 'utf8'), /Owner changed managed guidance/);
});

test('native hooks preserve other handlers and replace the stable owned command once', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.claude'));
  const settingsPath = join(root, '.claude/settings.json');
  const foreign = { type: 'command', command: 'other-tool verify', timeout: 12 };
  const settings = { permissions: { allow: ['Read'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [foreign] }], Stop: [{ hooks: [{ type: 'command', command: 'other-tool done' }] }] } };
  await writeFile(settingsPath, JSON.stringify(settings));
  await apply(root, await planManagedFiles(options(root)));
  const installed = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.deepEqual(installed.permissions, settings.permissions);
  assert.deepEqual(installed.hooks.Stop, settings.hooks.Stop);
  assert.deepEqual(installed.hooks.PreToolUse[0].hooks, [foreign]);
  const handlers = installed.hooks.PreToolUse.flatMap((group) => group.hooks);
  assert.equal(handlers.filter((hook) => hook.command.includes('--hook-id block-beaver')).length, 1);
  assert.ok(handlers.every((hook) => !Object.hasOwn(hook, 'id')));
  installed.hooks.PreToolUse[1].hooks[0].timeout = 10;
  await writeFile(settingsPath, JSON.stringify(installed));
  const refused = await planManagedFiles(options(root, { operation: 'upgrade' }));
  assert.ok(refused.conflicts.some((conflict) => conflict.path === '.claude/settings.json'));
  await apply(root, await planManagedFiles(options(root, { operation: 'upgrade', force: true })));
  const removed = await planManagedFiles(options(root, { operation: 'uninstall' }));
  await apply(root, removed);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), settings);
});

test('uninstall removes only managed content and keeps local additions', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'CLAUDE.md'), 'Owner prose\n');
  await apply(root, await planManagedFiles(options(root)));
  const skillPath = join(root, '.claude/skills/block-beaver/references/apps.md');
  const local = '\n<!-- block-beaver:local:start -->\nCustom app guidance\n<!-- block-beaver:local:end -->\n';
  await writeFile(skillPath, (await readFile(skillPath, 'utf8')) + local);
  const removed = await planManagedFiles(options(root, { operation: 'uninstall' }));
  await apply(root, removed);
  assert.match(await readFile(join(root, 'CLAUDE.md'), 'utf8'), /Owner prose/);
  assert.match(await readFile(skillPath, 'utf8'), /Custom app guidance/);
  assert.doesNotMatch(await readFile(skillPath, 'utf8'), /block-beaver:hash/);
  assert.ok((await planManagedFiles(options(root, { operation: 'uninstall' }))).files.every((file) => file.before === file.content));
});

test('unmarked owned files, malformed JSON, and unsafe paths conflict without writes', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.blocks'));
  await writeFile(join(root, '.blocks/WORKFLOW.md'), 'Owner workflow');
  await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.claude/settings.json'), '{ broken');
  const outside = await fixture(t);
  await writeFile(join(outside, 'owner.md'), 'Outside owner');
  await symlink(join(outside, 'owner.md'), join(root, 'AGENTS.md'));
  const plan = await planManagedFiles(options(root));
  assert.ok(plan.conflicts.some((conflict) => conflict.path === '.blocks/WORKFLOW.md'));
  assert.ok(plan.conflicts.some((conflict) => conflict.path === '.claude/settings.json'));
  assert.ok(plan.conflicts.some((conflict) => conflict.path === 'AGENTS.md'));
  assert.equal(await readFile(join(outside, 'owner.md'), 'utf8'), 'Outside owner');
});

test('Codex hook feature is enabled in its existing table and owner opt-out is preserved', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.codex'));
  const path = join(root, '.codex/config.toml');
  const original = 'model = "owner-model"\n\n[features]\nother_feature = true\n\n[profile.owner]\nmodel = "second-model"\n';
  await writeFile(path, original);
  await apply(root, await planManagedFiles(options(root, { agents: ['codex'] })));
  const installed = await readFile(path, 'utf8');
  assert.equal((installed.match(/\[features\]/g) || []).length, 1);
  assert.match(installed, /hooks = true/);
  assert.ok(installed.indexOf('hooks = true') < installed.indexOf('[profile.owner]'));
  await apply(root, await planManagedFiles(options(root, { agents: ['codex'], operation: 'uninstall' })));
  assert.equal(await readFile(path, 'utf8'), original);
  await writeFile(path, '[features]\nhooks = false\n');
  const refused = await planManagedFiles(options(root, { agents: ['codex'], force: true }));
  assert.ok(refused.conflicts.some((conflict) => conflict.path === '.codex/config.toml' && /Owner disabled/.test(conflict.message)));
  assert.equal(await readFile(path, 'utf8'), '[features]\nhooks = false\n');
});

test('native handler matching leaves other executables with similar ids untouched', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.claude'));
  const foreign = { type: 'command', command: 'different-tool --hook-id block-beaver' };
  const path = join(root, '.claude/settings.json');
  await writeFile(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [foreign] }] } }));
  await apply(root, await planManagedFiles(options(root, { agents: ['claude'] })));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).hooks.PreToolUse[0].hooks, [foreign]);
});

test('historical init workflow upgrades only from exact frozen generated content', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.blocks'));
  const path = join(root, '.blocks/WORKFLOW.md');
  const old = await readFile(new URL('../templates/legacy/0.1.1-workflow.md', import.meta.url), 'utf8');
  await writeFile(path, `<!-- block-beaver:start -->\n${old.trimEnd()}\n<!-- block-beaver:end -->\n`);
  const plan = await planManagedFiles(options(root, { operation: 'upgrade' }));
  await apply(root, plan);
  assert.match(await readFile(path, 'utf8'), /block-beaver:hash [a-f0-9]{64}/);
  await writeFile(path, `<!-- block-beaver:start -->\n${old.trimEnd().replace('This project uses Block Beaver.', 'Owner customized workflow.')}\n<!-- block-beaver:end -->\n`);
  const conflict = await planManagedFiles(options(root, { operation: 'upgrade' }));
  assert.ok(conflict.conflicts.some((entry) => entry.path === '.blocks/WORKFLOW.md' && /Owner edits/.test(entry.message)));
});

for (const [id, prefix, lockfile] of [
  ['npm', 'npx --no-install', 'package-lock.json'],
  ['pnpm', 'pnpm exec', 'pnpm-lock.yaml'],
  ['yarn', 'yarn exec', 'yarn.lock'],
  ['bun', 'bunx --no-install', 'bun.lock'],
]) {
  test(`${id}: native hooks use the detected local CLI and survive repeat, upgrade and uninstall`, async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: `${id}@4.0.0` }));
    await writeFile(join(root, lockfile), '{}');
    await mkdir(join(root, '.claude'));
    const path = join(root, '.claude/settings.json');
    const foreign = { type: 'command', command: 'owner-command --hook-id block-beaver' };
    await writeFile(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [foreign] }] } }));
    await apply(root, await planManagedFiles(options(root, { agents: ['claude', 'codex'] })));
    for (const hookPath of ['.claude/settings.json', '.codex/hooks.json']) {
      const hooks = JSON.parse(await readFile(join(root, hookPath), 'utf8')).hooks.PreToolUse.flatMap((group) => group.hooks);
      assert.equal(hooks.filter((hook) => hook.command.startsWith(`${prefix} block-beaver hook-check`)).length, 1);
    }
    const repeat = await planManagedFiles(options(root, { agents: ['claude', 'codex'] }));
    assert.ok(repeat.files.every((file) => file.before === file.content));
    await apply(root, await planManagedFiles(options(root, { agents: ['claude', 'codex'], operation: 'upgrade', version: '0.4.0' })));
    await apply(root, await planManagedFiles(options(root, { agents: ['claude', 'codex'], operation: 'uninstall', version: '0.4.0' })));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).hooks.PreToolUse[0].hooks, [foreign]);
  });
}

test('switching from historical npm hooks to Yarn preserves owner handlers and hash checks', async (t) => {
  const root = await fixture(t);
  await apply(root, await planManagedFiles(options(root, { agents: ['claude'] })));
  await writeFile(join(root, 'package.json'), '{"packageManager":"yarn@4.0.0"}');
  await apply(root, await planManagedFiles(options(root, { agents: ['claude'], operation: 'upgrade' })));
  const path = join(root, '.claude/settings.json');
  const settings = JSON.parse(await readFile(path, 'utf8'));
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /^yarn exec block-beaver/);
  settings.hooks.PreToolUse[0].hooks[0].command += ' --owner-change';
  await writeFile(path, JSON.stringify(settings));
  const refused = await planManagedFiles(options(root, { agents: ['claude'], operation: 'upgrade' }));
  assert.ok(refused.conflicts.some((entry) => entry.path === '.claude/settings.json' && /Owner edits/.test(entry.message)));
  assert.throws(() => renderAgentHook('claude', { manager: 'yarn; unsafe' }), /require npm/);
});
