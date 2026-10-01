import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import module from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadFamilies } from '../src/families/loader.mjs';
import { parseFamiliesConfig } from '../src/families/config.mjs';
import { captureManifestId, discoverFiles, matchGlob, matchGlobs } from '../src/families/glob.mjs';
import { canonicalJson, manifestHash } from '../src/families/canonical.mjs';
import { attachFamilies } from '../src/families/graph.mjs';
import { auditCounts } from '../src/audit-rules.mjs';

const family = { id: 'widget', contract: 'definitions/widget.family.ts', manifests: 'catalog/widgets/*.item.ts' };
const configFor = (overrides = {}) => ({ schemaVersion: 1, apps: [{ id: 'app', root: '.', entries: [] }], families: [family], ...overrides });
const contract = (extra = '') => `import { defineFamily, s } from 'block-beaver/kernel';
export default defineFamily({id:'widget',fields:s.object({tag:s.string()}),implementation:['none'],${extra}});\n`;
const value = (id = 'alpha', extra = {}) => ({ id, family: 'widget', version: 1, name: id, description: 'Fixture widget', rationale: 'An independent fixture boundary', implementation: { kind: 'none' }, tag: 'blue', ...extra });
const manifest = (id = 'alpha', extra = {}, exportPrefix = 'export default') => `${exportPrefix} ${JSON.stringify(value(id, extra))};\n`;

async function fixture(t, files = {}, config = configFor()) {
  const root = await mkdtemp(join(tmpdir(), 'bb-family-loader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = { '.blocks/config.json': `${JSON.stringify(config)}\n`, [family.contract]: contract(), 'catalog/widgets/alpha.item.ts': manifest(), ...files };
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, config, paths: await discoverFiles(root) };
}

async function waitFor(path, expected) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if (await readFile(path, 'utf8') === expected) return; } catch { /* child has not created its marker yet */ }
    await delay(10);
  }
  throw new Error(`Child did not produce fixture marker ${path}`);
}

test('family config is optional, validates paths and IDs, and permits repo-chosen .blocks sources', () => {
  assert.deepEqual(parseFamiliesConfig({}).families, []);
  const invalid = parseFamiliesConfig({ families: [family, family, { id: 'Bad', contract: '../escape.ts', manifests: '/abs/*.ts' }, { id: 'local', contract: 'x.ts', manifests: '*.ts' }] });
  assert.equal(invalid.families.length, 1);
  assert.ok(invalid.diagnostics.some((item) => item.code === 'family-duplicate'));
  assert.ok(invalid.diagnostics.some((item) => item.code === 'family-id-invalid'));
  assert.ok(invalid.diagnostics.some((item) => item.code === 'family-id-reserved'));
  assert.ok(invalid.diagnostics.every((item) => item.field.startsWith('$')));
  assert.equal(parseFamiliesConfig({ families: [{ id: 'widget', contract: '.blocks/author/widget.ts', manifests: '.blocks/author/*.item.ts' }] }).diagnostics.length, 0);
});

test('input globs include recursive, question, classes, brace alternatives and exclusions', () => {
  const paths = ['catalog/alpha.item.ts', 'catalog/nested/bravo.item.ts', 'catalog/nested/c1.item.ts', 'catalog/nested/delta.item.js'];
  assert.deepEqual(matchGlobs(paths, ['catalog/**/*.item.{ts,js}', '!**/c?.item.ts']), [paths[0], paths[1], paths[3]]);
  assert.equal(matchGlob('catalog/c1.item.ts', 'catalog/[a-c]?.item.ts'), true);
  assert.equal(captureManifestId('catalog/nested/bravo.item.ts', 'catalog/**/*.item.ts'), 'bravo');
  assert.equal(captureManifestId('catalog/bravo.item.js', 'catalog/{*.item.ts,*.item.js}'), 'bravo');
  assert.equal(captureManifestId('catalog/nested/bravo.item.ts', 'catalog/**/*.item.{ts,js}'), 'bravo');
});

test('typed registry config accepts TS-family outputs and rejects invalid export bindings and suffixes', () => {
  for (const out of ['generated/registry.ts', 'generated/registry.mts', 'generated/registry.cts']) {
    const parsed = parseFamiliesConfig(configFor({ families: [{ ...family, registry: { out, exportName: 'widgetRegistry', importExtension: '.js' } }] }));
    assert.deepEqual(parsed.diagnostics, []);
  }
  for (const exportName of ['default', 'await', 'eval', 'foo-bar', ['registry']]) {
    const parsed = parseFamiliesConfig(configFor({ families: [{ ...family, registry: { out: 'generated/registry.ts', exportName } }] }));
    assert.ok(parsed.diagnostics.some((item) => item.field.endsWith('.registry.exportName')));
  }
  for (const out of ['generated/registry.json', 'generated/registry.mjs', 'generated/registry.cjs', 'generated/registry.js', 'generated/registry.d.ts']) {
    const parsed = parseFamiliesConfig(configFor({ families: [{ ...family, registry: { out } }] }));
    assert.ok(parsed.diagnostics.some((item) => item.field.endsWith('.registry.out')));
  }
});

test('loader handles stripped type-only exports, named manifest exports, extensionless and alias imports with either package type', async (t) => {
  for (const type of [undefined, 'module', 'commonjs']) {
    const fixtureData = await fixture(t, {
      'package.json': JSON.stringify({ ...(type ? { type } : {}) }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@data/*': ['shared/*.cts'] }, moduleResolution: 'bundler', module: 'esnext' } }),
      [family.contract]: `import { defineFamily, s } from 'block-beaver/kernel'; import { allowed } from '../shared/allowed'; export type Ignored = string; export default defineFamily({id:'widget',fields:s.object({tag:s.enum(allowed)}),implementation:['none']});`,
      'shared/allowed.ts': `export const allowed = ['blue', 'green'] as const;`,
      'shared/tag.cts': `export const tag: string = 'blue';`,
      'catalog/widgets/alpha.item.ts': `import {tag} from '@data/tag'; export type Ignored = { x:string }; export const item = {...${JSON.stringify(value())},tag};`,
    }, configFor({ apps: [{ id: 'app', root: '.', tsconfig: 'tsconfig.json', entries: [] }] }));
    const result = await loadFamilies(fixtureData);
    assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
    assert.equal(result.manifests[0].exportName, 'item');
    assert.equal(result.manifests[0].value.tag, 'blue');
    assert.equal(result.manifests[0].graphId, 'block:widget:alpha');
    assert.equal(result.families[0].floor, 0);
    assert.equal(result.families[0].hasCheck, false);
    assert.ok(result.loadedFiles.includes('shared/allowed.ts'));
    assert.ok(result.loadedFiles.includes('shared/tag.cts'));
    assert.match(result.manifests[0].hash, /^sha256:[a-f0-9]{64}$/);
  }
});

test('loader names transitive TSX and every non-strippable syntax failure', async (t) => {
  const examples = [
    ['bad.tsx', 'export const tag = <span/>;', 'tsx-unsupported'],
    ['bad.ts', 'enum Shade { Blue }; export const tag = Shade.Blue;', 'non-strippable-syntax'],
    ['bad.mts', "namespace Shade { export const tag = 'blue'; }; export const tag = Shade.tag;", 'non-strippable-syntax'],
    ['bad.cts', "class Shade { constructor(public tag: string) {} }; export const tag = new Shade('blue').tag;", 'non-strippable-syntax'],
  ];
  for (const [name, source, code] of examples) {
    const data = await fixture(t, { [`shared/${name}`]: source, 'catalog/widgets/alpha.item.ts': `import {tag} from '../../shared/${name}'; export default {...${JSON.stringify(value())},tag};` });
    const result = await loadFamilies(data);
    assert.ok(result.diagnostics.some((item) => item.code === code && item.file === `shared/${name}`), JSON.stringify(result.diagnostics));
    assert.equal(result.manifests.length, 0);
  }
});

test('manifest errors isolate export counts, IDs, families, kinds and JSON impurity', async (t) => {
  const data = await fixture(t, {
    'catalog/widgets/count.item.ts': `${manifest('count')} export const extra = 2;`,
    'catalog/widgets/id.item.ts': manifest('different'),
    'catalog/widgets/family.item.ts': manifest('family', { family: 'other' }),
    'catalog/widgets/kind.item.ts': manifest('kind', { implementation: { kind: 'module', module: '../../main' } }),
    'catalog/widgets/function.item.ts': `export default {...${JSON.stringify(value('function'))}, callback: () => 1};`,
    'catalog/widgets/cycle.item.ts': `const item = ${JSON.stringify(value('cycle'))}; item.loop = item; export default item;`,
    'catalog/widgets/undefined.item.ts': `export default {...${JSON.stringify(value('undefined'))},extra:undefined};`,
    'catalog/widgets/schema.item.ts': manifest('schema', { tag: 42 }),
  });
  const result = await loadFamilies(data);
  assert.deepEqual(result.manifests.map((item) => item.id), ['alpha']);
  for (const code of ['manifest-export-count', 'manifest-id-mismatch', 'manifest-family-mismatch', 'implementation-kind-forbidden', 'manifest-not-json', 'manifest-schema']) assert.ok(result.diagnostics.some((item) => item.code === code), code);
  assert.equal(result.diagnostics.filter((item) => item.code === 'manifest-not-json').length, 3);
});

test('contracts validate branding, reserved fields and typed link schema paths', async (t) => {
  const cases = [
    [`export default {id:'widget'};`, 'contract-invalid'],
    [`export const thing = 1;`, 'contract-default-missing'],
    [contract(`id:'other',`), 'contract-id-mismatch'],
    [contract(`fields:s.object({id:s.string()}),`), 'contract-reserved-field'],
    [contract(`links:[{field:'tag[]',to:'widget',kind:'related-to'}],`), 'link-path-invalid'],
    [contract(`links:[{field:'tag',to:'missing',kind:'related-to'}],`), 'link-target-family'],
    [contract(`generators:['registry'],`), 'registry-out-missing'],
  ];
  for (const [source, code] of cases) {
    const data = await fixture(t, { [family.contract]: source });
    const result = await loadFamilies(data);
    assert.ok(result.diagnostics.some((item) => item.code === code), JSON.stringify(result.diagnostics));
    assert.equal(result.manifests.length, 0);
  }
});

test('family check gets frozen manifests and all structural peers then rejects only failures', async (t) => {
  const data = await fixture(t, { [family.contract]: contract(`check: (m,ctx) => { if (!Object.isFrozen(m) || !Object.isFrozen(ctx)) throw Error('not frozen'); if (!ctx.get('widget:alpha')) throw Error('peer missing'); return m.id === 'bravo' ? [{path:'$.tag',message:'Rejected fixture',code:'fixture-check'}] : []; },`), 'catalog/widgets/bravo.item.ts': manifest('bravo') });
  const result = await loadFamilies(data);
  assert.equal(result.families[0].hasCheck, true);
  assert.equal(result.families[0].check, undefined);
  assert.deepEqual(result.manifests.map((item) => item.id), ['alpha']);
  assert.ok(result.diagnostics.some((item) => item.code === 'family-check-failed' && item.field === '$.tag' && item.checkCode === 'fixture-check'));
});

test('cache tracks imported source changes and generation always runs in a fresh isolated child', async (t) => {
  const config = configFor({ generators: ['generators/summary.ts'] });
  const data = await fixture(t, {
    'shared/tag.ts': "export const tag = 'blue';",
    'catalog/widgets/alpha.item.ts': `import {tag} from '../../shared/tag'; export default {...${JSON.stringify(value())},tag};`,
    'generators/summary.ts': `import { defineGenerator } from 'block-beaver/kernel'; let calls=0; console.log('fixture child noise'); console.error('fixture stderr noise'); export default defineGenerator({out:'generated/summary.ts',inputs:['catalog/**/*.ts'],generate(ctx) { calls++; if(!Object.isFrozen(ctx.graph) || !Object.isFrozen(ctx.manifests('widget')[0]) || !Object.isFrozen(ctx.config)) throw Error('mutable context'); return JSON.stringify({calls,tag:ctx.manifests('widget')[0].tag,label:ctx.label,resolved:ctx.resolve('catalog/widgets/alpha.item.ts','../../shared/tag')}); }});`,
  }, config);
  const [first, concurrent] = await Promise.all([loadFamilies(data), loadFamilies(data)]);
  assert.equal(first.key, concurrent.key);
  const cached = await loadFamilies(data);
  assert.equal(first.key, cached.key);
  await writeFile(join(data.root, 'shared/tag.ts'), "export const tag = 'green';");
  const changed = await loadFamilies(data);
  assert.notEqual(first.key, changed.key);
  assert.equal(changed.manifests[0].value.tag, 'green');
  assert.equal(changed.generators[0].key, 'custom:generators/summary.ts');
  const generated = { ...data, generate: { keys: ['custom:generators/summary.ts'], graph: { nodes: [] }, label: 'test' } };
  const one = await loadFamilies(generated), two = await loadFamilies(generated);
  assert.deepEqual(one.diagnostics, []);
  assert.deepEqual(one.outputs, two.outputs);
  const output = JSON.parse(one.outputs[0].content);
  assert.equal(output.calls, 1);
  assert.equal(output.tag, 'green');
  assert.equal(output.resolved.path, 'shared/tag.ts');
  assert.equal(output.label, 'test');
});

test('configured loader uses its package and does not install Block Beaver hooks', async (t) => {
  const config = configFor({ loader: 'fixture-loader' });
  const data = await fixture(t, {
    'node_modules/fixture-loader/package.json': JSON.stringify({ name: 'fixture-loader', type: 'module', exports: { import: './index.mjs', require: './missing-require.cjs' } }),
    'node_modules/fixture-loader/index.mjs': `import { registerHooks,stripTypeScriptTypes } from 'node:module'; import {readFileSync} from 'node:fs'; registerHooks({load(url,ctx,next) {if(url.endsWith('.ts')) return {format:'module',source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8')),shortCircuit:true}; return next(url,ctx); }});`,
    'node_modules/block-beaver/package.json': JSON.stringify({ name: 'block-beaver', type: 'module', exports: { './kernel': './kernel.mjs' } }),
    'node_modules/block-beaver/kernel.mjs': `export * from ${JSON.stringify(new URL('../src/kernel/index.mjs', import.meta.url).href)};`,
  }, config);
  const result = await loadFamilies(data);
  assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
  assert.equal(result.manifests.length, 1);
  const missing = await loadFamilies({ ...data, config: { ...config, loader: 'missing-loader' } });
  assert.equal(missing.diagnostics[0].code, 'loader-package-missing');
  assert.equal(missing.manifests.length, 0);
});

test('repo-chosen .blocks authoring loads even with the scanner source list', async (t) => {
  const blockFamily = { ...family, contract: '.blocks/author/family.ts', manifests: '.blocks/author/*.item.ts' };
  const data = await fixture(t, { [blockFamily.contract]: contract(), '.blocks/author/alpha.item.ts': manifest() }, configFor({ families: [blockFamily] }));
  const result = await loadFamilies({ ...data, paths: [] });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.manifests[0].path, '.blocks/author/alpha.item.ts');
  assert.match(result.fileHashes[blockFamily.contract], /^[a-f0-9]{64}$/);
  assert.ok(result.discoveredFiles.includes('.blocks/author/alpha.item.ts'));
});

test('typed links reject source relationship kinds and preserve ordinary coverage while allowing block dependencies', async (t) => {
  for (const kind of ['implemented-by', 'declares', 'imports', 'reexports', 'calls', 'renders', 'dynamic-import', 'require']) {
    const data = await fixture(t, { [family.contract]: contract(`links:[{field:'tag',to:'widget',kind:'${kind}'}],`), 'source/plain.ts': 'export const unrelated = 1;' });
    const load = await loadFamilies(data);
    assert.ok(load.diagnostics.some((item) => item.code === 'contract-invalid' && item.field === '$.links[0].kind'), JSON.stringify(load.diagnostics));
    assert.equal(load.manifests.length, 0);
    const graph = { nodes: [{ id: 'file:source/plain.ts', kind: 'file', path: 'source/plain.ts' }], edges: [], hashes: {}, apps: [], summary: {}, fingerprint: 'fixture' };
    const before = auditCounts(graph);
    attachFamilies(graph, { load, project: { resolveImport: () => ({ error: 'none' }), ownerByFile: new Map(), apps: [] } });
    assert.deepEqual(auditCounts(graph), before);
    assert.equal(graph.edges.length, 0);
  }
  const data = await fixture(t, { [family.contract]: contract("links:[{field:'tag',to:'widget',kind:'depends-on'}],") });
  const load = await loadFamilies(data);
  assert.deepEqual(load.diagnostics, []);
  assert.equal(load.families[0].links[0].kind, 'depends-on');
});

test('adding an unresolved transitive import invalidates cached errors and child failure logs stay in diagnostics', async (t) => {
  const data = await fixture(t, { 'catalog/widgets/alpha.item.ts': `import {tag} from '../../shared/missing'; export default {...${JSON.stringify(value())},tag};` });
  const missing = await loadFamilies(data);
  assert.ok(missing.diagnostics.some((item) => item.code === 'unresolved-import'));
  await mkdir(join(data.root, 'shared'), { recursive: true });
  await writeFile(join(data.root, 'shared/missing.ts'), "export const tag = 'blue';");
  const fixed = await loadFamilies(data);
  assert.deepEqual(fixed.diagnostics, []);
  assert.equal(fixed.manifests.length, 1);
  assert.notEqual(fixed.key, missing.key);
  await writeFile(join(data.root, family.contract), "console.error('fixture captured log'); throw Error('fixture failure');");
  const loud = await loadFamilies(data);
  assert.ok(loud.diagnostics.some((item) => item.code === 'load-failed' && item.message.includes('fixture captured log')));
});

test('canonical hashes depend on data rather than property insertion order', () => {
  assert.equal(canonicalJson({ z: [2, { b: 1, a: 2 }], a: true }), '{"a":true,"z":[2,{"a":2,"b":1}]}');
  assert.equal(manifestHash({ a: 1, b: { c: 2 } }), manifestHash({ b: { c: 2 }, a: 1 }));
});

test('saving a source while its module waits cannot cache old values under the new source hash', async (t) => {
  const source = (tag) => `import {writeFile} from 'node:fs/promises'; await writeFile('.blocks/ready','reading'); await new Promise(r=>setTimeout(r,150)); ${manifest('alpha', { tag })}`;
  const original = source('blue');
  const data = await fixture(t, { '.blocks/ready': '', 'catalog/widgets/alpha.item.ts': original });
  const pending = loadFamilies(data);
  await waitFor(join(data.root, '.blocks/ready'), 'reading');
  await writeFile(join(data.root, 'catalog/widgets/alpha.item.ts'), source('green'));
  const first = await pending;
  assert.deepEqual(first.diagnostics, []);
  assert.equal(first.manifests[0].value.tag, 'blue');
  assert.equal(first.fileHashes['catalog/widgets/alpha.item.ts'], createHash('sha256').update(original).digest('hex'));
  const next = await loadFamilies(data);
  assert.deepEqual(next.diagnostics, []);
  assert.equal(next.manifests[0].value.tag, 'green');
  assert.notEqual(next.key, first.key);
});

test('a child that exits unsuccessfully is retried without any source change', async (t) => {
  const data = await fixture(t, { '.blocks/retry': 'first', 'catalog/widgets/alpha.item.ts': `import {readFileSync,writeFileSync} from 'node:fs'; if(readFileSync('.blocks/retry','utf8')==='first') {writeFileSync('.blocks/retry','second'); process.exit(2);} ${manifest()}` });
  const failed = await loadFamilies(data);
  assert.ok(failed.diagnostics.some((item) => item.code === 'load-failed' && item.file === undefined));
  const retried = await loadFamilies(data);
  assert.deepEqual(retried.diagnostics, []);
  assert.equal(retried.manifests.length, 1);
});

test('invalid loader paths and URLs never execute their preloads', async (t) => {
  const preload = "import {writeFileSync} from 'node:fs'; writeFileSync('.blocks/preload-marker','ran');";
  const data = await fixture(t, { 'tools/preload.mjs': preload, '.blocks/preload-marker': '' });
  for (const loader of ['./tools/preload.mjs', join(data.root, 'tools/preload.mjs'), `data:text/javascript,${encodeURIComponent(preload)}`]) {
    const result = await loadFamilies({ ...data, config: { ...data.config, loader } });
    assert.equal(result.manifests.length, 0);
    assert.ok(result.diagnostics.some((item) => item.field === '$.loader'));
    assert.equal(await readFile(join(data.root, '.blocks/preload-marker'), 'utf8'), '');
  }
});

test('declaration resolutions use the JavaScript runtime sibling, including a workspace package types entry', async (t) => {
  const data = await fixture(t, {
    'shared/legacy.js': "export const tag = 'blue';",
    'shared/legacy.d.ts': 'export declare const tag: string;',
    'packages/fixture-tool/package.json': JSON.stringify({ name: 'fixture-tool', type: 'module', main: 'lib/index.js', types: 'lib/index.d.ts' }),
    'packages/fixture-tool/lib/index.js': "export const tag = 'green'; export const identity = {};",
    'packages/fixture-tool/lib/index.d.ts': 'export declare const tag: string;',
    'catalog/widgets/alpha.item.ts': `import {tag} from '../../shared/legacy.js'; export default {...${JSON.stringify(value())},tag};`,
    'catalog/widgets/bravo.item.ts': `import {tag} from 'fixture-tool'; export default {...${JSON.stringify(value('bravo'))},tag};`,
  });
  await mkdir(join(data.root, 'node_modules'), { recursive: true });
  await symlink(join(data.root, 'packages/fixture-tool'), join(data.root, 'node_modules/fixture-tool'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await loadFamilies(data);
  assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
  assert.deepEqual(result.manifests.map((item) => item.value.tag), ['blue', 'green']);
  assert.ok(result.loadedFiles.includes('shared/legacy.js'));
  assert.ok(result.loadedFiles.includes('packages/fixture-tool/lib/index.js'), JSON.stringify(result.loadedFiles));
  assert.ok(!result.loadedFiles.some((path) => path.endsWith('.d.ts')));
  const nativeUrl = pathToFileURL(join(data.root, 'node_modules/fixture-tool/lib/index.js')).href;
  await writeFile(join(data.root, 'catalog/widgets/bravo.item.ts'), `import {tag, identity} from ${JSON.stringify(nativeUrl)}; import {identity as direct} from '../../packages/fixture-tool/lib/index.js'; export default {...${JSON.stringify(value('bravo'))},tag: identity === direct ? tag : 'duplicate'};`);
  const delegated = await loadFamilies(data);
  assert.deepEqual(delegated.diagnostics, []);
  assert.deepEqual(delegated.manifests.map(item => item.value.tag), ['blue', 'green']);
  assert.equal(delegated.loadedFiles.filter(path => path === 'packages/fixture-tool/lib/index.js').length, 1);
  assert.ok(delegated.fileHashes['packages/fixture-tool/lib/index.js']);
  await writeFile(join(data.root, 'packages/fixture-tool/lib/index.js'), "export const tag = 'changed'; export const identity = {};");
  const changed = await loadFamilies(data);
  assert.deepEqual(changed.diagnostics, []);
  assert.deepEqual(changed.manifests.map((item) => item.value.tag), ['blue', 'changed']);
});

test('a fallback that compiles to CommonJS preserves single default and named exports and rejects real duplicates', async (t) => {
  const config = configFor({ loader: 'fixture-cjs-loader', generators: ['generators/custom.ts'] });
  const tsUrl = import.meta.resolve('typescript');
  const kernelUrl = new URL('../src/kernel/index.mjs', import.meta.url).href;
  const data = await fixture(t, {
    'package.json': JSON.stringify({ type: 'commonjs' }),
    'node_modules/fixture-cjs-loader/package.json': JSON.stringify({ name: 'fixture-cjs-loader', type: 'module', exports: './index.mjs' }),
    'node_modules/fixture-cjs-loader/index.mjs': `import {registerHooks} from 'node:module'; import {readFileSync} from 'node:fs'; import ts from ${JSON.stringify(tsUrl)}; globalThis.fixtureKernel = await import(${JSON.stringify(kernelUrl)}); registerHooks({load(url,ctx,next) {if(url.endsWith('.ts')) return {format:'commonjs',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};return next(url,ctx);}});`,
    'node_modules/block-beaver/package.json': JSON.stringify({ name: 'block-beaver', exports: { './kernel': './kernel.cjs' } }),
    // Node 22's synchronous hook path cannot bridge require(ESM) during linking.
    // The fixture loader preloads the real kernel before registering its hook.
    'node_modules/block-beaver/kernel.cjs': 'module.exports = globalThis.fixtureKernel;',
    'catalog/widgets/bravo.item.ts': `export const item = ${JSON.stringify(value('bravo'))};`,
    'catalog/widgets/charlie.item.ts': `${manifest('charlie')} export const extra = 1;`,
    'generators/custom.ts': `import {defineGenerator} from 'block-beaver/kernel'; export default defineGenerator({out:'generated/custom.ts',inputs:['catalog/**/*.ts'],generate:ctx=>ctx.manifests('widget').map(m=>m.id).join(',')});`,
  }, config);
  const result = await loadFamilies({ ...data, generate: { keys: ['custom:generators/custom.ts'], graph: { nodes: [] }, label: null } });
  assert.deepEqual(result.manifests.map((item) => [item.id, item.exportName]), [['alpha', 'default'], ['bravo', 'item']], JSON.stringify(result.diagnostics));
  assert.ok(result.diagnostics.some((item) => item.code === 'manifest-export-count' && item.file.endsWith('charlie.item.ts')));
  assert.equal(result.outputs[0].content, 'alpha,bravo');
});

test('loader works when its own source package sits inside the scanned repository', async (t) => {
  const data = await fixture(t);
  const kitRoot = join(data.root, 'local-tool');
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  await mkdir(join(kitRoot, 'src'), { recursive: true });
  for (const path of ['families', 'kernel', 'project-model.mjs', 'project-files.mjs']) await cp(join(repositoryRoot, 'src', path), join(kitRoot, 'src', path), { recursive: true });
  await cp(join(repositoryRoot, 'package.json'), join(kitRoot, 'package.json'));
  await mkdir(join(kitRoot, 'node_modules'), { recursive: true });
  await symlink(join(repositoryRoot, 'node_modules/typescript'), join(kitRoot, 'node_modules/typescript'), process.platform === 'win32' ? 'junction' : 'dir');
  const { loadFamilies: localLoader } = await import(pathToFileURL(join(kitRoot, 'src/families/loader.mjs')).href);
  const result = await localLoader(data);
  assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
  assert.equal(result.manifests.length, 1);
});

test('generation context errors preserve valid loaded families and manifest diagnostics', async (t) => {
  const data = await fixture(t, { 'generators/custom.ts': `import {defineGenerator} from 'block-beaver/kernel'; export default defineGenerator({out:'generated/custom.ts',inputs:['catalog/**/*.ts'],generate:()=> 'never'});` }, configFor({ generators: ['generators/custom.ts'] }));
  const result = await loadFamilies({ ...data, generate: { keys: ['custom:generators/custom.ts'], graph: { bad: undefined }, label: null } });
  assert.equal(result.manifests.length, 1);
  assert.equal(result.families.length, 1);
  assert.equal(result.outputs[0].diagnostic.code, 'generator-failed');
  assert.match(result.outputs[0].diagnostic.message, /context.*JSON/i);
});

test('IPC noise and NODE_OPTIONS cannot replace the loader result or install competing hooks', async (t) => {
  const data = await fixture(t, { [family.contract]: `process.send({families:[],manifests:[],generators:[],loadedFiles:[],diagnostics:[]}); process.send({protocol:1,token:'wrong',result:{families:[],manifests:[],generators:[],loadedFiles:[],diagnostics:[]}}); ${contract()}` });
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--no-experimental-strip-types';
  try {
    const result = await loadFamilies(data);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.manifests.length, 1);
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
});

test('transitive package and JavaScript failures name the actual importing or offending source', async (t) => {
  const data = await fixture(t, {
    'node_modules/types-only/package.json': JSON.stringify({ name: 'types-only', types: './index.d.ts' }),
    'node_modules/types-only/index.d.ts': 'export declare const tag:string;',
    'shared/package.ts': "import {tag} from 'types-only'; export {tag};",
    'shared/syntax.js': 'export const tag = ;',
    'catalog/widgets/alpha.item.ts': `import {tag} from '../../shared/package'; export default {...${JSON.stringify(value())},tag};`,
    'catalog/widgets/bravo.item.ts': `import {tag} from '../../shared/syntax.js'; export default {...${JSON.stringify(value('bravo'))},tag};`,
  });
  const result = await loadFamilies(data);
  assert.ok(result.diagnostics.some((item) => item.code === 'unresolved-import' && item.file === 'shared/package.ts'), JSON.stringify(result.diagnostics));
  assert.ok(result.diagnostics.some((item) => item.code === 'load-failed' && item.file === 'shared/syntax.js'), JSON.stringify(result.diagnostics));
});

test('concurrent requests share one child and the parent never registers hooks or evaluates repo source', async (t) => {
  const data = await fixture(t, { '.blocks/spawns': '', [family.contract]: `import {appendFile} from 'node:fs/promises'; await appendFile('.blocks/spawns','x'); await new Promise(r=>setTimeout(r,50)); globalThis.loaderIsolationFixture = true; ${contract()}` });
  const original = module.registerHooks;
  module.registerHooks = () => { throw new Error('Parent hook registration is forbidden'); };
  try {
    const results = await Promise.all([loadFamilies(data), loadFamilies(data), loadFamilies(data)]);
    assert.ok(results.every((result) => result.manifests.length === 1 && !result.diagnostics.length));
    assert.equal(await readFile(join(data.root, '.blocks/spawns'), 'utf8'), 'x');
    assert.equal(globalThis.loaderIsolationFixture, undefined);
  } finally { module.registerHooks = original; }
});

test('the discovery limit returns a located diagnostic through loadFamilies', async (t) => {
  const data = await fixture(t, { 'data/seed': '' });
  for (let offset = 0; offset < 20000; offset += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(data.root, `data/input-${offset + index}`), '')));
  }
  const result = await loadFamilies(data);
  assert.equal(result.diagnostics[0].code, 'loader-file-limit');
  assert.equal(result.diagnostics[0].file, '.');
  assert.equal(result.manifests.length, 0);
});
