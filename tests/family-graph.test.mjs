import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extractLinks, attachFamilies, findUnclaimed } from '../src/families/graph.mjs';
import { loadProjectModel } from '../src/project-model.mjs';
import { valuesAt } from '../src/families/paths.mjs';

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
  assert.deepEqual(result.history, [{ date: '2026-10-01', label: 'first', blocks: ['block:alpha:one'], gone: [] }, { date: '2026-10-02', label: null, blocks: ['block:alpha:two'], gone: [{ id: 'block:alpha:one', family: 'alpha', name: 'one' }] }]);
});

test('family attachment reports unclaimed sibling folders from scanned and discovered files', () => {
  const result = attachFamilies(graph([['blocks/alpha/one.ts'], ['blocks/beta/two.ts']]), { project: noResolve, load: { families: [family('alpha'), family('internal', { config: { contract: '.blocks/internal.family.ts', manifests: '.blocks/internal/*.ts' } })], manifests: [], discoveredFiles: ['.blocks/unclaimed/three.ts', 'unrelated/four.ts'] } });
  assert.deepEqual(result.familyDiagnostics.map((issue) => [issue.code, issue.file]), [['family-unclaimed', '.blocks/unclaimed'], ['family-unclaimed', 'blocks/beta']]);
});

test('unclaimed discovery skips excluded and ignored files and downgrades fixture and test strays to warnings', () => {
  const task = { manifests: 'src/blocks/task/manifests/*.task.ts' };
  const files = ['src/blocks/task/manifests/a.task.ts', 'src/blocks/task/fixtures/b.task.ts', 'src/blocks/task/drafts/c.task.ts', 'src/blocks/task/__fixtures__/d.task.ts', 'src/blocks/task/tests/e.task.ts', 'src/blocks/task/scratch/f.task.ts'];
  const summary = (items) => items.map((item) => [item.file, item.severity]);
  // No exclude or ignore keeps strays reported; only fixture and test folders soften.
  assert.deepEqual(summary(findUnclaimed([task], files)), [['src/blocks/task/__fixtures__', 'warning'], ['src/blocks/task/drafts', 'error'], ['src/blocks/task/fixtures', 'warning'], ['src/blocks/task/scratch', 'error'], ['src/blocks/task/tests', 'warning']]);
  // Excluded files are neither manifests nor strays.
  assert.deepEqual(summary(findUnclaimed([{ ...task, exclude: ['src/blocks/task/fixtures/*.task.ts', 'src/blocks/task/drafts/*.task.ts'] }], files)), [['src/blocks/task/__fixtures__', 'warning'], ['src/blocks/task/scratch', 'error'], ['src/blocks/task/tests', 'warning']]);
  // Ignored files are skipped through the project matcher.
  assert.deepEqual(summary(findUnclaimed([task], files, { isIgnored: (path) => /\/(?:fixtures|__fixtures__|tests|drafts)\//.test(path) })), [['src/blocks/task/scratch', 'error']]);
  assert.deepEqual(findUnclaimed([task], ['src/blocks/task/manifests/a.task.ts']), []);
});

test('family attachment honours project ignore and tolerates projects without isIgnored', () => {
  const families = [family('alpha', { config: { contract: 'definitions/alpha.ts', manifests: 'blocks/alpha/*.ts' } })];
  const files = [['blocks/alpha/one.ts'], ['blocks/stray/two.ts'], ['blocks/fixtures/three.ts']];
  const stub = { ...noResolve, isIgnored: (path) => path.startsWith('blocks/stray/') };
  const ignored = attachFamilies(graph(files), { project: stub, load: { families, manifests: [] } });
  assert.deepEqual(ignored.familyDiagnostics.map((issue) => [issue.file, issue.severity]), [['blocks/fixtures', 'warning']]);
  const plain = attachFamilies(graph(files), { project: noResolve, load: { families, manifests: [] } });
  assert.deepEqual(plain.familyDiagnostics.map((issue) => [issue.file, issue.severity]), [['blocks/fixtures', 'warning'], ['blocks/stray', 'error']]);
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

const joinTask = family('task', { links: [{ field: 'tools', to: 'tool', match: 'modes[]', kind: 'can-use' }] });
const joinGraph = (families, manifests) => attachFamilies(graph(), { project: noResolve, load: { families, manifests: manifests.map((item) => loaded(item)) } });
const canUse = (result) => result.edges.filter((edge) => edge.link).map((edge) => [edge.from, edge.to, edge.kind, edge.fields]);

test('valuesAt walks . and [] paths to concrete fields and skips null', () => {
  const value = { groups: [{ routes: [{ handler: 'a' }, { handler: null }, {}] }, null, { routes: null }], one: { two: 2 }, list: ['x', null, 'y'], nested: [['p'], null, ['q', 'r']] };
  assert.deepEqual(valuesAt(value, 'groups[].routes[].handler'), [{ field: '$.groups[0].routes[0].handler', value: 'a' }]);
  assert.deepEqual(valuesAt(value, 'one.two'), [{ field: '$.one.two', value: 2 }]);
  assert.deepEqual(valuesAt(value, 'list[]'), [{ field: '$.list[0]', value: 'x' }, { field: '$.list[2]', value: 'y' }]);
  assert.deepEqual(valuesAt(value, 'nested[][]').map((entry) => entry.field), ['$.nested[0][0]', '$.nested[2][0]', '$.nested[2][1]']);
  assert.deepEqual(valuesAt(value, 'absent.deeper'), []);
  assert.deepEqual(valuesAt(value, 'one.two.three'), []);
  assert.deepEqual(valuesAt(null, 'a'), []);
});

test('join links connect a scalar field to every target whose array field holds the value', () => {
  const result = joinGraph([joinTask, family('tool', { floor: 1 })], [
    manifest('task', 'summarise', { tools: 'assistant' }), manifest('task', 'plain', { tools: 'none' }), manifest('task', 'absent'),
    manifest('tool', 'search', { modes: ['chat'] }), manifest('tool', 'create-note', { modes: ['assistant', 'chat'] }), manifest('tool', 'archive', { modes: ['assistant'] }),
  ]);
  assert.deepEqual(canUse(result), [['block:task:summarise', 'block:tool:archive', 'can-use', ['$.tools']], ['block:task:summarise', 'block:tool:create-note', 'can-use', ['$.tools']]]);
  assert.deepEqual(result.edges.find((edge) => edge.link), { from: 'block:task:summarise', to: 'block:tool:archive', kind: 'can-use', link: true, fields: ['$.tools'], evidence: { file: 'blocks/task/summarise.ts', line: 1, column: 1, text: '$.tools ↔ tool.$.modes[] → tool:archive' } });
  assert.deepEqual(result.nodes.find((node) => node.id === 'block:task:summarise').dependencies, ['block:tool:archive', 'block:tool:create-note']);
  assert.deepEqual(result.nodes.find((node) => node.id === 'block:task:plain').dependencies, []);
  assert.deepEqual(result.familyDiagnostics, []);
  assert.deepEqual(result.families.find((item) => item.id === 'task').linkKinds, ['can-use']);
});

test('join links match array fields on both sides, dedupe per target and kind, and merge fields', () => {
  const definition = family('task', { links: [{ field: 'tools[]', to: 'tool', match: 'modes[]', kind: 'can-use' }, { field: 'primary', to: 'tool', match: 'modes[]', kind: 'can-use' }] });
  const result = joinGraph([definition, family('tool', { floor: 1 })], [
    manifest('task', 'one', { tools: ['chat', 'assistant', 'none'], primary: 'chat' }),
    manifest('tool', 'zeta', { modes: ['assistant', 'chat'] }), manifest('tool', 'alpha', { modes: ['chat'] }), manifest('tool', 'omega', { modes: [] }),
  ]);
  assert.deepEqual(canUse(result), [['block:task:one', 'block:tool:alpha', 'can-use', ['$.primary', '$.tools[0]']], ['block:task:one', 'block:tool:zeta', 'can-use', ['$.primary', '$.tools[0]', '$.tools[1]']]]);
  assert.equal(result.edges.find((edge) => edge.link).evidence.text, '$.primary, $.tools[0] ↔ tool.$.modes[] → tool:alpha');
  assert.equal(JSON.stringify(joinGraph([definition, family('tool', { floor: 1 })], [manifest('tool', 'alpha', { modes: ['chat'] }), manifest('tool', 'zeta', { modes: ['assistant', 'chat'] }), manifest('task', 'one', { tools: ['chat', 'assistant', 'none'], primary: 'chat' })]).edges), JSON.stringify(result.edges));
});

test('join links compare by type, ignore non-primitive values and never link a block to itself', () => {
  const definition = family('task', { links: [{ field: 'level', to: 'task', match: 'levels[]', kind: 'peers' }, { field: 'level', to: 'tool', match: 'levels[]', kind: 'can-use' }] });
  const result = joinGraph([definition, family('tool', { floor: 1 })], [
    manifest('task', 'one', { level: 1, levels: [1, 2] }), manifest('task', 'two', { level: '1', levels: ['1', 1] }), manifest('task', 'objects', { level: { a: 1 }, levels: [{ a: 1 }, null, [1]] }),
    manifest('tool', 'number', { levels: [1] }), manifest('tool', 'string', { levels: ['1'] }), manifest('tool', 'flag', { levels: [true] }),
  ]);
  assert.deepEqual(canUse(result), [
    ['block:task:one', 'block:task:two', 'peers', ['$.level']], ['block:task:one', 'block:tool:number', 'can-use', ['$.level']],
    ['block:task:two', 'block:tool:string', 'can-use', ['$.level']],
  ]);
  assert.deepEqual(result.familyDiagnostics, []);
});

test('join and id links of one kind to the same block share one edge, and id-only graphs keep their edge bytes', () => {
  const mixed = family('task', { links: [{ field: 'tool', to: 'tool', kind: 'can-use' }, { field: 'tools', to: 'tool', match: 'modes[]', kind: 'can-use' }] });
  const result = joinGraph([mixed, family('tool', { floor: 1 })], [manifest('task', 'one', { tool: 'a', tools: 'chat' }), manifest('tool', 'a', { modes: ['chat'] }), manifest('tool', 'b', { modes: ['chat'] })]);
  assert.deepEqual(canUse(result), [['block:task:one', 'block:tool:a', 'can-use', ['$.tool', '$.tools']], ['block:task:one', 'block:tool:b', 'can-use', ['$.tools']]]);
  assert.equal(result.edges[0].evidence.text, '$.tool, $.tools ↔ tool.$.modes[] → tool:a');
  const plain = joinGraph([family('task', { links: [{ field: 'tool', to: 'tool', kind: 'can-use' }] }), family('tool', { floor: 1 })], [manifest('task', 'one', { tool: 'a', modes: ['x'] }), manifest('tool', 'a', { modes: ['x'] })]);
  assert.deepEqual(plain.edges, [{ from: 'block:task:one', to: 'block:tool:a', kind: 'can-use', link: true, fields: ['$.tool'], evidence: { file: 'blocks/task/one.ts', line: 1, column: 1, text: '$.tool → tool:a' } }]);
});

test('join links skip a target family that has no manifests and add no diagnostics', () => {
  const result = joinGraph([joinTask, family('tool', { floor: 1 })], [manifest('task', 'one', { tools: 'chat' })]);
  assert.deepEqual(canUse(result), []);
  assert.deepEqual(result.familyDiagnostics, []);
});

test('id links keep 0.6.0 behaviour for nested-array paths, which never produced edges', () => {
  const definition = family('alpha', { links: [{ field: 'refs[][]', to: 'beta', kind: 'uses' }] });
  assert.deepEqual(extractLinks(definition, manifest('alpha', 'one', { refs: [['two']] })), { links: [], diagnostics: [] });
});
