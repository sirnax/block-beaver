import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { attachFamilies, attachMapParity } from '../src/families/graph.mjs';
import { attachProjectRegistry } from '../src/adapter.mjs';
import { scanRepository } from '../src/scanner.mjs';
import { graphRevision } from '../src/block-map.mjs';
const exec = promisify(execFile);

const family = (id, extras = {}) => ({ id, floor: 0, config: { contract: `definitions/${id}.ts`, manifests: `blocks/${id}/*.ts` }, ...extras });
const manifest = (family, id, extras = {}) => ({ id, family, version: 1, name: id, description: id, rationale: 'A fixture boundary', implementation: { kind: 'none' }, ...extras });
const loaded = (value, path = `blocks/${value.family}/${value.id}.ts`) => ({ family: value.family, id: value.id, ref: `${value.family}:${value.id}`, graphId: `block:${value.family}:${value.id}`, path, exportName: 'default', value, hash: `hash:${value.id}` });
const fileNode = ([path, app = null]) => ({ id: `file:${path}`, kind: 'file', path, app, usedBy: [] });
const graph = (files, edges = []) => ({ schemaVersion: 2, root: '.', fingerprint: 'source', apps: [{ id: 'web', root: '.', counts: { blocks: 0 } }, { id: 'admin', root: 'apps/admin', counts: { blocks: 0 } }], summary: {}, nodes: files.map(fileNode), edges: edges.map(([from, to, kind = 'imports']) => ({ from: `file:${from}`, to: `file:${to}`, kind, evidence: { file: from, line: 1, column: 1, text: '' } })) });
const resolveTo = (map) => ({ resolveImport(from, specifier) { return { path: map[specifier] }; } });

test('folders that import a block implementation reach it, grouped by app-relative folder', () => {
  const source = graph([
    ['src/widgets/one.ts', 'web'], ['src/widgets/helper.ts', 'web'], ['src/pages/home.ts', 'web'], ['src/pages/about.ts', 'web'],
    ['apps/admin/lib/panel.ts', 'admin'], ['blocks/unit/one.ts', 'web'], ['blocks/unit/two.ts', 'web'], ['scripts/build.ts', null],
  ], [
    ['src/pages/home.ts', 'src/widgets/one.ts'], ['src/pages/about.ts', 'src/widgets/one.ts'], ['apps/admin/lib/panel.ts', 'src/widgets/one.ts', 'reexports'],
    ['src/widgets/helper.ts', 'src/widgets/one.ts'], ['scripts/build.ts', 'src/widgets/one.ts'], ['blocks/unit/one.ts', 'src/widgets/one.ts'],
  ]);
  const result = attachFamilies(source, { project: resolveTo({ './one': 'src/widgets/one.ts' }), load: { families: [family('unit')], manifests: [
    loaded(manifest('unit', 'one', { implementation: { kind: 'module', module: './one' }, files: ['src/widgets/helper.ts'] })),
    loaded(manifest('unit', 'two')),
  ] } });
  // helper.ts is inside the block's own boundary and the manifest is block machinery; neither is reach.
  assert.deepEqual(result.codeReach, [
    { app: null, folder: 'scripts', block: 'block:unit:one', via: 'import', files: ['scripts/build.ts'] },
    { app: 'admin', folder: 'lib', block: 'block:unit:one', via: 'import', files: ['apps/admin/lib/panel.ts'] },
    { app: 'web', folder: 'src/pages', block: 'block:unit:one', via: 'import', files: ['src/pages/about.ts', 'src/pages/home.ts'] },
  ]);
  assert.deepEqual(result.unused, ['block:unit:two']);
});

test('typed links into a block keep it used while outgoing links alone do not', () => {
  const definition = family('unit', { links: [{ field: 'next', to: 'unit', kind: 'uses' }] });
  const result = attachFamilies(graph([]), { project: resolveTo({}), load: { families: [definition], manifests: [loaded(manifest('unit', 'a', { next: 'b' })), loaded(manifest('unit', 'b')), loaded(manifest('unit', 'self', { next: 'self' }))] } });
  assert.deepEqual(result.codeReach, []);
  assert.deepEqual(result.unused, ['block:unit:a', 'block:unit:self']);
});

test('configured bindings find real registry calls by dot and quoted access, never in comments or strings', () => {
  const texts = {
    'src/app/main.ts': "render(screens.home, props);\nrender( screens [ 'settings' ] );\nrender(screens[\"missing\"]);\nprerender(screens.about);",
    'src/app/other.ts': 'mount(screens.about)',
    'src/admin.ts': "// render(screens.about)\n/* render(screens.home) */\nconst s = 'render(screens.settings)';\nrender(other.home)",
    'src/app/ns.tsx': 'export const X = () => ui.render(screens.settings);',
  };
  const families = [family('screen'), family('record')];
  const manifests = ['home', 'settings', 'about'].map((id) => loaded(manifest('screen', id))).concat(loaded(manifest('record', 'home')));
  const run = (bindings) => attachFamilies(graph(Object.keys(texts).map((path) => [path, 'web'])), { project: resolveTo({}), load: { families, manifests }, bindings, sourceText: (path) => texts[path] ?? null });
  const result = run([{ family: 'screen', call: 'render', registry: 'screens' }, { family: 'screen', call: 'mount', registry: 'screens' }]);
  assert.deepEqual(result.codeReach, [
    { app: 'web', folder: 'src/app', block: 'block:screen:about', via: 'binding', files: ['src/app/other.ts'] },
    { app: 'web', folder: 'src/app', block: 'block:screen:home', via: 'binding', files: ['src/app/main.ts'] },
    { app: 'web', folder: 'src/app', block: 'block:screen:settings', via: 'binding', files: ['src/app/main.ts', 'src/app/ns.tsx'] },
  ]);
  assert.deepEqual(result.unused, ['block:record:home']);
  // Without bindings no text pass runs: the reader must never be called.
  const untouched = attachFamilies(graph([['src/app/main.ts', 'web']]), { project: resolveTo({}), load: { families, manifests }, sourceText() { throw new Error('binding pass ran without bindings'); } });
  assert.deepEqual(untouched.codeReach, []);
  assert.deepEqual(untouched.unused, ['block:record:home', 'block:screen:about', 'block:screen:home', 'block:screen:settings']);
  assert.notEqual(run([{ family: 'screen', call: 'render', registry: 'screens' }]).fingerprint, untouched.fingerprint);
});

test('map parity output is deterministic regardless of edge and node order', () => {
  const files = [['src/b/x.ts', 'web'], ['src/a/y.ts', 'web'], ['src/impl.ts', 'web']];
  const edges = [['src/b/x.ts', 'src/impl.ts'], ['src/a/y.ts', 'src/impl.ts']];
  const make = (reverse) => {
    const source = graph(reverse ? [...files].reverse() : files, reverse ? [...edges].reverse() : edges);
    source.nodes.push({ id: 'block:unit:one', kind: 'block' });
    source.edges.push({ from: 'block:unit:one', to: 'file:src/impl.ts', kind: 'implemented-by' });
    return attachMapParity(source);
  };
  assert.deepEqual(make(false).codeReach, make(true).codeReach);
  assert.deepEqual(make(false).codeReach.map((entry) => entry.folder), ['src/a', 'src/b']);
});

test('projects without families gain no map parity fields', () => {
  const result = attachFamilies(graph([['src/a.ts', 'web']]), { project: resolveTo({}), load: { families: [], manifests: [] } });
  assert.equal(Object.hasOwn(result, 'codeReach'), false);
  assert.equal(Object.hasOwn(result, 'unused'), false);
});

test('scanned family projects carry codeReach, bindings, unused and gone into graph.json', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-map-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const block = (id, extras = {}) => 'export default ' + JSON.stringify({ id, family: 'unit', version: 1, name: `Unit ${id}`, description: id, rationale: 'Fixture', implementation: { kind: 'none' }, ...extras }) + ';\n';
  const config = { schemaVersion: 1, apps: [{ id: 'app', root: '.', source: 'config' }], families: [{ id: 'unit', contract: 'definitions/unit.family.ts', manifests: 'blocks/unit/*.ts' }], map: { bindings: [{ family: 'unit', call: 'show', registry: 'units' }] } };
  const files = {
    '.blocks/config.json': JSON.stringify(config),
    '.blocks/history.json': JSON.stringify({ schemaVersion: 1, entries: [
      { date: '2026-09-01', label: 'start', source: 'gen', changes: [{ op: 'upsert', block: 'unit:retired', hash: null }, { op: 'upsert', block: 'unit:shown', hash: null }] },
      { date: '2026-09-02', label: null, source: 'gen', changes: [{ op: 'delete', block: 'unit:retired' }, { op: 'upsert', block: 'unit:imported', hash: null }, { op: 'upsert', block: 'unit:idle', hash: null }] },
    ] }),
    'package.json': JSON.stringify({ name: 'map-parity-fixture', type: 'module' }),
    'definitions/unit.family.ts': "import {defineFamily,s} from 'block-beaver/kernel'; export default defineFamily({id:'unit',fields:s.object({}),implementation:['none','module']});",
    'blocks/unit/imported.ts': block('imported', { implementation: { kind: 'module', module: '../../src/widgets/imported.ts' } }),
    'blocks/unit/shown.ts': block('shown'),
    'blocks/unit/idle.ts': block('idle'),
    'src/widgets/imported.ts': 'export const imported = 1;\n',
    'src/pages/home.ts': "import { imported } from '../widgets/imported.ts';\nexport const home = () => show(units.shown, imported);\n",
  };
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  const scanned = await attachProjectRegistry(await scanRepository(root, { writeConfig: false }));
  assert.deepEqual(scanned.familyDiagnostics.filter((item) => item.severity === 'error'), []);
  const stored = JSON.parse(JSON.stringify(scanned));
  assert.equal(Object.hasOwn(stored, 'sourceText'), false);
  assert.deepEqual(stored.codeReach, [
    { app: 'app', folder: 'src/pages', block: 'block:unit:imported', via: 'import', files: ['src/pages/home.ts'] },
    { app: 'app', folder: 'src/pages', block: 'block:unit:shown', via: 'binding', files: ['src/pages/home.ts'] },
  ]);
  assert.deepEqual(stored.unused, ['block:unit:idle']);
  assert.deepEqual(stored.history.at(-1).gone, [{ id: 'block:unit:retired', family: 'unit', name: 'retired' }]);
  const again = await attachProjectRegistry(await scanRepository(root, { writeConfig: false }));
  assert.equal(graphRevision(again), graphRevision(scanned));
});

// Slice M (#47): per-family reach modes and object-argument bindings.
const registryGraph = (extraNodes = [], edges = []) => {
  const source = graph(['src/ui/menu.ts', 'src/ui/other.ts', 'gen/units.ts', 'blocks/unit/a.ts'].map((path) => [path, 'web']).concat(extraNodes), edges);
  return source;
};
const unitManifests = [loaded(manifest('unit', 'a')), loaded(manifest('unit', 'b')), loaded(manifest('record', 'r'))];
const withRegistry = (extras) => [family('unit', { map: extras, config: { contract: 'definitions/unit.ts', manifests: 'blocks/unit/*.ts', registry: { out: 'gen/units.ts' } } }), family('record')];

test('map.reach registry counts every block reached when an ordinary file imports the registry output', () => {
  const edge = ['src/ui/menu.ts', 'gen/units.ts'];
  const source = registryGraph([], [edge]);
  source.edges[0].evidence = { file: 'src/ui/menu.ts', line: 3, column: 1, text: "import { UNITS } from '../../gen/units';" };
  const load = { families: withRegistry({ reach: 'registry' }), manifests: unitManifests };
  const reached = attachFamilies(source, { project: resolveTo({}), load });
  assert.deepEqual(reached.codeReach, [
    { app: 'web', folder: 'src/ui', block: 'block:unit:a', via: 'registry', files: ['src/ui/menu.ts'], evidence: [{ file: 'src/ui/menu.ts', line: 3, text: "import { UNITS } from '../../gen/units';" }] },
    { app: 'web', folder: 'src/ui', block: 'block:unit:b', via: 'registry', files: ['src/ui/menu.ts'], evidence: [{ file: 'src/ui/menu.ts', line: 3, text: "import { UNITS } from '../../gen/units';" }] },
  ]);
  assert.deepEqual(reached.unused, ['block:record:r'], 'other families are unaffected');
  // Same graph without the contract key: nothing is reached and no evidence field appears.
  const plain = attachFamilies(registryGraph([], [edge]), { project: resolveTo({}), load: { families: withRegistry({}), manifests: unitManifests } });
  assert.deepEqual(plain.codeReach, []);
  assert.deepEqual(plain.unused, ['block:record:r', 'block:unit:a', 'block:unit:b']);
});

test('map.reach registry is not applied when only generated files, manifests or nothing import the registry', () => {
  const generated = registryGraph([], [['src/ui/menu.ts', 'gen/units.ts']]);
  generated.nodes.find((node) => node.id === 'file:src/ui/menu.ts').generated = true;
  const load = { families: withRegistry({ reach: 'registry' }), manifests: unitManifests };
  assert.deepEqual(attachFamilies(generated, { project: resolveTo({}), load }).codeReach, []);
  const none = attachFamilies(registryGraph(), { project: resolveTo({}), load });
  assert.deepEqual(none.codeReach, []);
  assert.deepEqual(none.unused, ['block:record:r', 'block:unit:a', 'block:unit:b']);
  // A family without a configured registry has nothing to be imported.
  const bare = attachFamilies(registryGraph([], [['src/ui/menu.ts', 'gen/units.ts']]), { project: resolveTo({}), load: { families: [family('unit', { map: { reach: 'registry' } }), family('record')], manifests: unitManifests } });
  assert.deepEqual(bare.codeReach, []);
});

test('map.unused false keeps a family out of graph.unused while others stay flagged', () => {
  const load = { families: withRegistry({ unused: false }), manifests: unitManifests };
  const result = attachFamilies(registryGraph(), { project: resolveTo({}), load });
  assert.deepEqual(result.unused, ['block:record:r']);
  assert.deepEqual(result.codeReach, []);
  const flagged = attachFamilies(registryGraph(), { project: resolveTo({}), load: { families: withRegistry({ unused: true }), manifests: unitManifests } });
  assert.deepEqual(flagged.unused, ['block:record:r', 'block:unit:a', 'block:unit:b']);
});

test('argKey bindings read a string-literal property of an object first argument; other arguments add nothing', () => {
  const texts = {
    'src/a.ts': "resolveTask({ task: 'image-generate', tier: 1 });\nui.resolveTask({ 'task': `plain-tpl` });",
    'src/b.ts': "resolveTask({ task: taskId });\nresolveTask({ task });\nresolveTask({ [task]: 'computed' });\nresolveTask({ task: `x${y}` });\nresolveTask('image-generate');\nresolveTask({ other: 'image-generate' });\nresolveTask();",
    'src/c.ts': "// resolveTask({ task: 'plain-tpl' })\nconst s = \"resolveTask({ task: 'image-generate' })\";",
    'src/d.ts': "resolveTask({ task: 'unknown-id' });\nresolveTask(TASKS.positional);",
  };
  const families = [family('task'), family('unit')];
  const manifests = ['image-generate', 'plain-tpl', 'positional'].map((id) => loaded(manifest('task', id))).concat(loaded(manifest('unit', 'image-generate')));
  const run = (bindings) => attachFamilies(graph(Object.keys(texts).map((path) => [path, 'web'])), { project: resolveTo({}), load: { families, manifests }, bindings, sourceText: (path) => texts[path] ?? null });
  const result = run([{ family: 'task', call: 'resolveTask', argKey: 'task' }]);
  assert.deepEqual(result.codeReach, [
    { app: 'web', folder: 'src', block: 'block:task:image-generate', via: 'binding', files: ['src/a.ts'] },
    { app: 'web', folder: 'src', block: 'block:task:plain-tpl', via: 'binding', files: ['src/a.ts'] },
  ]);
  assert.deepEqual(result.unused, ['block:task:positional', 'block:unit:image-generate']);
  // The positional form still works beside it, and a malformed entry (both keys, empty argKey) is ignored.
  const mixed = run([{ family: 'task', call: 'resolveTask', registry: 'TASKS' }, { family: 'task', call: 'resolveTask', argKey: '' }, { family: 'task', call: 'resolveTask', argKey: 'task', registry: 'TASKS' }]);
  assert.deepEqual(mixed.codeReach.map((entry) => entry.block), ['block:task:positional']);
});

test('config validates argKey bindings', async () => {
  const { parseFamiliesConfig } = await import('../src/families/config.mjs');
  const fam = { id: 'task', contract: 'definitions/task.ts', manifests: 'blocks/task/*.ts' };
  const parse = (bindings) => parseFamiliesConfig({ families: [fam], map: { bindings } }).diagnostics.map((item) => item.field);
  assert.deepEqual(parse([{ family: 'task', call: 'resolveTask', argKey: 'task' }, { family: 'task', call: 'f', registry: 'R' }]), []);
  assert.deepEqual(parse([{ family: 'task', call: 'resolveTask', argKey: '' }, { family: 'task', call: 'f', argKey: 3 }]), ['$.map.bindings[0].argKey', '$.map.bindings[1].argKey']);
  assert.deepEqual(parse([{ family: 'task', call: 'f', argKey: 'a', registry: 'R' }, { family: 'nope', call: 'f', argKey: 'a' }, { family: 'task', call: 'not valid', argKey: 'a' }]), ['$.map.bindings[0]', '$.map.bindings[1]', '$.map.bindings[2]']);
});

test('contracts validate map.unused and map.reach with their own diagnostics', async (t) => {
  const { loadFamilies } = await import('../src/families/loader.mjs');
  const { discoverFiles } = await import('../src/families/glob.mjs');
  const load = async (map) => {
    const root = await mkdtemp(join(tmpdir(), 'bb-map-reach-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = { schemaVersion: 1, apps: [{ id: 'app', root: '.', entries: [] }], families: [{ id: 'unit', contract: 'definitions/unit.family.ts', manifests: 'catalog/*.item.ts' }] };
    const files = {
      '.blocks/config.json': JSON.stringify(config),
      'definitions/unit.family.ts': `import { defineFamily, s } from 'block-beaver/kernel';\nexport default defineFamily({id:'unit',fields:s.object({}),implementation:['none'],map:${map}});\n`,
      'catalog/a.item.ts': `export default ${JSON.stringify({ id: 'a', family: 'unit', version: 1, name: 'a', description: 'd', rationale: 'r', implementation: { kind: 'none' } })};\n`,
    };
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
    return loadFamilies({ root, config, paths: await discoverFiles(root) });
  };
  const good = await load("{unused:false,reach:'registry'}");
  assert.deepEqual(good.diagnostics, [], JSON.stringify(good.diagnostics));
  assert.deepEqual(good.families[0].map, { unused: false, reach: 'registry' });
  for (const [map, field] of [["{unused:'no'}", '$.map.unused'], ['{unused:0}', '$.map.unused'], ["{reach:'all'}", '$.map.reach'], ['{reach:true}', '$.map.reach']]) {
    const bad = await load(map);
    assert.ok(bad.diagnostics.some((item) => item.code === 'contract-invalid' && item.field === field && item.severity === 'error'), `${map} ${JSON.stringify(bad.diagnostics)}`);
    assert.ok(!bad.families.some((item) => item.id === 'unit'), map);
  }
});
