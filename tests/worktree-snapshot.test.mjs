import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWorktreeSnapshot, compareWorktreeSnapshots } from '../src/worktree-snapshot.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-snapshot-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, '.gitignore'), '.blocks/\n');
  await writeFile(join(root, 'src', 'existing.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'src', 'old.ts'), 'export const old = 1;\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const manifestPath = '.blocks/manifests/example.json';
  await mkdir(join(root, '.blocks', 'manifests'), { recursive: true });
  await writeFile(join(root, manifestPath), '{"id":"example"}\n');
  return { root, baseCommit, manifestPath };
}

test('captures tracked changes, individual untracked files, deletions, modes, and ignored manifest', async () => {
  const { root, baseCommit, manifestPath } = await fixture();
  try {
    await writeFile(join(root, 'src', 'existing.ts'), 'export const value = 2;\n');
    await chmod(join(root, 'src', 'existing.ts'), 0o755);
    await rm(join(root, 'src', 'old.ts'));
    await mkdir(join(root, 'generated'));
    await writeFile(join(root, 'generated', 'new.json'), '{"new":true}\n');
    if (process.platform !== 'win32') await writeFile(join(root, 'generated', 'odd\nname.txt'), 'odd\n');
    const snapshot = await captureWorktreeSnapshot(root, baseCommit, manifestPath);
    assert.deepEqual(snapshot.files.map((entry) => entry.path), [manifestPath, 'generated/new.json', ...(process.platform === 'win32' ? [] : ['generated/odd\nname.txt']), 'src/existing.ts', 'src/old.ts']);
    assert.deepEqual(snapshot.files.find((entry) => entry.path === 'src/old.ts'), { path: 'src/old.ts', type: 'deleted', mode: null, sha256: null });
    assert.deepEqual(snapshot.files.find((entry) => entry.path === 'src/existing.ts'), { path: 'src/existing.ts', type: 'file', mode: (await lstat(join(root, 'src', 'existing.ts'))).mode.toString(8), sha256: hash('export const value = 2;\n') });
    assert.equal(snapshot.files.find((entry) => entry.path === manifestPath).sha256, hash(await readFile(join(root, manifestPath))));
    assert.equal(snapshot.digest, hash(JSON.stringify({ baseCommit, files: snapshot.files })));
    assert.deepEqual(await captureWorktreeSnapshot(root, baseCommit, join(root, manifestPath)), snapshot);

    await writeFile(join(root, 'generated', 'extra.ts'), 'export {};\n');
    await chmod(join(root, 'src', 'existing.ts'), 0o644);
    const changed = await captureWorktreeSnapshot(root, baseCommit, manifestPath);
    const modeChanged = snapshot.files.find((entry) => entry.path === 'src/existing.ts').mode !== changed.files.find((entry) => entry.path === 'src/existing.ts').mode;
    assert.deepEqual(compareWorktreeSnapshots(snapshot, changed), { equal: false, added: ['generated/extra.ts'], removed: [], changed: modeChanged ? ['src/existing.ts'] : [] });
    assert.deepEqual(compareWorktreeSnapshots(snapshot, snapshot), { equal: true, added: [], removed: [], changed: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('records both sides of a rename and hashes symlink targets without following them', async () => {
  const { root, baseCommit, manifestPath } = await fixture();
  try {
    await rename(join(root, 'src', 'old.ts'), join(root, 'src', 'renamed.ts'));
    await symlink('/outside/secret.txt', join(root, 'src', 'link.ts'));
    const snapshot = await captureWorktreeSnapshot(root, baseCommit, manifestPath);
    assert.equal(snapshot.files.find((entry) => entry.path === 'src/old.ts').type, 'deleted');
    assert.equal(snapshot.files.find((entry) => entry.path === 'src/renamed.ts').type, 'file');
    const link = snapshot.files.find((entry) => entry.path === 'src/link.ts');
    assert.equal(link.type, 'symlink');
    assert.match(link.mode, /^120/);
    assert.equal(link.sha256, hash(await readlink(join(root, 'src', 'link.ts'), { encoding: 'buffer' })));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects tracked edits hidden by assume-unchanged or skip-worktree', async () => {
  const { root, baseCommit, manifestPath } = await fixture();
  try {
    const expected = await captureWorktreeSnapshot(root, baseCommit, manifestPath);
    assert.deepEqual(expected.files.map((entry) => entry.path), [manifestPath]);
    for (const [on, off] of [['--assume-unchanged', '--no-assume-unchanged'], ['--skip-worktree', '--no-skip-worktree']]) {
      git(root, 'update-index', on, 'src/old.ts');
      await writeFile(join(root, 'src', 'old.ts'), `export const hidden = ${JSON.stringify(on)};\n`);
      await assert.rejects(captureWorktreeSnapshot(root, baseCommit, manifestPath), /assume-unchanged or skip-worktree/);
      git(root, 'update-index', off, 'src/old.ts');
      await writeFile(join(root, 'src', 'old.ts'), 'export const old = 1;\n');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects escaping paths, symlink parents, missing manifest, and moved HEAD', async () => {
  const { root, baseCommit, manifestPath } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'block-beaver-outside-'));
  try {
    const aliasedRoot = join(outside, 'worktree-alias');
    await symlink(root, aliasedRoot);
    await assert.rejects(captureWorktreeSnapshot(aliasedRoot, baseCommit, manifestPath), /root cannot be a symlink/);
    await assert.rejects(captureWorktreeSnapshot(root, baseCommit, '../outside.json'), /escapes the worktree/);
    await assert.rejects(captureWorktreeSnapshot(root, baseCommit, join(outside, 'outside.json')), /escapes the worktree/);
    await rm(join(root, manifestPath));
    await assert.rejects(captureWorktreeSnapshot(root, baseCommit, manifestPath), /manifest is missing/);
    const preflight = await captureWorktreeSnapshot(root, baseCommit, manifestPath, { allowMissingManifest: true });
    assert.deepEqual(preflight.files, [{ path: manifestPath, type: 'deleted', mode: null, sha256: null }]);
    await writeFile(join(root, manifestPath), '{}\n');

    await rm(join(root, 'src'), { recursive: true });
    await symlink(outside, join(root, 'src'));
    await assert.rejects(captureWorktreeSnapshot(root, baseCommit, manifestPath), /symlink parent/);
    await rm(join(root, 'src'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'existing.ts'), 'export const value = 1;\n');
    await writeFile(join(root, 'src', 'old.ts'), 'export const old = 1;\n');
    await writeFile(join(root, 'src', 'new.ts'), 'export {};\n');
    git(root, 'add', 'src/new.ts');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'move head');
    await assert.rejects(captureWorktreeSnapshot(root, baseCommit, manifestPath), /HEAD changed/);
    const moved = await captureWorktreeSnapshot(root, baseCommit, manifestPath, { allowHeadChange: true });
    assert.equal(moved.baseCommit, baseCommit);
    assert.deepEqual(moved.files.map((entry) => entry.path), [manifestPath, 'src/new.ts']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
