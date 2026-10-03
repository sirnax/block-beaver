import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageManager, planPackageChange, runPackageChange, resolvePackageExecutable, localBlockBeaverCommand } from '../src/package-manager.mjs';

async function fixture(t, pkg = {}, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', ...pkg }));
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  return root;
}
const version = '0.3.0';
const matching = {
  npm: ['package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { devDependencies: { 'block-beaver': version } }, 'node_modules/block-beaver': { version } } })],
  pnpm: ['pnpm-lock.yaml', `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      block-beaver:\n        specifier: ${version}\n        version: ${version}\npackages:\n  block-beaver@${version}: {}\n`],
  yarn: ['yarn.lock', `# yarn lockfile v1\n\nblock-beaver@${version}:\n  version "${version}"\n  resolved "https://registry.npmjs.org/block-beaver"\n`],
  bun: ['bun.lock', JSON.stringify({ lockfileVersion: 1, workspaces: { '': { devDependencies: { 'block-beaver': version } } }, packages: { 'block-beaver': [`block-beaver@${version}`, '', {}, 'sha512-test'] } })],
};

for (const id of Object.keys(matching)) {
  test(`${id}: exact dev pin uses argument arrays, dry-run is inert, matching lock is idempotent`, async (t) => {
    const [lockfile, lock] = matching[id];
    const root = await fixture(t, { dependencies: { unrelated: '^1.0.0' } }, { [lockfile]: lock });
    const manager = await detectPackageManager(root);
    assert.equal(manager.id, id);
    assert.equal(manager.lockfile, lockfile);
    const before = await readFile(join(root, 'package.json'), 'utf8');
    const plan = await planPackageChange(root, { manager, version });
    assert.equal(plan.commands[0].executable, id);
    assert.ok(plan.commands[0].args.includes(`block-beaver@${version}`));
    assert.ok(plan.commands[0].args.includes(id === 'npm' || id === 'pnpm' ? '--save-exact' : '--exact'));
    assert.equal(JSON.parse(plan.files[0].content).devDependencies['block-beaver'], version);
    assert.equal(plan.files[0].commandOwned, true);
    const calls = [];
    const runner = async (...args) => { calls.push(args); return { exitCode: 0 }; };
    await runPackageChange(root, plan, { runner, dryRun: true });
    assert.equal(calls.length, 0);
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before);
    await runPackageChange(root, plan, { runner });
    assert.deepEqual(calls[0], [id, plan.commands[0].args, { cwd: root, shell: false }]);
    await writeFile(join(root, 'package.json'), plan.files[0].content);
    const repeat = await planPackageChange(root, { version });
    assert.deepEqual(repeat.commands, []);
    assert.deepEqual(repeat.files, []);
    const uninstall = await planPackageChange(root, { operation: 'uninstall' });
    assert.ok(uninstall.commands[0].args.includes('block-beaver'));
    const remaining = JSON.parse(uninstall.files[0].content);
    assert.equal(remaining.dependencies.unrelated, '^1.0.0');
    assert.equal(remaining.devDependencies['block-beaver'], undefined);
    await writeFile(join(root, 'package.json'), uninstall.files[0].content);
    assert.deepEqual((await planPackageChange(root, { operation: 'uninstall' })).commands, []);
  });
  test(`${id}: an existing pin does not hide a missing or stale lockfile`, async (t) => {
    const [lockfile, lock] = matching[id];
    const root = await fixture(t, { packageManager: `${id}@9.0.0`, devDependencies: { 'block-beaver': version } });
    assert.equal((await planPackageChange(root, { version })).commands.length, 1);
    await writeFile(join(root, lockfile), lock.replaceAll(version, '0.2.0'));
    assert.equal((await planPackageChange(root, { version })).commands.length, 1);
  });
}

test('ambiguity refuses, owner field resolves, wrong owner refuses, and no lock defaults visibly', async (t) => {
  const root = await fixture(t, {}, { 'package-lock.json': '{}', 'pnpm-lock.yaml': '' });
  await assert.rejects(detectPackageManager(root), /Conflicting.*package-lock.json.*pnpm-lock.yaml/);
  await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
  assert.equal((await detectPackageManager(root)).id, 'pnpm');
  const mismatch = await fixture(t, { packageManager: 'bun@1.0.0' }, { 'yarn.lock': '' });
  await assert.rejects(detectPackageManager(mismatch), /conflicts/);
  const empty = await fixture(t);
  assert.equal((await detectPackageManager(empty)).id, 'npm');
  assert.match((await detectPackageManager(empty)).diagnostics[0], /No lockfile/);
});

test('package validation, exact-version policy and runner errors fail before managed writes', async (t) => {
  const root = await fixture(t);
  for (const version of ['latest', '^1.2.3', '1.2', '1.2.3; echo unsafe']) await assert.rejects(planPackageChange(root, { version }), /exact semantic version/);
  const plan = await planPackageChange(root, { version: '1.2.3-beta.1+build' });
  await assert.rejects(runPackageChange(root, plan, { runner: async () => { throw new Error('manager unavailable'); } }), /manager unavailable/);
  await assert.rejects(runPackageChange(root, plan, { runner: async () => ({ exitCode: 2, stderr: 'lock conflict' }) }), /exit code 2.*lock conflict/);
  await writeFile(join(root, 'package.json'), 'broken');
  await assert.rejects(detectPackageManager(root), /invalid JSON/);
  await writeFile(join(root, 'package.json'), '{"packageManager":42}');
  await assert.rejects(detectPackageManager(root), /Unsupported/);
  await rm(join(root, 'package.json'));
  await assert.rejects(detectPackageManager(root), /requires a package.json/);
});

test('Berry locks and npm shrinkwrap use owning formats; Bun binary verification is delegated', async (t) => {
  const root = await fixture(t, { packageManager: 'yarn@4.0.0', devDependencies: { 'block-beaver': version } }, { 'yarn.lock': `__metadata:\n  version: 8\n\n"block-beaver@npm:${version}":\n  version: ${version}\n` });
  assert.deepEqual((await planPackageChange(root, { version })).commands, []);
  await writeFile(join(root, 'yarn.lock'), '__metadata:\n  version: 8\n');
  assert.deepEqual((await planPackageChange(root, { version })).commands[0].args, ['install', '--mode=update-lockfile']);
  const npmRoot = await fixture(t, {}, { 'npm-shrinkwrap.json': '{}', 'package-lock.json': '{}' });
  assert.equal((await detectPackageManager(npmRoot)).lockfile, 'npm-shrinkwrap.json');
  const bunRoot = await fixture(t, { devDependencies: { 'block-beaver': version } }, { 'bun.lockb': Buffer.from([0, 1, 2]) });
  assert.equal((await planPackageChange(bunRoot, { version })).commands.length, 1);
});

test('workspace roots get manager-specific permissions and Yarn production pins move to dev', async (t) => {
  const pnpm = await fixture(t, {}, { 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' });
  assert.ok((await planPackageChange(pnpm, { version })).commands[0].args.includes('--workspace-root'));
  const yarn = await fixture(t, { workspaces: ['packages/*'] }, { 'yarn.lock': '' });
  assert.ok((await planPackageChange(yarn, { version })).commands[0].args.includes('--ignore-workspace-root-check'));
  const berry = await fixture(t, { packageManager: 'yarn@4.0.0', dependencies: { 'block-beaver': '^0.2.0', keep: '^1.0.0' }, workspaces: ['packages/*'] }, { 'yarn.lock': '' });
  const plan = await planPackageChange(berry, { version });
  assert.deepEqual(plan.commands[0].args, ['remove', 'block-beaver']);
  assert.ok(!plan.commands[1].args.includes('--ignore-workspace-root-check'));
  assert.equal(JSON.parse(plan.files[0].content).dependencies.keep, '^1.0.0');
});

test('Windows npm, pnpm, Yarn and Corepack shims resolve to Node without shell interpretation', async () => {
  const bin = 'C:\\Program Files\\Node';
  const nodeExecutable = `${bin}\\node.exe`;
  for (const [manager, relative, variable] of [
    ['npm', 'node_modules\\npm\\bin\\npm-cli.js', '%~dp0'],
    ['pnpm', 'node_modules\\pnpm\\bin\\pnpm.cjs', '%dp0%'],
    ['yarn', 'node_modules\\yarn\\bin\\yarn.js', '%dp0%'],
    ['pnpm', 'node_modules\\corepack\\dist\\pnpm.js', '%dp0%'],
    ['yarn', 'node_modules\\corepack\\dist\\yarn.js', '%dp0%'],
  ]) {
    const shim = `${bin}\\${manager}.cmd`;
    const script = `${bin}\\${relative}`;
    const files = new Map([[shim, `@ECHO OFF\r\n"%_prog%" "${variable}\\${relative}" %*\r\n`], [script, '// CLI']]);
    const resolved = await resolvePackageExecutable(manager, { platform: 'win32', env: { Path: `C:\\missing;"${bin}"` }, nodeExecutable, isFile: async (path) => files.has(path), read: async (path) => files.get(path) });
    assert.deepEqual(resolved, { executable: nodeExecutable, args: [script] });
  }
});

test('Windows native managers resolve directly; unsupported/missing shims fail with remediation', async () => {
  const files = new Map([['C:\\tools\\bun.exe', 'native'], ['C:\\tools\\npm.cmd', '@echo off\r\ncmd.exe /c unsafe %*']]);
  const options = { platform: 'win32', env: { PATH: 'C:\\tools' }, isFile: async (path) => files.has(path), read: async (path) => files.get(path) };
  assert.deepEqual(await resolvePackageExecutable('bun', options), { executable: 'C:\\tools\\bun.exe', args: [] });
  await assert.rejects(resolvePackageExecutable('npm', options), /Cannot safely execute.*Install a standard/);
  await assert.rejects(resolvePackageExecutable('yarn', options), /not found.*Install/);
  await assert.rejects(resolvePackageExecutable('evil', options), /Unsupported Windows/);
  files.set('C:\\tools\\npm.cmd', '"%dp0%\\..\\elsewhere\\npm-cli.js" %*');
  await assert.rejects(resolvePackageExecutable('npm', options), /Cannot safely execute/);
  assert.deepEqual(await resolvePackageExecutable('npm', { platform: 'linux' }), { executable: 'npm', args: [] });
});

test('local CLI prefixes are manager-native and never accept arbitrary command text', () => {
  for (const [id, expected] of Object.entries({ npm: 'npx --no-install block-beaver', pnpm: 'pnpm exec block-beaver', yarn: 'yarn exec block-beaver', bun: 'bunx --no-install block-beaver' })) {
    assert.equal(localBlockBeaverCommand(id), expected);
    assert.equal(localBlockBeaverCommand({ id }), expected);
  }
  assert.throws(() => localBlockBeaverCommand('npm; echo bad'), /require npm/);
  assert.throws(() => localBlockBeaverCommand({ executable: 'npm' }), /require npm/);
});

for (const id of ['npm', 'pnpm', 'yarn', 'bun']) {
  test(`${id} runtime install pins under dependencies and removes the devDependency`, async (t) => {
    const root = await fixture(t, { packageManager: `${id}@9.0.0`, devDependencies: { 'block-beaver': '0.2.0' } });
    const plan = await planPackageChange(root, { manager: id, version, runtime: true });
    const args = plan.commands.at(-1).args;
    assert.ok(args.includes(`block-beaver@${version}`));
    assert.ok(!args.includes('--save-dev') && !args.includes('--dev'));
    assert.ok(args.includes(id === 'npm' || id === 'pnpm' ? '--save-exact' : '--exact'));
    if (id === 'yarn') assert.deepEqual(plan.commands[0].args, ['remove', 'block-beaver']);
    const next = JSON.parse(plan.files[0].content);
    assert.equal(next.dependencies['block-beaver'], version);
    assert.equal(next.devDependencies['block-beaver'], undefined);
    assert.equal(plan.placement, 'dependencies');
  });
}

test('re-pinning keeps an existing dependencies placement and lock checks accept either group', async (t) => {
  const root = await fixture(t, { dependencies: { 'block-beaver': '0.2.0' } });
  const plan = await planPackageChange(root, { manager: 'npm', version, keepPlacement: true });
  assert.ok(!plan.commands[0].args.includes('--save-dev'));
  assert.equal(JSON.parse(plan.files[0].content).dependencies['block-beaver'], version);
  const locked = await fixture(t, { dependencies: { 'block-beaver': version } }, { 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'block-beaver': version } }, 'node_modules/block-beaver': { version } } }) });
  assert.deepEqual((await planPackageChange(locked, { manager: 'npm', version, keepPlacement: true })).commands, []);
  const pnpm = await fixture(t, { packageManager: 'pnpm@9.0.0', dependencies: { 'block-beaver': version } }, { 'pnpm-lock.yaml': matching.pnpm[1].replace('devDependencies:', 'dependencies:') });
  assert.deepEqual((await planPackageChange(pnpm, { manager: 'pnpm', version, keepPlacement: true })).commands, []);
});
