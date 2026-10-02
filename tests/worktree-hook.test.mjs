import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installProject } from '../src/install.mjs';
import { auditProject } from '../src/compliance.mjs';
import { updateProject } from '../src/block-map.mjs';
import { isolatedGitEnv } from '../src/compliance-git.mjs';
import { installationFixture, packageRunner } from './helpers/install-fixture.mjs';

const skip = process.platform === 'win32';
const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test'];
const run = (root, ...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }).toString().trim();
const commit = (root, message, env = process.env, flags = '-qm') => execFileSync('git', ['-C', root, ...identity, 'commit', flags, message], { env, stdio: 'pipe' });
const cliPath = fileURLToPath(new URL('../bin/block-beaver.mjs', import.meta.url));
const origin = 'https://example.test/owner/host.git';

async function shimmedPath(root) {
  const bin = join(root, '..', 'shim-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'npx'), `#!/bin/sh\nshift 2\nexec "${process.execPath}" "${cliPath}" "$@"\n`);
  await chmod(join(bin, 'npx'), 0o755);
  return `${bin}:${process.env.PATH}`;
}

async function adopted(t) {
  const root = await installationFixture(t), { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await writeFile(join(root, 'notes.md'), 'one\n');
  run(root, 'remote', 'add', 'origin', origin);
  run(root, 'add', '.');
  commit(root, 'base');
  const installed = await installProject(root, { version, agents: ['claude', 'codex'], runner: packageRunner(root) });
  assert.equal(installed.complete, true, JSON.stringify(installed.conflicts));
  run(root, 'add', '-A');
  const env = { ...process.env, PATH: await shimmedPath(root) };
  commit(root, 'adopt block beaver', env);
  return { root, env };
}

test('a pre-commit audit in a linked worktree leaves the host repository untouched', { skip }, async (t) => {
  const { root, env } = await adopted(t);
  const worktree = join(root, '..', 'wt');
  run(root, 'worktree', 'add', '-q', worktree, '-b', 'wt');
  await updateProject(worktree); // the generated view is untracked, so a new worktree builds its own
  await writeFile(join(worktree, 'notes.md'), 'two\n');
  run(worktree, 'add', 'notes.md');
  const status = run(root, 'status', '--porcelain');
  const committed = spawnSync('git', ['-C', worktree, ...identity, 'commit', '-m', 'change in worktree'], { env, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  // git reports the hook's output on stderr; the summary is the only audit output and it is one line.
  assert.deepEqual(`${committed.stdout}${committed.stderr}`.split('\n').filter((line) => line.includes('block-beaver audit')), ['block-beaver audit: pass (1 files, 0 errors)']);
  assert.ok(!/unreviewed-source|"rules"/.test(`${committed.stdout}${committed.stderr}`));
  assert.equal(run(root, 'config', '--get', 'core.bare'), 'false');
  assert.equal(run(root, 'remote', 'get-url', 'origin'), origin);
  assert.equal(run(root, 'status', '--porcelain'), status);
  assert.equal(run(worktree, 'log', '--format=%s', '-1'), 'change in worktree');
});

test('a staged audit with hook-exported GIT_DIR and GIT_INDEX_FILE does not rewrite the host', { skip }, async (t) => {
  const { root } = await adopted(t);
  const worktree = join(root, '..', 'wt');
  run(root, 'worktree', 'add', '-q', worktree, '-b', 'wt');
  await updateProject(worktree); // the generated view is untracked, so a new worktree builds its own
  await writeFile(join(worktree, 'notes.md'), 'two\n');
  run(worktree, 'add', 'notes.md');
  const gitDir = run(worktree, 'rev-parse', '--absolute-git-dir'), saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = gitDir;
  process.env.GIT_INDEX_FILE = join(gitDir, 'index');
  try {
    const audit = await auditProject(worktree, { mode: 'staged' });
    assert.equal(audit.pass, true, JSON.stringify(audit.rules.filter((entry) => !entry.pass)));
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  assert.equal(run(root, 'config', '--get', 'core.bare'), 'false');
  assert.equal(run(root, 'remote', 'get-url', 'origin'), origin);
});


test('isolatedGitEnv drops repository-selecting variables and keeps the rest', () => {
  const env = isolatedGitEnv({ GIT_DIR: 'a', GIT_WORK_TREE: 'b', GIT_INDEX_FILE: 'c', GIT_OBJECT_DIRECTORY: 'd', GIT_ALTERNATE_OBJECT_DIRECTORIES: 'e', GIT_COMMON_DIR: 'f', GIT_PREFIX: 'g', GIT_NAMESPACE: 'h', GIT_CEILING_DIRECTORIES: 'i', GIT_AUTHOR_NAME: 'kept', PATH: 'p' });
  assert.deepEqual(env, { GIT_AUTHOR_NAME: 'kept', PATH: 'p' });
  // Config selectors and `git -c` overrides also point at the host; Windows env names are case-insensitive.
  const config = isolatedGitEnv({ GIT_CONFIG: '/host/.git/config', GIT_CONFIG_PARAMETERS: "'core.hookspath'='x'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true', Git_Dir: 'w', GIT_CONFIG_GLOBAL: 'kept' });
  assert.deepEqual(config, { GIT_CONFIG_GLOBAL: 'kept' });
});

test('git commit -a audits the temporary index the hook is given', { skip }, async (t) => {
  const { root, env } = await adopted(t);
  // A commit -a hook sees GIT_INDEX_FILE pointing at a temporary index holding the new bytes.
  await writeFile(join(root, 'notes.md'), 'two\n');
  commit(root, 'tracked change', env, '-aqm');
  assert.equal(run(root, 'show', 'HEAD:notes.md'), 'two');
  // Corrupt a managed file in the worktree only: commit -a must stage it into the temp index and fail the audit.
  const managed = (await readFile(join(root, '.blocks/install.json'), 'utf8')).replace(/"version": "[^"]+"/, '"version": "0.0.0"');
  await writeFile(join(root, '.blocks/install.json'), managed);
  await assert.rejects(async () => commit(root, 'bad', env, '-aqm'));
  assert.notEqual(run(root, 'log', '--format=%s', '-1'), 'bad');
  assert.equal(run(root, 'config', '--get', 'core.bare'), 'false');
});
