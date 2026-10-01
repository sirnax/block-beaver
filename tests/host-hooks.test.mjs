import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, link, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightHostHooks, applyHostHooks, preflightProjectModes, applyProjectModes } from '../src/host-hooks.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'block-beaver-host-hook-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  await mkdir(root);
  await exec('git', ['init', '-q', root]);
  const absolutePath = join(root, '.git/hooks/pre-commit');
  const plan = (before, content, extra = {}) => ({ kind: 'hook', path: '.git/hooks/pre-commit', absolutePath, before, content, mode: 0o755, ...extra });
  return { parent, root, absolutePath, plan };
}

test('host hooks create, preserve bytes, fix mode, repeat idempotently and remove', async (t) => {
  const { root, absolutePath, plan } = await fixture(t);
  const content = '#!/bin/sh\necho owner\n';
  await preflightHostHooks(root, [plan(null, content)]);
  assert.deepEqual(await applyHostHooks(root, [plan(null, content)]), ['.git/hooks/pre-commit']);
  assert.equal(await readFile(absolutePath, 'utf8'), content);
  assert.equal((await lstat(absolutePath)).mode & 0o777, 0o755);
  assert.deepEqual(await applyHostHooks(root, [plan(content, content)]), []);
  await chmod(absolutePath, 0o644);
  assert.deepEqual(await applyHostHooks(root, [plan(content, content)]), ['.git/hooks/pre-commit']);
  assert.equal((await lstat(absolutePath)).mode & 0o777, 0o755);
  assert.deepEqual(await applyHostHooks(root, [plan(content, null)]), ['.git/hooks/pre-commit']);
  await assert.rejects(lstat(absolutePath), { code: 'ENOENT' });
  assert.deepEqual(await applyHostHooks(root, [plan(null, null)]), []);
});

test('changed preimages and arbitrary Git metadata paths are rejected without writes', async (t) => {
  const { root, absolutePath, plan } = await fixture(t);
  await writeFile(absolutePath, 'owner');
  await assert.rejects(preflightHostHooks(root, [plan('stale', 'new')]), /preimage/);
  await assert.rejects(applyHostHooks(root, [plan('stale', null)]), /preimage/);
  await assert.rejects(applyHostHooks(root, [plan('owner', 'new', { absolutePath: join(root, '.git/config') })]), /actual Git pre-commit/);
  await assert.rejects(applyHostHooks(root, [plan('owner', 'new', { path: '.git/config' })]), /actual Git pre-commit/);
  await assert.rejects(applyHostHooks(root, [plan('owner', 'new'), plan('owner', 'other')]), /Duplicate/);
  assert.equal(await readFile(absolutePath, 'utf8'), 'owner');
});

test('missing hook directory is created safely and malformed plans cannot write', async (t) => {
  const { root, absolutePath, plan } = await fixture(t);
  await rm(join(root, '.git/hooks'), { recursive: true });
  await assert.rejects(applyHostHooks(root, [plan(null, 'new', { mode: 0o4755 })]), /Invalid host file mode/);
  await assert.rejects(applyHostHooks(root, [plan(null, 'new', { before: undefined })]), /Malformed host hook plan/);
  await assert.rejects(lstat(join(root, '.git/hooks')), { code: 'ENOENT' });
  await applyHostHooks(root, [plan(null, 'new')]);
  assert.equal(await readFile(absolutePath, 'utf8'), 'new');
});

test('symlink hook files and shared hardlinks are rejected', async (t) => {
  const { root, parent, absolutePath, plan } = await fixture(t);
  const other = join(parent, 'owner');
  await writeFile(other, 'private');
  await symlink(other, absolutePath);
  await assert.rejects(applyHostHooks(root, [plan('private', 'changed')]), /independent regular file/);
  await rm(absolutePath);
  await link(other, absolutePath);
  await assert.rejects(applyHostHooks(root, [plan('private', null)]), /independent regular file/);
  assert.equal(await readFile(other, 'utf8'), 'private');
});

test('symlink hook parents are rejected even when the planned file is absent', async (t) => {
  const { root, parent, plan } = await fixture(t);
  await rm(join(root, '.git/hooks'), { recursive: true });
  const other = join(parent, 'external-hooks');
  await mkdir(other);
  await symlink(other, join(root, '.git/hooks'));
  await assert.rejects(applyHostHooks(root, [plan(null, 'new')]), /Unsafe host hook parent/);
  await assert.rejects(lstat(join(other, 'pre-commit')), { code: 'ENOENT' });
});

test('custom in-repo hooks path is honored and external custom hooks are preserved', async (t) => {
  const { root, parent, plan } = await fixture(t);
  await exec('git', ['-C', root, 'config', 'core.hooksPath', '.githooks']);
  const target = join(root, '.githooks/pre-commit');
  await applyHostHooks(root, [plan(null, 'new', { absolutePath: target })]);
  assert.equal(await readFile(target, 'utf8'), 'new');
  await assert.rejects(applyHostHooks(root, [plan(null, 'wrong')]), /actual Git pre-commit/);
  const outside = join(parent, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'pre-commit'), 'owner');
  await exec('git', ['-C', root, 'config', 'core.hooksPath', outside]);
  await assert.rejects(applyHostHooks(root, [plan('owner', 'changed', { absolutePath: join(outside, 'pre-commit') })]), /External core.hooksPath is unsupported/);
  assert.equal(await readFile(join(outside, 'pre-commit'), 'utf8'), 'owner');
});

test('linked worktrees use actual common Git hooks metadata, never a fake local .git folder', async (t) => {
  const { root, parent, absolutePath, plan } = await fixture(t);
  await writeFile(join(root, 'README'), 'fixture');
  await exec('git', ['-C', root, 'add', 'README']);
  await exec('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial']);
  const worktree = join(parent, 'worktree');
  await exec('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'fixture-worker', worktree]);
  assert.ok((await lstat(join(worktree, '.git'))).isFile());
  assert.deepEqual(await applyHostHooks(worktree, [plan(null, 'linked-hook')]), ['.git/hooks/pre-commit']);
  assert.equal(await readFile(absolutePath, 'utf8'), 'linked-hook');
  await assert.rejects(applyHostHooks(worktree, [plan(null, 'wrong', { absolutePath: join(worktree, '.git/hooks/pre-commit') })]), /actual Git pre-commit/);
});

test('empty plans need no Git repository', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'block-beaver-no-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await preflightHostHooks(directory, []), []);
  assert.deepEqual(await applyHostHooks(directory, []), []);
  assert.deepEqual(await preflightProjectModes(directory, []), []);
  assert.deepEqual(await applyProjectModes(directory, []), []);
});

test('ordinary hook file modes validate writer preimages and exact outputs', async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, '.husky'));
  const path = join(root, '.husky/pre-commit');
  const file = { path: '.husky/pre-commit', before: null, content: '#!/bin/sh\naudit\n', mode: 0o755 };
  await preflightProjectModes(root, [file]);
  await writeFile(path, file.content, { mode: 0o644 });
  assert.deepEqual(await applyProjectModes(root, [file]), ['.husky/pre-commit']);
  assert.equal((await lstat(path)).mode & 0o777, 0o755);
  assert.deepEqual(await applyProjectModes(root, [file]), []);
  await assert.rejects(preflightProjectModes(root, [file]), /preimage/);
  await writeFile(path, 'changed owner bytes');
  await chmod(path, 0o644);
  await assert.rejects(applyProjectModes(root, [file]), /writer output changed/);
  assert.equal((await lstat(path)).mode & 0o777, 0o644);
});

test('project mode plans preflight all outputs and refuse unsafe, shared and symlinked files', async (t) => {
  const { root, parent } = await fixture(t);
  const first = join(root, 'first');
  await writeFile(first, 'first', { mode: 0o644 });
  const files = [{ path: 'first', before: 'first', content: 'first', mode: 0o755 }, { path: 'missing', before: null, content: 'missing', mode: 0o755 }];
  await assert.rejects(applyProjectModes(root, files), /writer output changed/);
  assert.equal((await lstat(first)).mode & 0o777, 0o644);
  for (const path of ['../outside', '.git/config', '/tmp/outside', 'bad\\path']) {
    await assert.rejects(applyProjectModes(root, [{ path, content: 'first', mode: 0o755 }]), /Unsafe project mode path/);
  }
  await link(first, join(parent, 'linked'));
  await assert.rejects(applyProjectModes(root, [files[0]]), /independent regular file/);
  await rm(first);
  await symlink(join(parent, 'linked'), first);
  await assert.rejects(applyProjectModes(root, [files[0]]), /independent regular file/);
});
