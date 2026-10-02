import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/block-beaver.mjs', import.meta.url));
const PIPE_BUFFER = 65_536;

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

// Commits a small project so audit has a base; callers add the files that make output large.
async function fixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Test']);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'cli-output-fixture', type: 'module' }));
  await writeFile(join(root, 'src/index.mjs'), 'export const ready = true;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

// Audit costs a few ms per untracked file (several times that on Windows) and emits about 235 bytes plus the path, so 250 files with
// long names clear the 64 KB pipe buffer without risking the spawn timeout.
async function writeMany(dir, count, name, content) {
  await mkdir(dir, { recursive: true });
  for (let start = 0; start < count; start += 200) {
    await Promise.all(Array.from({ length: Math.min(200, count - start) }, (_, offset) => writeFile(join(dir, name(start + offset)), content(start + offset))));
  }
}

// spawnSync pipes stdout, so output beyond the OS pipe buffer is where truncation shows.
function run(root, args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16e6 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

test('audit JSON larger than the pipe buffer is not truncated', async (t) => {
  const root = await fixture(t, 'block-beaver-cli-output-audit-');
  await writeMany(join(root, 'notes'), 250, (i) => `${`n-${i}-`.padEnd(100, 'x')}.txt`, (i) => `note ${i}\n`);
  const result = run(root, ['audit']);
  assert.ok(result.stdout.length > PIPE_BUFFER, `fixture must exceed the pipe buffer, got ${result.stdout.length}`);
  assert.doesNotThrow(() => JSON.parse(result.stdout), 'audit stdout must be one complete JSON document');
  assert.equal(JSON.parse(result.stdout).pass, false);
  assert.equal(result.status, 2, result.stderr);
});

test('install --dry-run output larger than the pipe buffer is not truncated', async (t) => {
  const root = await fixture(t, 'block-beaver-cli-output-install-');
  await writeMany(join(root, 'src/modules'), 1500, (i) => `m${i}.mjs`, (i) => `export const value${i} = ${i};\n`);
  const result = run(root, ['install', '--dry-run']);
  assert.ok(result.stdout.length > PIPE_BUFFER, `fixture must exceed the pipe buffer, got ${result.stdout.length}`);
  assert.doesNotThrow(() => JSON.parse(result.stdout), 'install stdout must be one complete JSON document');
  assert.equal(JSON.parse(result.stdout).dryRun, true);
});

test('audit --format summary prints one line on pass and per-error lines on failure', async (t) => {
  const root = await fixture(t, 'block-beaver-cli-output-summary-');
  await mkdir(join(root, '.blocks'));
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], enforcement: { receipts: 'optional' } }));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'config']);
  await writeFile(join(root, 'src/more.mjs'), 'export const more = 1;\n');
  git(root, ['add', '-A']);
  const pass = run(root, ['audit', '--staged', '--format', 'summary']);
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.equal(pass.stdout, 'block-beaver audit: pass (1 files, 0 errors)\n');
  assert.equal(JSON.parse(run(root, ['audit', '--staged', '--format', 'json']).stdout).pass, true);
  assert.equal(JSON.parse(run(root, ['audit', '--staged']).stdout).pass, true);

  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], enforcement: { receipts: 'required' } }));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'required']);
  await writeFile(join(root, 'src/direct.mjs'), 'export const direct = 1;\n');
  git(root, ['add', '-A']);
  const fail = run(root, ['audit', '--staged', '--format', 'summary']);
  assert.equal(fail.status, 2, fail.stderr);
  assert.deepEqual(fail.stdout.trimEnd().split('\n'), ['block-beaver audit: fail (1 files, 1 error)', 'reviewed-content · src/direct.mjs · unreviewed-source - fix: review it in a block slice (plan, check, review, approve) or record an exception with block-beaver exception']);
});

test('audit rejects an unknown format', async (t) => {
  const root = await fixture(t, 'block-beaver-cli-output-format-');
  const result = run(root, ['audit', '--format', 'xml']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown audit format/);
  assert.equal(result.stdout, '');
});
