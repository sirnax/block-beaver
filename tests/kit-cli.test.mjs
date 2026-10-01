import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/block-beaver.mjs', import.meta.url));

function run(root, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args, '--root', root], {
    encoding: 'utf8', input, timeout: 30_000, maxBuffer: 2_000_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  let json;
  try { json = JSON.parse(result.stdout); }
  catch { assert.fail(`CLI stdout must contain a single JSON document: ${result.stdout}\n${result.stderr}`); }
  return { status: result.status, json };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-kit-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  await mkdir(join(root, '.blocks'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'kit-cli-fixture', type: 'module' }));
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({
    schemaVersion: 1, apps: [],
    families: [{ id: 'sample', contract: 'sample.family.ts', manifests: 'units/*.entry.ts', generators: ['count.generator.ts'] }],
  }));
  const family = {
    id: 'sample', fields: { type: 'object', shape: {} }, implementation: ['module'],
    scaffold: {
      files: [
        { path: 'units/{{id}}.entry.ts', template: 'export default { id: {{json.id}}, family: {{json.family}}, version: 1, name: {{json.name}}, description: {{json.description}}, rationale: {{json.rationale}}, implementation: { kind: "module", module: "../source/{{id}}.ts" } };\n' },
        { path: 'source/{{id}}.ts', template: 'export const name = {{json.name}};\n' },
      ],
      manualSteps: ['Review {{id}} manually', 'Write the database migration for {{id}}'],
    },
  };
  await writeFile(join(root, 'sample.family.ts'), `import { defineFamily } from 'block-beaver/kernel';\nexport default defineFamily(${JSON.stringify(family)});\n`);
  await writeFile(join(root, 'count.generator.ts'), `import { defineGenerator } from 'block-beaver/kernel';
export default defineGenerator({
  out: 'generated/count.json', inputs: ['units/*.entry.ts'],
  generate(ctx) {
    const manifests = ctx.manifests('sample');
    if (manifests.some((manifest) => manifest.id === 'new-item')) throw new Error('fixture generator refuses new-item');
    return JSON.stringify({ count: manifests.length });
  }
});\n`);
  return root;
}

test('kit CLI malformed argv and stdin JSON return the named JSON error with status 2', async (t) => {
  const root = await fixture(t);
  for (const [args, input] of [
    [['kit', 'list', '--json', '{'], undefined],
    [['kit', 'list', '--json', '-'], '{"family":'],
    [['kit', 'list', '--json', '-'], ''],
  ]) {
    const result = run(root, args, input);
    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, 'kit-input-invalid');
    assert.equal(typeof result.json.error.message, 'string');
    assert.equal(result.json.error.details?.written, undefined);
  }
  for (const path of ['units/new-item.entry.ts', 'source/new-item.ts', 'generated/count.json']) {
    await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
  }
});

test('kit CLI JSON shape and prewrite scaffold errors use status 2 and leave files absent', async (t) => {
  const root = await fixture(t);
  const invalidShape = run(root, ['kit', 'list', '--json', '[]']);
  assert.equal(invalidShape.status, 2);
  assert.equal(invalidShape.json.error.code, 'kit-input-invalid');
  const missingRationale = run(root, ['kit', 'create', 'sample', 'new-item', '--json', '{}']);
  assert.equal(missingRationale.status, 2);
  assert.equal(missingRationale.json.error.code, 'manifest-schema');
  assert.equal(missingRationale.json.error.details?.written, undefined);
  for (const path of ['units/new-item.entry.ts', 'source/new-item.ts']) {
    await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
  }
});

test('kit CLI generation failure after scaffold writes uses status 1 and reports retained files and manual steps', async (t) => {
  const root = await fixture(t);
  const listed = run(root, ['kit', 'list']);
  assert.equal(listed.status, 0);
  assert.equal(listed.json.ok, true);
  assert.deepEqual(listed.json.result.blocks, []);
  // The generator really executes successfully before the new manifest exists.
  const generated = run(root, ['gen']);
  assert.equal(generated.status, 0, JSON.stringify(generated.json));
  const outputBefore = await readFile(join(root, 'generated/count.json'), 'utf8');
  assert.deepEqual(JSON.parse(outputBefore), { count: 0 });

  const result = run(root, ['kit', 'create', 'sample', 'new-item', '--json', '-'], JSON.stringify({ rationale: 'Exercise partial creation', name: 'New item' }));
  assert.equal(result.status, 1, JSON.stringify(result.json));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.code, 'generator-failed');
  const details = result.json.error.details;
  assert.deepEqual(details.written.map((file) => file.path), ['units/new-item.entry.ts', 'source/new-item.ts']);
  assert.deepEqual(details.manualSteps, ['Review new-item manually', 'Write the database migration for new-item']);
  assert.ok(details.cause.diagnostics.some((item) => item.message.includes('fixture generator refuses new-item')));
  for (const file of details.written) {
    const content = await readFile(join(root, file.path), 'utf8');
    assert.equal(Buffer.byteLength(content), file.bytes);
  }
  assert.match(await readFile(join(root, 'units/new-item.entry.ts'), 'utf8'), /Exercise partial creation/);
  assert.equal(await readFile(join(root, 'source/new-item.ts'), 'utf8'), 'export const name = "New item";\n');
  assert.equal(await readFile(join(root, 'generated/count.json'), 'utf8'), outputBefore);
  await assert.rejects(readFile(join(root, 'migration.sql')), { code: 'ENOENT' });

  // The partial result is visible on the next independent CLI process; retry
  // reports the existing manifest instead of replacing the retained scaffold.
  const reloaded = run(root, ['kit', 'list']);
  assert.equal(reloaded.status, 0);
  assert.equal(reloaded.json.result.blocks[0].ref, 'sample:new-item');
  const retried = run(root, ['kit', 'create', 'sample', 'new-item', '--json', '{"rationale":"Retry"}']);
  assert.equal(retried.status, 2);
  assert.equal(retried.json.error.code, 'create-exists');
  assert.equal(retried.json.error.details.written, undefined);
  assert.match(await readFile(join(root, 'units/new-item.entry.ts'), 'utf8'), /Exercise partial creation/);
});

test('kit CLI dry-run generation failure uses status 2 and leaves the target untouched', async (t) => {
  const root = await fixture(t);
  const result = run(root, ['kit', 'create', 'sample', 'new-item', '--json', '{"rationale":"Preview only"}', '--dry-run']);
  assert.equal(result.status, 2);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.code, 'generator-failed');
  for (const path of ['units/new-item.entry.ts', 'source/new-item.ts', 'generated/count.json', '.blocks/cache/generators.json']) {
    await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
  }
});
