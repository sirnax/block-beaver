import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extractLinks, attachFamilies, findUnclaimed } from '../src/families/graph.mjs';
import { loadProjectModel } from '../src/project-model.mjs';

const family = (id, extras = {}) => ({ id, floor: 0, config: { contract: `definitions/${id}.ts`, manifests: `blocks/${id}/*.ts` }, ...extras });
const manifest = (family, id, extras = {}) => ({ id, family, version: 1, name: id, description: id, rationale: 'A fixture boundary', implementation: { kind: 'none' }, ...extras });
const loaded = (value, path = `blocks/${value.family}/${value.id}.ts`) => ({ family: value.family, id: value.id, ref: `${value.family}:${value.id}`, graphId: `block:${value.family}:${value.id}`, path, exportName: 'default', value, hash: `hash:${value.id}` });
const graph = (files = []) => ({ schemaVersion: 2, root: '.', fingerprint: 'source', apps: [{ id: 'web', counts: { blocks: 0 } }, { id: 'worker', counts: { blocks: 0 } }], summary: {}, nodes: files.map(([path, app = null, usedBy = []]) => ({ id: `file:${path}`, kind: 'file', path, app, usedBy })), edges: [] });
const noResolve = { resolveImport() { throw new Error('Unexpected implementation resolution'); } };

test('links traverse nested array fields, preserve concrete paths and accept qualified references', () => {
  const definition = family('alpha', { links: [{ field: 'groups[].routes[].handler', to: 'beta', kind: 'uses' }, { field: 'target', to: ['beta', 'gamma'], kind: 'relates' }] });
  const value = manifest('alpha', 'one', { groups: [{ routes: [{ handler: 'two' }, { handler: 'beta:three' }, { handler: null }] }, { routes: [] }], target: 'gamma:four' });
  assert.deepEqual(extractLinks(definition, value), { diagnostics: [], links: [
    { field: '$.groups[0].routes[0].handler', target: 'block:beta:two', kind: 'uses' },
    { field: '$.groups[0].routes[1].handler', target: 'block:beta:three', kind: 'uses' },
    { field: '$.target', target: 'block:gamma:four', kind: 'relates' },
  ] });
});

test('links reject invalid values and ambiguous or forbidden reference families', () => {
  for (const target of ['bare', 'other:one', 'beta:', 'beta:a:b', 1, {}, ['beta:one']]) {
    const result = extractLinks(family('alpha', { links: [{ field: 'target', to: ['beta', 'gamma'], kind: 'uses' }] }), manifest('alpha', 'one', { target }));
    assert.deepEqual(result.links, []);
    assert.equal(result.diagnostics[0].code, 'link-value-invalid');
    assert.equal(result.diagnostics[0].field, '$.target');
  }
  assert.equal(extractLinks(family('alpha', { links: [{ field: 'items[].target', to: 'beta', kind: 'uses' }] }), manifest('alpha', 'one', { items: {} })).diagnostics[0].field, '$.items');
  assert.deepEqual(extractLinks(family('alpha', { links: [{ field: 'absent.value', to: 'beta', kind: 'uses' }] }), manifest('alpha', 'one')), { links: [], diagnostics: [] });
});

test('family attach collapses repeated typed links and joins precise implementation boundaries', () => {
  const source = graph([['src/one.ts', 'web', ['web', 'worker']], ['src/test.ts', 'worker', ['worker']], ['blocks/alpha/one.ts', 'web'], ['definitions/alpha.ts'], ['generate.ts']]);
  const definition = family('alpha', { links: [{ field: 'targets[]', to: 'beta', kind: 'uses' }, { field: 'backup', to: 'beta', kind: 'uses' }] });
  const result = attachFamilies(source, { load: { families: [definition, family('beta', { floor: 1, map: { title: 'Configured title', blurb: 'Configured text' } })], manifests: [loaded(manifest('alpha', 'one', { implementation: { kind: 'module', module: './one' }, files: ['src/test.ts', 'src/one.ts'], targets: ['two', 'two', 'missing'], backup: 'beta:two' })), loaded(manifest('beta', 'two'))], generators: [{ path: 'generate.ts' }], diagnostics: [] }, project: { resolveImport(from, spec, options) { assert.equal(from, 'blocks/alpha/one.ts'); assert.equal(spec, './one'); assert.deepEqual(options, { mode: 'import' }); return { path: 'src/one.ts' }; } } });
  assert.equal(result, source);
  assert.equal(result.schemaVersion, 2);
  const one = result.nodes.find((node) => node.id === 'block:alpha:one');
  assert.equal(one.app, null);
  assert.deepEqual(one.usedBy, ['web', 'worker']);
  assert.deepEqual(one.dependencies, ['block:beta:two']);
  assert.deepEqual(result.edges.filter((edge) => edge.kind === 'implemented-by').map((edge) => edge.to), ['file:src/one.ts', 'file:src/test.ts']);
  assert.deepEqual(result.edges.find((edge) => edge.link).fields, ['$.backup', '$.targets[0]', '$.targets[1]']);
  assert.equal(result.familyDiagnostics[0].code, 'link-target-missing');
  assert.equal(result.familyDiagnostics[0].field, '$.targets[2]');
  assert.equal(result.nodes.find((node) => node.path === 'blocks/alpha/one.ts').owningBlock, one.id);
  assert.equal(result.nodes.find((node) => node.path === 'definitions/alpha.ts').familyRole, 'contract');
  assert.equal(result.nodes.find((node) => node.path === 'generate.ts').familyRole, 'generator');
  assert.deepEqual(result.families.map((item) => [item.id, item.floor, item.count]), [['alpha', 0, 1], ['beta', 1, 1]]);
  assert.equal(result.families[1].title, 'Configured title');
});

test('implementation resolution and missing files produce stable, located diagnostics', () => {
  for (const [resolution, code] of [[{ external: true }, 'implementation-external'], [{ error: 'Unresolved module' }, 'implementation-unresolved'], [{ path: 'missing.ts' }, 'implementation-unresolved']]) {
    const result = attachFamilies(graph(), { project: { resolveImport: () => resolution }, load: { families: [family('alpha')], manifests: [loaded(manifest('alpha', 'one', { implementation: { kind: 'module', module: 'fixture-package' }, files: ['also-missing.ts'] }))] } });
    assert.deepEqual(result.familyDiagnostics.map((item) => item.code), [code, 'file-missing']);
    assert.equal(result.familyDiagnostics[0].file, 'blocks/alpha/one.ts');
    assert.equal(result.familyDiagnostics[0].block, 'alpha:one');
  }
});

test('history is replayed into graph snapshots and duplicate blocks fail without duplicate nodes', () => {
  const item = loaded(manifest('alpha', 'one'));
  const result = attachFamilies(graph(), { load: { families: [family('alpha')], manifests: [item, item] }, project: noResolve, history: { schemaVersion: 1, entries: [
    { date: '2026-10-01', label: 'first', source: 'gen', changes: [{ op: 'upsert', block: 'alpha:one', hash: 'sha256:one' }] },
    { date: '2026-10-02', source: 'gen', changes: [{ op: 'delete', block: 'alpha:one' }, { op: 'upsert', block: 'alpha:two', hash: 'sha256:two' }] },
  ] } });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.familyDiagnostics[0].code, 'block-duplicate');
  assert.deepEqual(result.history, [{ date: '2026-10-01', label: 'first', blocks: ['block:alpha:one'] }, { date: '2026-10-02', label: null, blocks: ['block:alpha:two'] }]);
});

test('family attachment reports unclaimed sibling folders from scanned and discovered files', () => {
  const result = attachFamilies(graph([['blocks/alpha/one.ts'], ['blocks/beta/two.ts']]), { project: noResolve, load: { families: [family('alpha'), family('internal', { config: { contract: '.blocks/internal.family.ts', manifests: '.blocks/internal/*.ts' } })], manifests: [], discoveredFiles: ['.blocks/unclaimed/three.ts', 'unrelated/four.ts'] } });
  assert.deepEqual(result.familyDiagnostics.map((issue) => [issue.code, issue.file]), [['family-unclaimed', '.blocks/unclaimed'], ['family-unclaimed', 'blocks/beta']]);
});

test('invalid history shapes report diagnostics while attachment continues', () => {
  for (const history of [null, {}, { schemaVersion: 1, entries: {} }, { schemaVersion: 1, entries: [null] }, { schemaVersion: 1, entries: [{ date: '2026-10-01', source: 'gen', changes: {} }] }]) {
    const result = attachFamilies(graph(), { project: noResolve, load: { families: [family('alpha')], manifests: [loaded(manifest('alpha', 'one'))] }, history });
    assert.deepEqual(result.history, []);
    assert.equal(result.familyDiagnostics[0].code, 'history-invalid');
    assert.equal(result.familyDiagnostics[0].rule, 'family-drift');
    assert.equal(result.familyDiagnostics[0].file, '.blocks/history.json');
    assert.equal(result.summary.blocks, 1);
  }
});

test('a boundary mixing an app file and outside-app code belongs outside apps', () => {
  const result = attachFamilies(graph([['src/a.ts', 'web', ['web']], ['scripts/tool.ts', null, ['worker']]]), { project: noResolve, load: { families: [family('alpha')], manifests: [loaded(manifest('alpha', 'one', { files: ['src/a.ts', 'scripts/tool.ts'] }))] } });
  assert.equal(result.nodes.find((node) => node.kind === 'block').app, null);
  assert.deepEqual(result.nodes.find((node) => node.kind === 'block').usedBy, ['web', 'worker']);
  assert.equal(result.edges.find((edge) => edge.to === 'file:src/a.ts').crossApp, true);
  assert.equal(result.apps[0].counts.blocks, 0);
});

test('family fingerprint persists relative content rather than loader cache identity', () => {
  const baseLoad = { families: [family('alpha', { fields: { type: 'object', shape: {} }, hasCheck: true })], manifests: [loaded(manifest('alpha', 'one'))], generators: [{ key: 'custom:render', source: 'custom', path: 'render.ts', out: 'generated.ts', inputs: ['blocks/**/*.ts'], closureHash: 'content-hash' }], loadedFiles: ['definitions/alpha.ts', 'helper.ts'], fileHashes: { 'definitions/alpha.ts': 'contract-content', 'helper.ts': 'helper-content' } };
  function fingerprint(root, key, changes = {}) {
    const source = graph(); source.root = root;
    return attachFamilies(source, { project: noResolve, load: { ...structuredClone(baseLoad), key, ...changes } }).fingerprint;
  }
  const first = fingerprint('/tmp/checkout-a/project', 'absolute-resolution-key-a');
  assert.equal(first, fingerprint('/tmp/checkout-b/project', 'absolute-resolution-key-b'));
  assert.notEqual(first, fingerprint('/tmp/checkout-a/project', 'absolute-resolution-key-a', { fileHashes: { ...baseLoad.fileHashes, 'helper.ts': 'changed-content' } }));
  assert.notEqual(first, fingerprint('/tmp/checkout-a/project', 'absolute-resolution-key-a', { generators: [{ ...baseLoad.generators[0], closureHash: 'changed-generator' }] }));
  assert.notEqual(first, fingerprint('/tmp/checkout-a/project', 'absolute-resolution-key-a', { families: [family('alpha', { fields: { type: 'object', shape: {} }, hasCheck: false })] }));
});

test('unclaimed discovery reports sibling folders once and exempts root patterns', () => {
  assert.deepEqual(findUnclaimed([{ manifests: 'blocks/alpha/*.manifest.ts' }, { manifests: 'blocks/beta/**/*.manifest.ts' }], ['blocks/alpha/one.manifest.ts', 'blocks/beta/nested/two.manifest.ts', 'blocks/gamma/a.manifest.ts', 'blocks/gamma/b.manifest.ts', 'unrelated/a.ts']).map((item) => [item.code, item.file]), [['family-unclaimed', 'blocks/gamma']]);
  assert.deepEqual(findUnclaimed([{ manifests: '*.ts' }], ['other.js']), []);
});

test('implementation aliases resolve using the manifest home app and expose cross-app links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-family-graph-'));
  const files = {
    '.blocks/config.json': { schemaVersion: 1, apps: [{ id: 'web', root: '.', tsconfig: 'tsconfig.json', source: 'config' }, { id: 'worker', root: 'worker', tsconfig: 'worker/tsconfig.json', source: 'config' }] },
    'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@impl': ['src/web.ts'] } }, include: ['src/*.ts'] },
    'worker/tsconfig.json': { compilerOptions: { baseUrl: '..', paths: { '@impl': ['src/shared.ts'] } }, include: ['*.ts'] },
    'src/web.ts': 'export const web = 1;', 'src/shared.ts': 'export const shared = 1;', 'worker/one.ts': 'export default {};',
  };
  try {
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), typeof content === 'string' ? content : JSON.stringify(content)); }
    const paths = Object.keys(files).filter((path) => path.endsWith('.ts'));
    const project = await loadProjectModel(root, { paths, writeConfig: false });
    const result = attachFamilies(graph([['src/shared.ts', 'web', ['web', 'worker']], ['worker/one.ts', 'worker']]), { project, load: { families: [family('alpha', { links: [{ field: 'target', to: 'beta', kind: 'uses' }] }), family('beta', { floor: 1 })], manifests: [loaded(manifest('alpha', 'one', { implementation: { kind: 'module', module: '@impl' }, target: 'two' }), 'worker/one.ts'), loaded(manifest('beta', 'two', { files: ['worker/one.ts'] }))] } });
    assert.equal(result.edges[0].to, 'file:src/shared.ts');
    assert.equal(result.nodes.find((node) => node.kind === 'block').app, 'web');
    assert.deepEqual(result.familyDiagnostics, []);
    assert.equal(result.apps[0].counts.blocks, 1);
    assert.equal(result.edges.find((edge) => edge.link).crossApp, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
