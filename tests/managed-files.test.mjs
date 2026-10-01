import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planManagedFiles } from '../src/managed-files.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
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

test('CRLF managed sections stay current while content edits still require review', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'AGENTS.md'), 'Owner prose\r\n');
  await apply(root, await planManagedFiles(options(root)));
  const paths = ['AGENTS.md', '.blocks/WORKFLOW.md', '.agents/skills/block-beaver/SKILL.md', '.claude/settings.json', '.codex/hooks.json', '.blocks/managed-files.json'];
  for (const path of paths) {
    const file = join(root, path);
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
  }
  const current = await planManagedFiles(options(root, { operation: 'upgrade' }));
  assert.deepEqual(current.conflicts, []);
  for (const path of paths) {
    const planned = current.files.find(file => file.path === path);
    assert.equal(planned.before, planned.content, path);
  }
  const owner = await readFile(join(root, 'AGENTS.md'), 'utf8');
  await writeFile(join(root, 'AGENTS.md'), owner.replace('Read and follow', 'Owner changed'));
  const edited = await planManagedFiles(options(root, { operation: 'upgrade' }));
  assert.ok(edited.conflicts.some(item => item.path === 'AGENTS.md' && /Owner edits/.test(item.message)));
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
  await writeFile(path, `<!-- block-beaver:start -->\n${old.trimEnd()}\n<!-- block-beaver:end -->\n`.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
  const plan = await planManagedFiles(options(root, { operation: 'upgrade' }));
  await apply(root, plan);
  assert.match(await readFile(path, 'utf8'), /block-beaver:hash [a-f0-9]{64}/);
  await writeFile(path, `<!-- block-beaver:start -->\n${old.trimEnd().replace('This project uses Block Beaver.', 'Owner customized workflow.')}\n<!-- block-beaver:end -->\n`);
  const conflict = await planManagedFiles(options(root, { operation: 'upgrade' }));
  assert.ok(conflict.conflicts.some((entry) => entry.path === '.blocks/WORKFLOW.md' && /Owner edits/.test(entry.message)));
});

const DIRECT = 'node node_modules/block-beaver/bin/block-beaver.mjs';
for (const [id, version, lockfile, extra] of [
  ['npm', '10.0.0', 'package-lock.json', {}],
  ['pnpm', '9.0.0', 'pnpm-lock.yaml', {}],
  ['yarn', '1.22.22', 'yarn.lock', {}],
  ['yarn', '4.0.0', 'yarn.lock', { '.yarnrc.yml': 'nodeLinker: node-modules\n' }],
  ['bun', '1.2.0', 'bun.lock', {}],
]) {
  test(`${id}@${version}${extra['.yarnrc.yml'] ? ' (node-modules linker)' : ''}: native hooks run the installed binary with node and survive repeat, upgrade and uninstall`, async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: `${id}@${version}` }));
    await writeFile(join(root, lockfile), '{}');
    for (const [file, text] of Object.entries(extra)) await writeFile(join(root, file), text);
    await mkdir(join(root, '.claude'));
    const path = join(root, '.claude/settings.json');
    const foreign = { type: 'command', command: 'owner-command --hook-id block-beaver' };
    await writeFile(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [foreign] }] } }));
    await apply(root, await planManagedFiles(options(root, { agents: ['claude', 'codex'] })));
    for (const [hookPath, agent] of [['.claude/settings.json', 'claude'], ['.codex/hooks.json', 'codex']]) {
      const hooks = JSON.parse(await readFile(join(root, hookPath), 'utf8')).hooks.PreToolUse.flatMap((group) => group.hooks);
      const owned = hooks.filter((hook) => hook.command.includes('hook-check'));
      assert.deepEqual(owned.map((hook) => hook.command), [`${DIRECT} hook-check --agent ${agent} --hook-id block-beaver`]);
      assert.equal(owned[0].timeout, 1);
    }
    const repeat = await planManagedFiles(options(root, { agents: ['claude', 'codex'] }));
    assert.ok(repeat.files.every((file) => file.before === file.content));
    await apply(root, await planManagedFiles(options(root, { agents: ['claude', 'codex'], operation: 'upgrade', version: '0.4.0' })));
    await apply(root, await planManagedFiles(options(root, { agents: ['claude', 'codex'], operation: 'uninstall', version: '0.4.0' })));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).hooks.PreToolUse[0].hooks, [foreign]);
    assert.equal(await readFile(join(root, '.codex/hooks.json'), 'utf8').catch(() => null), null);
  });
}

for (const [name, files, packageManager] of [
  ['Yarn Berry without an explicit linker (PnP default)', {}, 'yarn@4.0.0'],
  ['Yarn Berry with nodeLinker pnp', { '.yarnrc.yml': 'nodeLinker: pnp\n' }, 'yarn@4.0.0'],
  ['Yarn Berry detected from the lockfile metadata', { 'yarn.lock': '__metadata:\n  version: 8\n' }, undefined],
  ['a .pnp.cjs runtime file', { '.pnp.cjs': '' }, 'yarn@1.22.22'],
]) {
  test(`Yarn PnP fallback: ${name} keeps yarn exec`, async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'package.json'), JSON.stringify(packageManager ? { packageManager } : {}));
    if (!files['yarn.lock']) await writeFile(join(root, 'yarn.lock'), '{}');
    for (const [file, text] of Object.entries(files)) await writeFile(join(root, file), text);
    await apply(root, await planManagedFiles(options(root, { agents: ['claude', 'codex'] })));
    for (const [hookPath, agent] of [['.claude/settings.json', 'claude'], ['.codex/hooks.json', 'codex']]) {
      const hooks = JSON.parse(await readFile(join(root, hookPath), 'utf8')).hooks.PreToolUse;
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0].hooks[0].command, `yarn exec block-beaver hook-check --agent ${agent} --hook-id block-beaver`);
      assert.equal(hooks[0].hooks[0].timeout, 1);
    }
    const repeat = await planManagedFiles(options(root, { agents: ['claude', 'codex'] }));
    assert.ok(repeat.files.every((file) => file.before === file.content));
  });
}

test('an explicit node-modules linker overrides a stale .pnp.cjs', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }));
  await writeFile(join(root, 'yarn.lock'), '{}');
  await writeFile(join(root, '.pnp.cjs'), '');
  await writeFile(join(root, '.yarnrc.yml'), 'nodeLinker: "node-modules" # hoisted\n');
  await apply(root, await planManagedFiles(options(root, { agents: ['claude'] })));
  assert.match(JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command, /^node node_modules\/block-beaver\/bin\/block-beaver\.mjs hook-check/);
});

test('switching from npm hooks to Yarn PnP preserves owner handlers and hash checks', async (t) => {
  const root = await fixture(t);
  await apply(root, await planManagedFiles(options(root, { agents: ['claude'] })));
  assert.match(JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command, /^node node_modules\//);
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

// Frozen 0.5.0 hook entries, written by the 0.5.0 installer: a package-manager launcher per manager.
const legacyHooks = JSON.parse(await readFile(new URL('../templates/legacy/0.5.0-hooks.json', import.meta.url), 'utf8'));
const hookFiles = { claude: '.claude/settings.json', codex: '.codex/hooks.json' };
const launchers = { npm: 'npx --no-install block-beaver', pnpm: 'pnpm exec block-beaver', yarn: 'yarn exec block-beaver', bun: 'bunx --no-install block-beaver' };

test('frozen 0.5.0 hook entries cover every manager and agent with the exact 0.5.0 bytes', () => {
  for (const agent of ['claude', 'codex']) {
    assert.deepEqual(legacyHooks[agent].map((entry) => entry.manager), Object.keys(launchers));
    for (const { manager, hook } of legacyHooks[agent]) {
      assert.deepEqual(hook, { matcher: agent === 'codex' ? 'Read|Edit|Write|apply_patch|Bash' : 'Read|Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: `${launchers[manager]} hook-check --agent ${agent} --hook-id block-beaver`, timeout: 1 }] });
    }
  }
});

for (const [id, lockfile] of [['npm', 'package-lock.json'], ['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lock']]) {
  for (const withState of [true, false]) {
    test(`0.5.0 ${id} hooks upgrade to the direct node form ${withState ? 'with' : 'without'} managed-files.json`, async (t) => {
      const root = await fixture(t);
      await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: `${id}@${id === 'yarn' ? '1.22.22' : '9.0.0'}` }));
      await writeFile(join(root, lockfile), '{}');
      await apply(root, await planManagedFiles(options(root, { agents: ['claude', 'codex'] })));
      const foreign = { type: 'command', command: 'owner-command --hook-id block-beaver' };
      for (const agent of ['claude', 'codex']) {
        const entry = legacyHooks[agent].find((item) => item.manager === id).hook;
        await writeFile(join(root, hookFiles[agent]), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [foreign] }, entry] } }, null, 2) + '\n');
      }
      if (withState) {
        const state = JSON.parse(await readFile(join(root, '.blocks/managed-files.json'), 'utf8'));
        for (const agent of ['claude', 'codex']) state.hooks[agent] = { hash: createHash('sha256').update(JSON.stringify([legacyHooks[agent].find((item) => item.manager === id).hook])).digest('hex') };
        await writeFile(join(root, '.blocks/managed-files.json'), JSON.stringify(state, null, 2) + '\n');
      } else await rm(join(root, '.blocks/managed-files.json'));
      const plan = await planManagedFiles(options(root, { agents: ['claude', 'codex'], operation: 'upgrade' }));
      await apply(root, plan);
      for (const agent of ['claude', 'codex']) {
        const groups = JSON.parse(await readFile(join(root, hookFiles[agent]), 'utf8')).hooks.PreToolUse;
        assert.deepEqual(groups[0].hooks, [foreign]);
        assert.equal(groups.length, 2);
        assert.equal(groups[1].hooks[0].command, `${DIRECT} hook-check --agent ${agent} --hook-id block-beaver`);
      }
      const repeat = await planManagedFiles(options(root, { agents: ['claude', 'codex'], operation: 'upgrade' }));
      assert.deepEqual(repeat.conflicts, []);
      assert.ok(repeat.files.every((file) => file.before === file.content));
    });
  }
}

test('a modified 0.5.0 hook without state is still unverified', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.claude'));
  const entry = structuredClone(legacyHooks.claude[0].hook);
  entry.hooks[0].command += ' --owner-change';
  await writeFile(join(root, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [entry] } }));
  const plan = await planManagedFiles(options(root, { agents: ['claude'], operation: 'upgrade' }));
  assert.ok(plan.conflicts.some((item) => item.path === '.claude/settings.json' && /Unverified/.test(item.message)));
});

test('uninstall removes the direct node handler and keeps owner hooks', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.claude'));
  const foreign = { type: 'command', command: `owner-command ${DIRECT} hook-check --hook-id block-beaver` };
  await writeFile(join(root, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [foreign] }] } }));
  await apply(root, await planManagedFiles(options(root, { agents: ['claude'] })));
  assert.ok(JSON.stringify(JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'))).includes(`"${DIRECT} hook-check`));
  await apply(root, await planManagedFiles(options(root, { agents: ['claude'], operation: 'uninstall' })));
  assert.deepEqual(JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8')).hooks.PreToolUse, [{ matcher: 'Read', hooks: [foreign] }]);
});

test('managed-current reports an old 0.5.0 hook as outdated content instead of duplicating handlers', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', devDependencies: { 'block-beaver': '0.5.1' } }));
  await mkdir(join(root, '.blocks'), { recursive: true });
  await apply(root, await planManagedFiles(options(root, { version: '0.5.1', agents: ['claude'] })));
  // Present the installed project as a 0.5.0 one: swap in the frozen npm entry and its state hash.
  const entry = legacyHooks.claude[0].hook;
  await writeFile(join(root, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [entry] } }, null, 2) + '\n');
  const state = JSON.parse(await readFile(join(root, '.blocks/managed-files.json'), 'utf8'));
  state.hooks.claude = { hash: createHash('sha256').update(JSON.stringify([entry])).digest('hex') };
  await writeFile(join(root, '.blocks/managed-files.json'), JSON.stringify(state, null, 2) + '\n');
  const plan = await planManagedFiles({ root, version: '0.5.1', agents: ['claude'], operation: 'upgrade', force: true });
  assert.deepEqual(plan.conflicts, []);
  const settings = plan.files.find((file) => file.path === '.claude/settings.json');
  assert.notEqual(settings.before, settings.content);
  const groups = JSON.parse(settings.content).hooks.PreToolUse;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hooks[0].command, `${DIRECT} hook-check --agent claude --hook-id block-beaver`);
});

test('the rendered hook command executes under a shell against the installed package and prints hook context', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.blocks/view'), { recursive: true });
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, enforcement: { agents: 'guide' } }));
  await writeFile(join(root, '.blocks/view/graph.json'), JSON.stringify({ schemaVersion: 2,
    nodes: [{ id: 'file:src/api.ts', path: 'src/api.ts', kind: 'file', usedBy: [] }, { id: 'block:local:api', kind: 'block', manifest: { files: ['src/api.ts'], dependencies: [] } }],
    edges: [{ from: 'block:local:api', to: 'file:src/api.ts', kind: 'implemented-by' }] }));
  await mkdir(join(root, 'node_modules'));
  await symlink(fileURLToPath(new URL('..', import.meta.url)), join(root, 'node_modules/block-beaver'), 'junction');
  const { command } = renderAgentHook('claude').hooks[0];
  const started = performance.now();
  const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/api.ts' } }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /belongs to block:local:api/);
  assert.ok(performance.now() - started < 5000);
});
