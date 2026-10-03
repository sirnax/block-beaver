import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
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

test('kit CLI generation failure after scaffold writes rolls everything back with status 2', async (t) => {
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
  assert.equal(result.status, 2, JSON.stringify(result.json));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.code, 'generator-failed');
  const details = result.json.error.details;
  assert.deepEqual(details.written, []);
  assert.equal(details.rolledBack, true);
  assert.deepEqual(details.manualSteps, ['Review new-item manually', 'Write the database migration for new-item']);
  assert.ok(details.cause.diagnostics.some((item) => item.message.includes('fixture generator refuses new-item')));
  for (const path of ['units/new-item.entry.ts', 'source/new-item.ts', 'migration.sql']) await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'generated/count.json'), 'utf8'), outputBefore);
  assert.deepEqual(run(root, ['kit', 'list']).json.result.blocks, []);
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

async function computedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-kit-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root], { encoding: 'utf8' }).status, 0);
  await mkdir(join(root, '.blocks')); await mkdir(join(root, 'units')); await mkdir(join(root, 'fixtures'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'kit-plan-fixture', type: 'module' }));
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({
    schemaVersion: 1, apps: [],
    families: [{ id: 'sample', contract: 'sample.family.ts', manifests: 'units/*.entry.ts', generators: ['count.generator.ts'] }],
  }));
  await writeFile(join(root, 'fixtures/types.json'), '{\n  "types": [\n    "first"\n  ]\n}\n');
  await writeFile(join(root, 'units/first.entry.ts'), 'export default { id: "first", family: "sample", version: 1, name: "first", description: "first", rationale: "seed", order: 5, implementation: { kind: "none" } };\n');
  await writeFile(join(root, 'outside.txt'), 'secret');
  await writeFile(join(root, 'sample.family.ts'), `import { defineFamily, s } from 'block-beaver/kernel';
import { createHash } from 'node:crypto';
export default defineFamily({
  id: 'sample', fields: s.object({ order: s.number() }), implementation: ['none'],
  check(manifest) { return manifest.order > 100 ? [{ path: '$.order', message: 'order too large' }] : undefined; },
  scaffold: {
    manualSteps: ['static step ignored for computed'],
    async plan(input, { all, readFile, id }) {
      const types = await readFile('fixtures/types.json');
      if (input.escape) await readFile(input.escape);
      const order = input.order ?? Math.max(0, ...all.map((item) => item.order)) + 1;
      const next = JSON.stringify({ types: [...JSON.parse(types).types, id] }, null, 2) + '\\n';
      const before = input.stale ? 'sha256:' + '0'.repeat(64) : 'sha256:' + createHash('sha256').update(types).digest('hex');
      return {
        files: [{ path: 'units/' + id + '.entry.ts', content: 'export default ' + JSON.stringify({ id, family: 'sample', version: 1, name: id, description: id, rationale: input.rationale ?? 'r', order, implementation: { kind: 'none' } }) + ';\\n' }],
        updates: [{ path: 'fixtures/types.json', content: next, before }],
        manualSteps: ['Write the migration for ' + id],
      };
    },
  },
});\n`);
  await writeFile(join(root, 'count.generator.ts'), `import { defineGenerator } from 'block-beaver/kernel';
export default defineGenerator({
  out: 'generated/count.json', inputs: ['units/*.entry.ts'],
  generate(ctx) {
    const manifests = ctx.manifests('sample');
    if (manifests.some((manifest) => manifest.id === 'boom')) throw new Error('fixture generator refuses boom');
    return JSON.stringify({ count: manifests.length });
  }
});\n`);
  return root;
}

const typesFile = (root) => readFile(join(root, 'fixtures/types.json'), 'utf8');

test('computed scaffold numbers the block, creates its manifest, updates an existing file and runs gen', async (t) => {
  const root = await computedFixture(t);
  const before = await typesFile(root);
  const result = run(root, ['kit', 'create', 'sample', 'second', '--input', '{}']);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json.result.manualSteps, ['Write the migration for second']);
  assert.deepEqual(result.json.result.updated.map((file) => file.path), ['fixtures/types.json']);
  assert.match(await readFile(join(root, 'units/second.entry.ts'), 'utf8'), /"order":6/);
  assert.deepEqual(JSON.parse(await typesFile(root)).types, ['first', 'second']);
  assert.notEqual(await typesFile(root), before);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'generated/count.json'), 'utf8')), { count: 2 });
});

test('computed scaffold --input-file and dry-run show creates and a diff without writing', async (t) => {
  const root = await computedFixture(t);
  const before = await typesFile(root);
  await writeFile(join(root, 'input.json'), '{"order":9}');
  const result = run(root, ['kit', 'create', 'sample', 'second', '--input-file', 'input.json', '--dry-run']);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.ok(result.json.result.written.some((file) => file.path === 'units/second.entry.ts'));
  const diff = result.json.result.updated[0].diff;
  assert.match(diff, /^--- a\/fixtures\/types\.json/);
  assert.match(diff, /^\+    "second"/m);
  assert.match(diff, /^-    "first"$/m);
  assert.equal(await typesFile(root), before);
  await assert.rejects(readFile(join(root, 'units/second.entry.ts')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'generated/count.json')), { code: 'ENOENT' });
});

test('computed scaffold refuses a stale before hash and writes nothing', async (t) => {
  const root = await computedFixture(t);
  const before = await typesFile(root);
  const result = run(root, ['kit', 'create', 'sample', 'second', '--input', '{"stale":true}']);
  assert.equal(result.status, 2);
  assert.equal(result.json.error.code, 'scaffold-stale');
  assert.equal(await typesFile(root), before);
  await assert.rejects(readFile(join(root, 'units/second.entry.ts')), { code: 'ENOENT' });
});

test('computed scaffold with an invalid planned manifest writes nothing', async (t) => {
  const root = await computedFixture(t);
  const before = await typesFile(root);
  for (const args of [['--input', '{"order":"x"}'], ['--input', '{"order":500}'], ['--input', '{"order":500}', '--dry-run']]) {
    const result = run(root, ['kit', 'create', 'sample', 'second', ...args]);
    assert.equal(result.status, 2, JSON.stringify(result.json));
    assert.equal(result.json.error.code, 'manifest-schema');
    assert.equal(await typesFile(root), before);
    await assert.rejects(readFile(join(root, 'units/second.entry.ts')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, 'generated/count.json')), { code: 'ENOENT' });
  }
});

test('computed scaffold rolls back creates and updates when generation fails', async (t) => {
  const root = await computedFixture(t);
  const before = await typesFile(root);
  assert.equal(run(root, ['gen']).status, 0);
  const generated = await readFile(join(root, 'generated/count.json'), 'utf8');
  const result = run(root, ['kit', 'create', 'sample', 'boom', '--input', '{}']);
  assert.equal(result.status, 2, JSON.stringify(result.json));
  assert.equal(result.json.error.code, 'generator-failed');
  assert.equal(result.json.error.details.rolledBack, true);
  assert.equal(await typesFile(root), before);
  await assert.rejects(readFile(join(root, 'units/boom.entry.ts')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'generated/count.json'), 'utf8'), generated);
});

test('computed scaffold readFile cannot escape the project root or follow symlinks', async (t) => {
  const root = await computedFixture(t);
  const before = await typesFile(root);
  await symlink(join(root, 'outside.txt'), join(root, 'link.txt'));
  for (const escape of ['../outside.txt', '/etc/hosts', 'link.txt']) {
    const result = run(root, ['kit', 'create', 'sample', 'second', '--input', JSON.stringify({ escape })]);
    assert.equal(result.status, 2, JSON.stringify(result.json));
    assert.equal(result.json.error.code, 'scaffold-plan-failed');
    assert.equal(await typesFile(root), before);
  }
});
