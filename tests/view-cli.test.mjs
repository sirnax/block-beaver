import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/block-beaver.mjs', import.meta.url));
test('CLI exports a deterministic embeddable module and reports its size', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-view-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/index.ts'), 'export const feature = 1;\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ main: 'src/index.ts' }));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' }));
  const first = run('view', '--format', 'module', '--out', 'snapshot.mjs');
  const content = await readFile(join(root, 'snapshot.mjs'), 'utf8');
  const exported = await import(pathToFileURL(join(root, 'snapshot.mjs')).href);
  assert.match(exported.BLOCK_BEAVER_VIEW, /nonce="__BLOCK_BEAVER_NONCE__"/);
  assert.match(exported.BLOCK_BEAVER_VIEW, /<!--block-beaver:host-header-->/);
  assert.equal(first.bytes, Buffer.byteLength(content));
  assert.deepEqual(run('view', '--format', 'module', '--out', 'snapshot.mjs').changed, []);
  assert.equal(await readFile(join(root, 'snapshot.mjs'), 'utf8'), content);
  assert.ok(run('scan').summary.viewModuleBytes > 0);
  await writeFile(join(root, 'owned.mjs'), 'export const mine = true;\n');
  assert.throws(() => run('view', '--format', 'module', '--out', 'owned.mjs'), /conflicts/);
  assert.throws(() => run('view', '--format', 'module', '--out', '../escape.mjs'), /inside/);
});
