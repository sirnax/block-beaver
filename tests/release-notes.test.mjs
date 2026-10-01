import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('release notes contain only the matching version and reject a mismatched tag', async t => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-release-notes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const output = join(root, 'notes.md');
  const result = spawnSync(process.execPath, [script, `v${pkg.version}`, output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const notes = await readFile(output, 'utf8');
  assert.ok(notes.trim().length > 0);
  assert.ok(notes.endsWith('\n'));
  assert.doesNotMatch(notes, /^## /m);
  assert.doesNotMatch(notes, /Remove a separate file metadata check/);
  const rejected = join(root, 'wrong.md');
  const mismatch = spawnSync(process.execPath, [script, 'v999.0.0', rejected], { encoding: 'utf8' });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /tag must match/);
  await assert.rejects(access(rejected), { code: 'ENOENT' });
});
