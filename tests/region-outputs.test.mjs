import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyGeneration, checkGeneration, planGeneration } from '../src/families/generate.mjs';
import { readCache } from '../src/families/cache.mjs';

const NOW = new Date('2026-10-01T12:00:00Z');

async function repo(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-region-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

function fakeLoader({ generators = [], manifests = [], outputs = {} } = {}) {
  const calls = [];
  const load = async (args) => {
    calls.push(args);
    const result = { key: 'fake', families: [], manifests, generators, loadedFiles: [], diagnostics: [] };
    if (args.generate) result.outputs = args.generate.keys.map((key) => ({ key, content: typeof outputs[key] === 'function' ? outputs[key]() : outputs[key] }));
    return result;
  };
  load.calls = calls;
  return load;
}
const custom = (path, { out, region, inputs = ['docs/*.md'], cache = true } = {}) => ({ key: `custom:${path}`, source: 'custom', path, out, ...(region ? { region } : {}), inputs, cache, closureHash: 'c1' });
const plan = (root, loader) => planGeneration({ root, config: {}, graph: { nodes: [], hashes: {} }, paths: [], label: null, now: NOW, loadFamilies: loader });
const codes = (result) => result.diagnostics.map((item) => item.code);
const generateCalls = (loader) => loader.calls.filter((call) => call.generate);

const readme = (badge = 'old badge', { before = '# Project\n\nHand intro.\n\n', after = '\nHand footer.\n' } = {}) =>
  `${before}<!-- block-beaver:region roadmap-badge -->\n${badge}\n<!-- /block-beaver:region roadmap-badge -->\n${after}`;
const badgeLoader = (content = '[badge](./docs/ROADMAP.md)', extra = {}) =>
  fakeLoader({ generators: [custom('gen/badge.ts', { out: 'README.md', region: 'roadmap-badge', ...extra })], outputs: { 'custom:gen/badge.ts': content } });

test('gen updates only the region of a hand-written README and adds no header', async (t) => {
  const root = await repo(t, { 'README.md': readme() });
  const result = await plan(root, badgeLoader());
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.outputs.length, 1);
  const [output] = result.outputs;
  assert.deepEqual({ key: output.key, out: output.out, region: output.region, status: output.status, regions: output.regions },
    { key: 'custom:gen/badge.ts', out: 'README.md', region: 'roadmap-badge', status: 'stale', regions: [{ key: 'custom:gen/badge.ts', region: 'roadmap-badge', status: 'stale' }] });
  assert.equal(output.expected, readme('[badge](./docs/ROADMAP.md)'));
  const applied = await applyGeneration(root, result);
  assert.deepEqual(applied.written, ['README.md']);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), readme('[badge](./docs/ROADMAP.md)'));
  const again = await plan(root, badgeLoader());
  assert.equal(again.outputs[0].status, 'cached');
  assert.deepEqual(checkGeneration(again), []);
});

test('gen --check reports drift only for the changed region, naming file and region', async (t) => {
  const root = await repo(t, { 'README.md': readme() });
  const drift = checkGeneration(await plan(root, badgeLoader()));
  assert.deepEqual(drift.map((item) => [item.code, item.file, item.region, item.message]),
    [['output-stale', 'README.md', 'roadmap-badge', 'README.md region roadmap-badge is out of date; run block-beaver gen']]);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), readme(), 'check never writes');
});

test('hand edits outside a region never drift and keep their bytes', async (t) => {
  const root = await repo(t, { 'README.md': readme('[badge](./docs/ROADMAP.md)') });
  const first = await plan(root, badgeLoader('[badge](./docs/ROADMAP.md)\n'));
  assert.equal(first.outputs[0].status, 'fresh');
  await applyGeneration(root, first);
  const edited = readme('[badge](./docs/ROADMAP.md)', { before: '# Renamed\n\nNew hand text.\n\n', after: '\nAnother footer.\n\nMore.\n' });
  await writeFile(join(root, 'README.md'), edited);
  const loader = badgeLoader('[badge](./docs/ROADMAP.md)');
  const result = await plan(root, loader);
  assert.equal(result.outputs[0].status, 'cached', 'the cache hashes only the region body');
  assert.equal(generateCalls(loader).length, 0);
  assert.deepEqual(checkGeneration(result), []);
  assert.deepEqual((await applyGeneration(root, result)).written, []);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), edited);
});

test('the cache entry of a region output hashes the region body, not the whole file', async (t) => {
  const root = await repo(t, { 'README.md': readme() });
  const { outputHash } = await import('../src/families/cache.mjs');
  const result = await plan(root, badgeLoader('one\ntwo\n'));
  assert.equal(readCache(result.cacheUpdate.content).entries['custom:gen/badge.ts'].outHash, outputHash('one\ntwo'));
});

test('a body-identical region keeps the exact file bytes, CRLF and indentation included', async (t) => {
  const text = '# Doc\r\n\r\n  <!-- block-beaver:region roadmap-badge -->  \r\nline one\r\nline two\r\n  <!-- /block-beaver:region roadmap-badge -->\r\ntail';
  const root = await repo(t, { 'README.md': text });
  const result = await plan(root, badgeLoader('line one\nline two\n', { cache: false }));
  assert.equal(result.outputs[0].status, 'fresh');
  assert.equal(result.outputs[0].expected, text);
  assert.deepEqual(checkGeneration(result), []);
  assert.deepEqual((await applyGeneration(root, result)).written, []);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), text);
});

test('a CRLF file stays CRLF when its region is rewritten, and markers keep their indentation', async (t) => {
  const root = await repo(t, { 'README.md': '# Doc\r\n\t<!-- block-beaver:region roadmap-badge -->\r\nold\r\n\t<!-- /block-beaver:region roadmap-badge -->\r\nend\r\n' });
  const result = await plan(root, badgeLoader('new one\r\nnew two'));
  await applyGeneration(root, result);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Doc\r\n\t<!-- block-beaver:region roadmap-badge -->\r\nnew one\r\nnew two\r\n\t<!-- /block-beaver:region roadmap-badge -->\r\nend\r\n');
});

test('empty region content leaves the markers adjacent', async (t) => {
  const root = await repo(t, { 'README.md': readme() });
  await applyGeneration(root, await plan(root, badgeLoader('\n')));
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Project\n\nHand intro.\n\n<!-- block-beaver:region roadmap-badge -->\n<!-- /block-beaver:region roadmap-badge -->\n\nHand footer.\n');
});

test('two generators own different regions of one file and compose into a single write', async (t) => {
  const text = 'top\n<!-- block-beaver:region alpha -->\na0\n<!-- /block-beaver:region alpha -->\nmiddle\n<!-- block-beaver:region beta -->\nb0\n<!-- /block-beaver:region beta -->\nbottom\n';
  const root = await repo(t, { 'docs/guide.md': text });
  const loader = fakeLoader({
    generators: [custom('gen/a.ts', { out: 'docs/guide.md', region: 'alpha' }), custom('gen/b.ts', { out: 'docs/guide.md', region: 'beta' })],
    outputs: { 'custom:gen/a.ts': 'a1', 'custom:gen/b.ts': 'b0' },
  });
  const result = await plan(root, loader);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].key, 'custom:gen/a.ts + custom:gen/b.ts');
  assert.equal(result.outputs[0].region, undefined);
  assert.deepEqual(result.outputs[0].regions.map((item) => [item.region, item.status]), [['alpha', 'stale'], ['beta', 'fresh']]);
  assert.deepEqual(checkGeneration(result).map((item) => item.region), ['alpha']);
  assert.deepEqual((await applyGeneration(root, result)).written, ['docs/guide.md']);
  assert.equal(await readFile(join(root, 'docs/guide.md'), 'utf8'), text.replace('a0', 'a1'));
});

test('missing markers or a missing file give region-missing and nothing is written', async (t) => {
  const cases = {
    'no markers': '# Project\n',
    'no end marker': '<!-- block-beaver:region roadmap-badge -->\nx\n',
    'no start marker': 'x\n<!-- /block-beaver:region roadmap-badge -->\n',
    'markers not on their own line': 'see <!-- block-beaver:region roadmap-badge --> here\n<!-- /block-beaver:region roadmap-badge -->\n',
    'another comment style': '// block-beaver:region roadmap-badge\nx\n// /block-beaver:region roadmap-badge\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    const root = await repo(t, { 'README.md': text, 'other.ts': '// generated by block-beaver; do not edit\nold\n' });
    const loader = fakeLoader({ generators: [custom('gen/badge.ts', { out: 'README.md', region: 'roadmap-badge' }), custom('gen/other.ts', { out: 'other.ts' })], outputs: { 'custom:gen/badge.ts': 'new', 'custom:gen/other.ts': 'new' } });
    const result = await plan(root, loader);
    assert.deepEqual(codes(result), ['region-missing'], name);
    assert.equal(result.diagnostics[0].rule, 'family-drift');
    assert.equal(result.diagnostics[0].severity, 'error');
    assert.deepEqual((await applyGeneration(root, result)).written, [], name);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), text, name);
  }
  const root = await repo(t);
  const result = await plan(root, badgeLoader());
  assert.deepEqual(codes(result), ['region-missing']);
  assert.match(result.diagnostics[0].message, /README\.md does not exist/);
  assert.deepEqual((await applyGeneration(root, result)).written, []);
});

test('duplicated, reversed or nested markers give region-duplicate and nothing is written', async (t) => {
  const start = '<!-- block-beaver:region roadmap-badge -->\n', end = '<!-- /block-beaver:region roadmap-badge -->\n';
  const cases = {
    'two starts': `${start}a\n${start}b\n${end}`,
    'two pairs': `${start}a\n${end}${start}b\n${end}`,
    reversed: `${end}a\n${start}`,
    nested: `${start}<!-- block-beaver:region inner -->\nx\n<!-- /block-beaver:region inner -->\n${end}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const root = await repo(t, { 'README.md': text });
    const result = await plan(root, badgeLoader());
    assert.deepEqual(codes(result), ['region-duplicate'], name);
    assert.deepEqual((await applyGeneration(root, result)).written, [], name);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), text, name);
  }
});

test('the same region claimed twice, or a whole file plus a region, is an output-collision', async (t) => {
  const root = await repo(t, { 'README.md': readme() });
  const twice = fakeLoader({ generators: [custom('gen/a.ts', { out: 'README.md', region: 'roadmap-badge' }), custom('gen/b.ts', { out: 'readme.md', region: 'roadmap-badge' })] });
  let result = await plan(root, twice);
  assert.deepEqual(codes(result), ['output-collision']);
  assert.equal(result.diagnostics[0].message, 'custom:gen/a.ts and custom:gen/b.ts all write README.md region roadmap-badge');
  const same = fakeLoader({ generators: [custom('gen/a.ts', { out: 'README.md', region: 'roadmap-badge' }), custom('gen/b.ts', { out: 'README.md', region: 'roadmap-badge' }), custom('gen/c.ts', { out: 'README.md', region: 'other' })] });
  result = await plan(root, same);
  assert.equal(result.diagnostics.find((item) => item.code === 'output-collision').message, 'custom:gen/a.ts and custom:gen/b.ts all write README.md region roadmap-badge');
  assert.ok(codes(result).includes('region-missing'), 'the uncontested region is still planned');
  const whole = fakeLoader({ generators: [custom('gen/a.ts', { out: 'README.md', region: 'roadmap-badge' }), custom('gen/b.ts', { out: 'README.md' })] });
  result = await plan(root, whole);
  assert.deepEqual(codes(result), ['output-collision']);
  assert.equal(result.diagnostics[0].message, 'custom:gen/a.ts and custom:gen/b.ts all write README.md');
  assert.equal(generateCalls(whole).length, 0);
  assert.deepEqual((await applyGeneration(root, result)).written, []);
});

test('region outputs follow the unsafe-path rules but may target hand-written guidance files', async (t) => {
  const root = await repo(t, { 'AGENTS.md': readme() });
  const loader = fakeLoader({
    manifests: [{ family: 'unit', id: 'a', ref: 'unit:a', path: 'catalog/a.md', exportName: 'default', hash: 'h', value: {} }],
    generators: [
      custom('gen/1.ts', { out: 'catalog/a.md', region: 'x' }), custom('gen/2.ts', { out: '.claude/notes.md', region: 'x' }),
      custom('gen/3.ts', { out: 'data.json', region: 'x' }), custom('gen/4.ts', { out: 'notes.txt', region: 'x' }),
      custom('gen/5.ts', { out: '../escape.md', region: 'x' }), custom('gen/6.ts', { out: '.github/copilot-instructions.md', region: 'x' }),
      custom('gen/ok.ts', { out: 'AGENTS.md', region: 'roadmap-badge' }),
    ],
    outputs: { 'custom:gen/ok.ts': 'fine' },
  });
  const result = await plan(root, loader);
  assert.deepEqual(codes(result), Array(6).fill('output-unsafe'));
  assert.match(result.diagnostics.find((item) => item.file === 'data.json').message, /has no region marker style/);
  assert.deepEqual(result.outputs.map((item) => [item.out, item.status]), [['AGENTS.md', 'stale']]);
});

test('a .htm, .css or line-comment file uses its own marker style', async (t) => {
  const root = await repo(t, {
    'site/page.htm': '<p>x</p>\n<!-- block-beaver:region nav -->\n<!-- /block-beaver:region nav -->\n',
    'site/theme.css': 'a{}\n/* block-beaver:region tokens */\n/* /block-beaver:region tokens */\n',
    'src/routes.ts': 'export const a = 1;\n// block-beaver:region routes\n// /block-beaver:region routes\n',
  });
  const loader = fakeLoader({
    generators: [custom('gen/h.ts', { out: 'site/page.htm', region: 'nav' }), custom('gen/c.ts', { out: 'site/theme.css', region: 'tokens' }), custom('gen/t.ts', { out: 'src/routes.ts', region: 'routes' })],
    outputs: { 'custom:gen/h.ts': '<nav></nav>', 'custom:gen/c.ts': ':root{}', 'custom:gen/t.ts': 'export const b = 2;' },
  });
  const result = await plan(root, loader);
  assert.deepEqual(result.diagnostics, []);
  await applyGeneration(root, result);
  assert.equal(await readFile(join(root, 'site/page.htm'), 'utf8'), '<p>x</p>\n<!-- block-beaver:region nav -->\n<nav></nav>\n<!-- /block-beaver:region nav -->\n');
  assert.equal(await readFile(join(root, 'site/theme.css'), 'utf8'), 'a{}\n/* block-beaver:region tokens */\n:root{}\n/* /block-beaver:region tokens */\n');
  assert.equal(await readFile(join(root, 'src/routes.ts'), 'utf8'), 'export const a = 1;\n// block-beaver:region routes\nexport const b = 2;\n// /block-beaver:region routes\n');
});

test('generated region content may not contain region or managed markers', async (t) => {
  for (const content of ['ok\n<!-- /block-beaver:region roadmap-badge -->\nmore', '<!-- block-beaver:start -->']) {
    const root = await repo(t, { 'README.md': readme() });
    const result = await plan(root, badgeLoader(content));
    assert.deepEqual(codes(result), ['generator-failed'], content);
    assert.equal(result.diagnostics[0].file, 'gen/badge.ts');
    assert.deepEqual(result.outputs, []);
  }
});

test('a region inside or around a managed section is unsafe; one beside it leaves the managed section alone', async (t) => {
  const { planManagedFiles } = await import('../src/managed-files.mjs');
  const inside = '# Agents\n<!-- block-beaver:start -->\n<!-- block-beaver:region roadmap-badge -->\nx\n<!-- /block-beaver:region roadmap-badge -->\n<!-- block-beaver:end -->\n';
  const around = '# Agents\n<!-- block-beaver:region roadmap-badge -->\n<!-- block-beaver:start -->\nx\n<!-- block-beaver:end -->\n<!-- /block-beaver:region roadmap-badge -->\n';
  for (const text of [inside, around]) {
    const root = await repo(t, { 'AGENTS.md': text });
    const loader = fakeLoader({ generators: [custom('gen/badge.ts', { out: 'AGENTS.md', region: 'roadmap-badge' })], outputs: { 'custom:gen/badge.ts': 'new' } });
    const result = await plan(root, loader);
    assert.deepEqual(codes(result), ['output-unsafe']);
    assert.match(result.diagnostics[0].message, /overlaps a managed block-beaver:start\/end section/);
  }
  const root = await repo(t, { 'package.json': '{"name":"x"}\n', 'AGENTS.md': readme('old', { before: '# Agents\n\n' }) });
  const install = await planManagedFiles({ root, version: '0.7.0', agents: ['codex'], manager: 'npm' });
  const agents = install.files.find((file) => file.path === 'AGENTS.md');
  assert.deepEqual(install.conflicts, []);
  await writeFile(join(root, 'AGENTS.md'), agents.content);
  const loader = fakeLoader({ generators: [custom('gen/badge.ts', { out: 'AGENTS.md', region: 'roadmap-badge' })], outputs: { 'custom:gen/badge.ts': 'new badge' } });
  const result = await plan(root, loader);
  assert.deepEqual(result.diagnostics, []);
  await applyGeneration(root, result);
  const generated = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(generated, agents.content.replace('\nold\n', '\nnew badge\n'));
  const upgrade = await planManagedFiles({ root, version: '0.7.0', agents: ['codex'], manager: 'npm', operation: 'upgrade' });
  assert.deepEqual(upgrade.conflicts, []);
  assert.equal(upgrade.files.find((file) => file.path === 'AGENTS.md').content, generated, 'the managed section still verifies and the region survives');
});

// ---- the real loader, end to end ----

async function realProject(t, generators, extra = {}) {
  const { symlink } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const root = await repo(t, {
    'package.json': '{"name":"region-gen","type":"module"}\n',
    '.blocks/config.json': JSON.stringify({ schemaVersion: 1, apps: [{ id: 'site', root: '.', entries: ['source/main.ts'] }],
      families: [{ id: 'unit', contract: 'definitions/unit.ts', manifests: 'catalog/*.entry.ts' }], generators: Object.keys(generators) }),
    'definitions/unit.ts': `import { defineFamily, s } from 'block-beaver/kernel'; export default defineFamily({id:'unit',fields:s.object({}),implementation:['module']});\n`,
    'catalog/alpha.entry.ts': `export const alpha = {id:'alpha',family:'unit',version:1,name:'Alpha',description:'a',rationale:'r',implementation:{kind:'module',module:'../source/main.ts'}} as const;\n`,
    'source/main.ts': 'export const main = true;\n',
    ...generators, ...extra,
  });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(packageRoot, join(root, 'node_modules/block-beaver'), 'dir');
  return root;
}

const badgeGenerator = `import { defineGenerator } from 'block-beaver/kernel';
export default defineGenerator({ out: 'README.md', region: 'unit-count', inputs: ['catalog/*.entry.ts'], generate: (ctx) => \`Units: \${ctx.manifests('unit').length}\` });\n`;

test('gen and gen --check own a README region end to end through the real loader', async (t) => {
  const { generateProject } = await import('../src/families/commands.mjs');
  const text = '# Region gen\n\nWritten by hand.\n\n<!-- block-beaver:region unit-count -->\nUnits: ?\n<!-- /block-beaver:region unit-count -->\n\nAlso by hand.\n';
  const root = await realProject(t, { 'generators/badge.ts': badgeGenerator }, { 'README.md': text });
  const checked = await generateProject(root, { check: true, now: NOW });
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.diagnostics.map((item) => [item.code, item.file, item.region]), [['output-stale', 'README.md', 'unit-count']]);
  const result = await generateProject(root, { now: NOW });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.written, ['README.md']);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), text.replace('Units: ?', 'Units: 1'));
  await writeFile(join(root, 'README.md'), (await readFile(join(root, 'README.md'), 'utf8')).replace('Also by hand.', 'Edited by hand later.'));
  const after = await generateProject(root, { check: true, now: NOW });
  assert.equal(after.ok, true, JSON.stringify(after.diagnostics));
  assert.deepEqual(after.pending, []);
});

test('the real loader rejects a bad region and records region only for region generators', async (t) => {
  const { loadFamilies } = await import('../src/families/loader.mjs');
  const root = await realProject(t, {
    'generators/json.ts': `import { defineGenerator } from 'block-beaver/kernel'; export default defineGenerator({ out: 'data.json', region: 'x', inputs: ['catalog/*.entry.ts'], generate: () => '{}' });\n`,
    'generators/badid.ts': `import { defineGenerator } from 'block-beaver/kernel'; export default defineGenerator({ out: 'README.md', region: 'Bad_Id', inputs: ['catalog/*.entry.ts'], generate: () => '' });\n`,
    'generators/badge.ts': badgeGenerator,
    'generators/whole.ts': `import { defineGenerator } from 'block-beaver/kernel'; export default defineGenerator({ out: 'generated/whole.ts', inputs: ['catalog/*.entry.ts'], generate: () => '' });\n`,
  });
  const loaded = await loadFamilies({ root });
  assert.deepEqual(loaded.diagnostics.filter((item) => item.code === 'generator-invalid').map((item) => item.file).sort(), ['generators/badid.ts', 'generators/json.ts']);
  const byPath = Object.fromEntries(loaded.generators.map((info) => [info.path, info]));
  assert.equal(byPath['generators/badge.ts'].region, 'unit-count');
  assert.equal(Object.hasOwn(byPath['generators/whole.ts'], 'region'), false);
  assert.deepEqual(Object.keys(byPath['generators/whole.ts']), ['key', 'source', 'path', 'out', 'inputs', 'cache', 'closureHash']);
});
