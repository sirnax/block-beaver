import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
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

async function viewProject(t) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-view-detail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/index.ts'), 'export const feature = 1;\n');
  await writeFile(join(root, 'src/other.ts'), 'import { feature } from "./index";\nexport const other = feature;\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ main: 'src/index.ts' }));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' }));
  const fail = (...args) => { try { execFileSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8', stdio: 'pipe' }); } catch (error) { return error; } assert.fail('Expected the command to fail.'); };
  const registry = async () => JSON.parse(await readFile(join(root, '.blocks/view-exports.json'), 'utf8'));
  return { root, run, fail, registry };
}

test('view --detail map writes a map-only module, records detail only when not full, and upserts it', async (t) => {
  const { root, run, registry } = await viewProject(t);
  const full = run('view', '--format', 'module', '--out', 'snapshot.mjs');
  assert.equal(full.detail, 'full');
  assert.deepEqual(await registry(), [{ path: 'snapshot.mjs', format: 'module' }], 'full detail keeps the 0.6.0 registry bytes');
  const fullModule = await readFile(join(root, 'snapshot.mjs'), 'utf8');
  const { renderViewModule } = await import('../src/view-exports.mjs');
  const { updateProject } = await import('../src/block-map.mjs');
  assert.equal(fullModule, renderViewModule((await updateProject(root)).graph), 'default output is the unchanged full module');
  const map = run('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'map');
  assert.equal(map.detail, 'map');
  assert.deepEqual(await registry(), [{ path: 'snapshot.mjs', format: 'module', detail: 'map' }], 'an existing entry is updated');
  const mapModule = await readFile(join(root, 'snapshot.mjs'), 'utf8');
  assert.ok(mapModule.length < fullModule.length && !mapModule.includes('class=\\"files\\"'));
  assert.equal(map.bytes, Buffer.byteLength(mapModule));
  assert.deepEqual(run('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'map').changed, [], 'unchanged on rerun');
  assert.deepEqual(run('view', '--format', 'module', '--out', 'snapshot.mjs'), { ...map, changed: [] }, 'without a flag the recorded detail is kept');
  assert.deepEqual(await registry(), [{ path: 'snapshot.mjs', format: 'module', detail: 'map' }]);
  const exported = await import(pathToFileURL(join(root, 'snapshot.mjs')).href + '?map');
  for (const id of ['search', 'app-filter', 'cross-app-links']) assert.ok(exported.BLOCK_BEAVER_VIEW.includes(`id="${id}"`));
  run('view', '--format', 'module', '--out', 'second.mjs');
  assert.deepEqual(await registry(), [{ path: 'second.mjs', format: 'module' }, { path: 'snapshot.mjs', format: 'module', detail: 'map' }]);
  assert.equal(run('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'full').detail, 'full');
  assert.deepEqual(await registry(), [{ path: 'second.mjs', format: 'module' }, { path: 'snapshot.mjs', format: 'module' }], 'detail is dropped again when it returns to full');
  assert.equal(await readFile(join(root, 'snapshot.mjs'), 'utf8'), fullModule);
});

test('view rejects an unknown detail and a malformed byte limit before writing anything', async (t) => {
  const { root, fail } = await viewProject(t);
  for (const args of [['--detail', 'tiny'], ['--max-bytes', '0'], ['--max-bytes', '12k'], ['--max-bytes', '-5']]) {
    const error = fail('view', '--format', 'module', '--out', 'snapshot.mjs', ...args);
    assert.equal(error.status, 1);
    assert.match(error.stderr, /--detail must be full or map|--max-bytes must be a positive integer/);
  }
  await assert.rejects(readFile(join(root, 'snapshot.mjs')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, '.blocks/view-exports.json')), { code: 'ENOENT' });
});

test('view --max-bytes fails deterministically above the limit and writes nothing', async (t) => {
  const { root, run, fail, registry } = await viewProject(t);
  const size = run('view', '--format', 'module', '--out', 'probe.mjs', '--detail', 'map').bytes;
  await rm(join(root, 'probe.mjs')); await rm(join(root, '.blocks/view-exports.json'));
  const error = fail('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'map', '--max-bytes', String(size - 1));
  assert.equal(error.status, 2);
  const result = JSON.parse(error.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'view-too-large');
  assert.match(result.error.message, new RegExp(`${size} bytes, over the ${size - 1} byte limit`));
  assert.deepEqual(result.error.details, { output: 'snapshot.mjs', bytes: size, limit: size - 1, detail: 'map' });
  assert.deepEqual(JSON.parse(fail('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'map', '--max-bytes', String(size - 1)).stdout), result, 'same failure every time');
  await assert.rejects(readFile(join(root, 'snapshot.mjs')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, '.blocks/view-exports.json')), { code: 'ENOENT' }, 'the registry is not created either');
  const ok = run('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'map', '--max-bytes', String(size));
  assert.equal(ok.bytes, size);
  assert.deepEqual(await registry(), [{ path: 'snapshot.mjs', format: 'module', detail: 'map' }]);
  // A registered module keeps its content and registry when a later, over-limit run fails.
  const written = await readFile(join(root, 'snapshot.mjs'), 'utf8');
  const registered = await readFile(join(root, '.blocks/view-exports.json'), 'utf8');
  assert.equal(fail('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'full', '--max-bytes', String(size)).status, 2);
  assert.equal(await readFile(join(root, 'snapshot.mjs'), 'utf8'), written);
  assert.equal(await readFile(join(root, '.blocks/view-exports.json'), 'utf8'), registered);
});

test('config view.detail sets the default and an explicit flag overrides it; an invalid value is refused', async (t) => {
  const { root, run, fail, registry } = await viewProject(t);
  await mkdir(join(root, '.blocks'));
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], view: { detail: 'map' } }));
  assert.equal(run('view', '--format', 'module', '--out', 'snapshot.mjs').detail, 'map');
  assert.deepEqual(await registry(), [{ path: 'snapshot.mjs', format: 'module', detail: 'map' }]);
  assert.equal(run('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'full').detail, 'full');
  assert.equal(run('view', '--format', 'module', '--out', 'snapshot.mjs').detail, 'full', 'config does not override an existing entry');
  assert.deepEqual(await registry(), [{ path: 'snapshot.mjs', format: 'module' }]);
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], view: { detail: 'huge' } }));
  const error = fail('view', '--format', 'module', '--out', 'fresh.mjs');
  assert.equal(error.status, 1);
  assert.match(error.stderr, /Config view\.detail must be full or map/);
  await assert.rejects(readFile(join(root, 'fresh.mjs')), { code: 'ENOENT' });
  assert.equal(run('view', '--format', 'module', '--out', 'fresh.mjs', '--detail', 'map').detail, 'map', 'a flag still works');
  assert.equal(run('view', '--format', 'module', '--out', 'snapshot.mjs').detail, 'full', 'an existing entry ignores a broken config default');
});

test('view --max-bytes measures the module that is written when only the legacy registry exists', async (t) => {
  const { root, run, fail, registry } = await viewProject(t);
  run('view', '--format', 'module', '--out', 'legacy.mjs');
  await mkdir(join(root, '.blocks/view'), { recursive: true });
  await rename(join(root, '.blocks/view-exports.json'), join(root, '.blocks/view/exports.json'));
  const size = run('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'map').bytes;
  assert.deepEqual(await registry(), [{ path: 'legacy.mjs', format: 'module' }, { path: 'snapshot.mjs', format: 'module', detail: 'map' }], 'legacy entries carry over');
  assert.equal(size, Buffer.byteLength(await readFile(join(root, 'snapshot.mjs'), 'utf8')));
  await rm(join(root, 'snapshot.mjs')); await rm(join(root, '.blocks/view-exports.json'));
  const error = fail('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'map', '--max-bytes', String(size - 1));
  assert.equal(error.status, 2);
  assert.equal(JSON.parse(error.stdout).error.details.bytes, size, 'preflight measures the final graph, legacy modules excluded');
  await assert.rejects(readFile(join(root, 'snapshot.mjs')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, '.blocks/view-exports.json')), { code: 'ENOENT' });
  const ok = run('view', '--format', 'module', '--out', 'snapshot.mjs', '--detail', 'map', '--max-bytes', String(size));
  assert.equal(ok.bytes, size);
  assert.equal(Buffer.byteLength(await readFile(join(root, 'snapshot.mjs'), 'utf8')), size, 'an exact-size budget holds for the bytes on disk');
});
