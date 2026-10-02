import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { renderBlockMap } from '../src/block-map.mjs';
import { renderFamilyMap, linkColor, mapStorageKey, renderMapStyle, installFamilyMap, FAMILY_MAP_CSS } from '../src/families/map-render.mjs';
import { prepareMapStyle } from '../src/families/map-style.mjs';
import { attachProjectRegistry } from '../src/adapter.mjs';
import { scanRepository } from '../src/scanner.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export const familyMapFixture = () => ({
  root: '.', repoName: 'fixture-repository', schemaVersion: 2,
  apps: [{ id: 'web', root: '.', health: {} }, { id: 'admin', root: 'apps/admin', health: {} }],
  families: [{ id: 'record', floor: 0, title: 'Record inventory', blurb: 'Tracked records', linkKinds: ['related-to'], count: 2 }, { id: 'screen', floor: 1, title: 'Screen inventory', blurb: 'Available screens', linkKinds: ['displays'], count: 1 }],
  nodes: [
    { id: 'block:record:first', family: 'record', kind: 'block', floor: 0, name: 'First record', description: 'First', path: 'blocks/records/first.ts', app: 'web', usedBy: ['web', 'admin'] },
    { id: 'block:record:second', family: 'record', kind: 'block', floor: 0, name: 'Second record', description: 'Second', path: 'blocks/records/second.ts', app: 'web', usedBy: ['web'] },
    { id: 'block:screen:main', family: 'screen', kind: 'block', floor: 1, name: 'Main screen', description: 'Main', path: 'blocks/screens/main.ts', app: 'admin', usedBy: ['admin'] },
    { id: 'file:src/main.ts', kind: 'file', name: 'main.ts', path: 'src/main.ts', app: 'web', usedBy: ['web', 'admin'], lines: 5 },
    { id: 'file:apps/admin/lib/main.ts', kind: 'file', name: 'main.ts', path: 'apps/admin/lib/main.ts', app: 'admin', usedBy: ['admin'], lines: 2 },
  ],
  edges: [{ from: 'block:screen:main', to: 'block:record:first', kind: 'displays', link: true, crossApp: true, evidence: { file: 'blocks/screens/main.ts', line: 1, text: 'record → first' } }],
  history: [{ date: '2026-09-30T00:00:00.000Z', label: 'Initial', blocks: ['block:record:first'] }, { date: '2026-10-01T00:00:00.000Z', label: 'Expanded', blocks: ['block:record:first', 'block:screen:main'] }],
  summary: { files: 2, pieces: 0, blocks: 3, relationships: 1 },
  resolutionReport: [],
  mapStyle: { css: '.family-surface{opacity:.9}', tokens: { 'link-displays': '#123456', 'font-family': 'system-ui' } },
});

test('family map has configured floor order, typed links and app-relative ordinary slabs', () => {
  const graph = familyMapFixture();
  const html = renderBlockMap(graph);
  assert.ok(html.indexOf('data-family="record"') < html.indexOf('data-family="screen"'));
  assert.match(html, /Record inventory/);
  assert.match(html, /Screen inventory/);
  assert.match(html, /class="family-link cross-app"/);
  assert.match(html, /var\(--bb-link-displays,/);
  assert.match(html, /--bb-link-displays:#123456/);
  assert.match(html, /class="ordinary-slab"/);
  assert.match(html, /<text class="rail-name"[^>]*>admin · lib<\/text>/, 'rail rows are app-relative folders, prefixed by app when there are several');
  assert.match(html, /<text class="rail-count[^"]*"[^>]*>1 file<\/text>/);
  assert.match(html, /block-beaver:fixture-repository:family-history/);
  assert.match(html, /id="family-history"[^>]*max="2"/);
  assert.equal(html, renderBlockMap(graph));
  for (const tag of html.matchAll(/<(script|style)\b([^>]*)>/gi)) assert.match(tag[2], /nonce="__BLOCK_BEAVER_NONCE__"/);
  assert.doesNotMatch(html, /(?:https?:)?\/\/|\son\w+=|javascript:|\beval\s*\(|\sstyle=/i);
});

test('family snapshots safely encode hostile manifest text in embedded data', () => {
  const graph = familyMapFixture();
  graph.nodes[0].description = '</script><img src=x onerror=alert(1)>';
  const html = renderBlockMap(graph);
  const json = html.match(/<script type="application\/json" id="family-map-data"[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(json, /<\/script>/);
  assert.equal(JSON.parse(json).nodes[0].description, graph.nodes[0].description);
});

test('zero-family maps keep base presentation and empty histories have no slider', () => {
  const graph = familyMapFixture();
  graph.families = [];
  assert.equal(renderFamilyMap(graph), '');
  assert.doesNotMatch(renderBlockMap(graph), /class="family-map"|id="family-history"|family-map-data/);
  graph.families = [{ id: 'record', floor: 0 }];
  graph.history = [];
  assert.match(renderFamilyMap(graph), /data-family="record"/);
  assert.doesNotMatch(renderFamilyMap(graph), /id="family-history"/);
  assert.equal(linkColor('displays'), linkColor('displays'));
  assert.equal(mapStorageKey({ repoName: 'owner repo' }, 'history'), 'block-beaver:owner-repo:history');
});

test('map skins and tokens inline safely, allowing host-served fonts and rejecting remote assets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-skin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'skin.css'), '@font-face{font-family:HostFont;src:url("/fonts/host.woff2")} .family-map{background:#eee}');
  const valid = await prepareMapStyle(root, { map: { skin: 'skin.css', tokens: { 'font-family': 'HostFont', 'block-surface': '#fff' } } });
  assert.deepEqual(valid.diagnostics, []);
  assert.match(renderMapStyle(valid), /--bb-font-family:HostFont/);
  for (const css of ['@import "https://example.com/x.css";', 'body{background:url(https://example.com/x)}', '</style><script>alert(1)</script>', 'body{background:u\\72l(https://example.com/x)}']) {
    await writeFile(join(root, 'skin.css'), css);
    const invalid = await prepareMapStyle(root, { map: { skin: 'skin.css', tokens: { bad: 'red;display:none', good: '#fff' } } });
    assert.equal(invalid.css, '');
    assert.equal(invalid.tokens.bad, undefined);
    assert.equal(invalid.tokens.good, '#fff');
    assert.ok(invalid.diagnostics.length >= 2);
  }
  const missing = await prepareMapStyle(root, { map: { skin: '../outside.css' } });
  assert.ok(missing.diagnostics.length);
});


test('configured map skin and tokens survive actual scanning and registry attachment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-map-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { schemaVersion: 1, apps: [{ id: 'app', root: '.', source: 'config' }], families: [{ id: 'record', contract: 'definitions/record.family.ts', manifests: 'blocks/records/*.ts' }], map: { skin: 'skin.css', tokens: { 'block-surface': '#123456' } } };
  const files = {
    '.blocks/config.json': JSON.stringify(config),
    'package.json': JSON.stringify({ name: 'map-pipeline-fixture', type: 'module' }),
    'definitions/record.family.ts': "import {defineFamily,s} from 'block-beaver/kernel'; export default defineFamily({id:'record',fields:s.object({}),implementation:['none'],map:{title:'Record inventory'}});",
    'blocks/records/first.ts': 'export default ' + JSON.stringify({ id: 'first', family: 'record', version: 1, name: 'First', description: 'First record', rationale: 'Independent record', implementation: { kind: 'none' } }) + ';',
    'skin.css': '.family-surface{opacity:.37}',
  };
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  const graph = await attachProjectRegistry(await scanRepository(root, { writeConfig: false }));
  assert.equal(graph.families.length, 1);
  assert.equal(graph.mapStyle.css, files['skin.css']);
  assert.equal(graph.mapStyle.tokens['block-surface'], '#123456');
  const html = renderBlockMap(graph);
  assert.match(html, /--bb-block-surface:#123456/);
  assert.match(html, /\.family-surface\{opacity:\.37\}/);
});

test('disposed family controllers leave a single delegated handler after repeated renders', () => {
  class Container extends EventTarget {
    querySelector() { return null; }
    querySelectorAll() { return []; }
    contains() { return true; }
    closest() { return { dataset: { mapId: 'block:record:first' } }; }
  }
  const container = new Container(), graph = familyMapFixture();
  let controller, selections = 0;
  for (let index = 0; index < 10; index++) {
    controller?.dispose();
    controller = installFamilyMap(container, graph, { onSelect: () => selections++ });
  }
  container.dispatchEvent(new Event('click'));
  assert.equal(selections, 1);
  controller.dispose();
  container.dispatchEvent(new Event('click'));
  assert.equal(selections, 1);
});

const floorConfig = (map) => ({ families: ['alpha', 'beta', 'gamma'].map((id) => ({ id, contract: `${id}.family.ts`, manifests: `blocks/${id}/*.ts` })), ...(map ? { map } : {}) });

test('map.floors orders map floors while configIndex keeps config order', async () => {
  const { parseFamiliesConfig } = await import('../src/families/config.mjs');
  const view = (config) => parseFamiliesConfig(config).families.map(({ id, floor, configIndex }) => [id, floor, configIndex]);
  assert.deepEqual(view(floorConfig()), [['alpha', 0, 0], ['beta', 1, 1], ['gamma', 2, 2]]);
  assert.deepEqual(view(floorConfig({ floors: [] })), [['alpha', 0, 0], ['beta', 1, 1], ['gamma', 2, 2]]);
  assert.deepEqual(view(floorConfig({ floors: ['gamma', 'alpha', 'beta'] })), [['alpha', 1, 0], ['beta', 2, 1], ['gamma', 0, 2]]);
  assert.deepEqual(view(floorConfig({ floors: ['gamma'] })), [['alpha', 1, 0], ['beta', 2, 1], ['gamma', 0, 2]], 'unlisted families follow listed ones in config order');
  assert.deepEqual(view(floorConfig({ floors: ['beta', 'beta', 'missing', 'alpha'] })), [['alpha', 1, 0], ['beta', 0, 1], ['gamma', 2, 2]]);
});

test('graph families and the drawn map follow map floors', async () => {
  const { attachFamilies } = await import('../src/families/graph.mjs');
  const { parseFamiliesConfig } = await import('../src/families/config.mjs');
  const parsed = parseFamiliesConfig(floorConfig({ floors: ['gamma', 'alpha'] })).families;
  const families = parsed.map(({ floor, configIndex, ...config }) => ({ id: config.id, floor, configIndex, config }));
  const manifests = families.map((family) => ({ family: family.id, id: 'one', ref: `${family.id}:one`, graphId: `block:${family.id}:one`, path: `blocks/${family.id}/one.ts`, value: { id: 'one', family: family.id, name: family.id, description: family.id } }));
  const source = { root: '.', nodes: [], edges: [], apps: [], summary: {} };
  const result = attachFamilies(source, { load: { families, manifests, generators: [], diagnostics: [] }, project: { resolveImport() { return null; } } });
  assert.deepEqual(result.families.map((item) => [item.id, item.floor]), [['gamma', 0], ['alpha', 1], ['beta', 2]]);
  assert.deepEqual(result.nodes.filter((node) => node.kind === 'block').map((node) => [node.family, node.floor]), [['alpha', 1], ['beta', 2], ['gamma', 0]]);
  const html = renderFamilyMap(result);
  assert.ok(html.indexOf('data-family="gamma"') < html.indexOf('data-family="alpha"') && html.indexOf('data-family="alpha"') < html.indexOf('data-family="beta"'));
  const shuffled = { ...result, families: [...result.families].reverse() };
  assert.equal(renderFamilyMap(shuffled), html, 'rendering orders by floor even for hand-built graphs');
});

/** A minimal DOM over rendered markup: enough selectors and attributes for the shared controller. */
function fakeDocument(html) {
  const elements = [];
  const dataName = (key) => `data-${String(key).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
  for (const match of html.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const attributes = new Map([...match[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, (value ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')]));
    const element = {
      tagName: match[1].toLowerCase(), attributes, listeners: new Map(), classes: new Set((attributes.get('class') || '').split(/\s+/).filter(Boolean)),
      dataset: new Proxy({}, { get: (_, key) => attributes.get(dataName(key)), set: (_, key, value) => { attributes.set(dataName(key), String(value)); return true; } }),
      get value() { return attributes.get('value') ?? (this.tagName === 'select' ? this.options[0]?.attributes.get('value') : ''); },
      set value(value) { attributes.set('value', String(value)); },
      get media() { return attributes.get('media'); },
      set media(value) { attributes.set('media', value); },
      get hidden() { return attributes.has('hidden'); },
      set hidden(value) { if (value) attributes.set('hidden', ''); else attributes.delete('hidden'); },
      get options() { return elements.filter((other) => other.tagName === 'option' && other.index > this.index && !elements.some((between) => between.tagName !== 'option' && between.index > this.index && between.index < other.index)); },
      textContent: '', innerHTML: '',
      hasAttribute: (name) => attributes.has(name),
      getAttribute: (name) => attributes.has(name) ? attributes.get(name) : null,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: (name) => attributes.delete(name),
      toggleAttribute(name, force) { if (force) attributes.set(name, ''); else attributes.delete(name); },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      removeEventListener(type) { this.listeners.delete(type); },
    };
    element.classList = { add: (name) => element.classes.add(name), remove: (name) => element.classes.delete(name), contains: (name) => element.classes.has(name) };
    element.index = elements.length;
    elements.push(element);
  }
  const matches = (element, selector) => {
    const parts = selector.match(/^([a-z]+)?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
    if (!parts) throw new Error(`Unsupported selector ${selector}`);
    const [, tag, id, className, attribute, value] = parts;
    return (!tag || element.tagName === tag) && (!id || element.attributes.get('id') === id) && (!className || element.classes.has(className)) && (!attribute || (element.attributes.has(attribute) && (value === undefined || element.attributes.get(attribute) === value)));
  };
  const all = (selector) => elements.filter((element) => selector.split(',').some((part) => matches(element, part.trim())));
  const listeners = new Map();
  return { elements, listeners, querySelector: (selector) => all(selector)[0] || null, querySelectorAll: all, addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: (type) => listeners.delete(type), contains: () => true };
}

function withBrowserGlobals(t, store = new Map()) {
  const previous = { CSS: globalThis.CSS, localStorage: globalThis.localStorage };
  globalThis.CSS = { escape: (value) => String(value).replace(/["\\]/g, '\\$&') };
  globalThis.localStorage = { getItem: (key) => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, String(value)) };
  t.after(() => { globalThis.CSS = previous.CSS; globalThis.localStorage = previous.localStorage; });
  return store;
}

const parityFixture = () => {
  const graph = familyMapFixture();
  graph.codeReach = [
    { app: 'web', folder: 'src', block: 'block:record:first', via: 'import', files: ['src/main.ts'] },
    { app: 'web', folder: 'src', block: 'block:screen:main', via: 'binding', files: ['src/main.ts'] },
    { app: 'web', folder: 'missing', block: 'block:record:first', via: 'import', files: ['missing/x.ts'] },
  ];
  graph.unused = ['block:record:second'];
  graph.history = [
    { date: '2026-09-29', label: 'Seed', blocks: ['block:record:first', 'block:record:old'], gone: [] },
    { date: '2026-09-30', label: 'Pruned', blocks: ['block:record:first'], gone: [{ id: 'block:record:old', family: 'record', name: 'old' }] },
    { date: '2026-10-01', label: 'Expanded', blocks: ['block:record:first', 'block:screen:main'], gone: [{ id: 'block:record:old', family: 'record', name: 'old' }] },
  ];
  return graph;
};

test('families without new map data keep their 0.5.1 drawing', () => {
  const graph = familyMapFixture();
  const plain = renderFamilyMap(graph);
  assert.equal(renderFamilyMap({ ...graph, codeReach: [], unused: [], history: graph.history.map((entry) => ({ ...entry, gone: [] })) }), plain);
  assert.doesNotMatch(plain, /reach|unused|family-ghost|group-label|family-skin|data-skin|family-map-key/);
  assert.doesNotMatch(renderBlockMap(graph), /<style[^>]*data-map-skin|"codeReach"/);
});

test('ordinary code slabs show the blocks they reach, with hidden reach lines and evidence data', () => {
  const graph = parityFixture();
  const html = renderBlockMap(graph);
  const map = renderFamilyMap(graph);
  assert.match(map, /<g class="ordinary-code reaches" tabindex="0" role="button" aria-label="src reaches 2 blocks" data-map-reach="\d+" data-map-folder="src" data-map-app="web"/);
  assert.match(map, />reaches 2 blocks<\/text>/);
  assert.equal([...map.matchAll(/<path class="reach-line"[^>]*hidden\/>/g)].length, 2);
  assert.match(map, /data-reach-block="block:screen:main"/);
  assert.match(map, /1 code folder reaches blocks/);
  assert.match(map, /<g class="ordinary-code" data-map-app="admin"/, 'folders without reach keep plain slabs');
  const data = JSON.parse(html.match(/<script type="application\/json" id="family-map-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.codeReach.length, 3);
});

test('reach highlighting lights reached blocks and lines, then clears and disposes', (t) => {
  withBrowserGlobals(t);
  const graph = parityFixture();
  const dom = fakeDocument(renderFamilyMap(graph));
  const slab = dom.querySelector('[data-map-reach]');
  const controller = installFamilyMap(dom, graph);
  const lines = () => dom.querySelectorAll('[data-reach-source]').filter((line) => !line.hasAttribute('hidden')).length;
  dom.listeners.get('focusin')({ type: 'focusin', target: { closest: () => slab } });
  assert.ok(dom.querySelector('[data-map-id="block:record:first"]').classes.has('reach-lit'));
  assert.ok(dom.querySelector('[data-map-id="block:screen:main"]').classes.has('reach-lit'));
  assert.ok(!dom.querySelector('[data-map-id="block:record:second"]').classes.has('reach-lit'));
  assert.equal(lines(), 2);
  dom.listeners.get('focusout')({ type: 'focusout', target: { closest: () => slab }, relatedTarget: null });
  assert.equal(dom.querySelectorAll('.reach-lit').length, 0);
  assert.equal(lines(), 0);
  controller.dispose();
  assert.equal(dom.listeners.size, 0, 'every delegated listener is removed');
});

test('unused blocks are dashed and listed in the key', () => {
  const map = renderFamilyMap(parityFixture());
  assert.match(map, /<g class="family-node unused" tabindex="0" role="button" aria-label="Inspect Second record \(unused\)" data-map-id="block:record:second"/);
  assert.match(map, /<g class="family-node" tabindex="0" role="button" aria-label="Inspect First record"/);
  assert.match(map, /1 unused block \(dashed\)/);
  assert.match(map, /<summary>Unused blocks · 1<\/summary><ul><li><button type="button" data-map-select="block:record:second">Second record<\/button> <small>record<\/small><\/li><\/ul>/);
  // Bricks are <use> clones, so state reaches their faces through inherited custom properties.
  assert.match(FAMILY_MAP_CSS, /\.family-node\.unused\{[^}]*--dash:/);
  assert.match(FAMILY_MAP_CSS, /\.top,\.l,\.r,\.stud\{[^}]*stroke-dasharray:var\(--dash,none\)/);
});

test('removed blocks return as ghost bricks only at snapshots where they stood', (t) => {
  const store = withBrowserGlobals(t);
  const graph = parityFixture();
  const map = renderFamilyMap(graph);
  assert.match(map, /<g class="family-node family-ghost" data-map-ghost="block:record:old" data-map-search="old block:record:old" hidden><title>old · block:record:old · removed<\/title>/);
  const record = map.slice(map.indexOf('data-family="record"'), map.indexOf('data-family="screen"'));
  assert.match(record, /data-map-ghost="block:record:old"/, 'ghosts sit on their family floor');
  assert.match(map, /Removed blocks return as ghost bricks\./);
  const dom = fakeDocument(map);
  const ghost = dom.querySelector('[data-map-ghost]');
  const slider = dom.querySelector('#family-history');
  const controller = installFamilyMap(dom, graph);
  const visible = (value) => { slider.value = String(value); controller.update(); return !ghost.hasAttribute('hidden'); };
  assert.equal(visible(3), false, 'current view hides gone bricks');
  assert.equal(visible(0), true, 'the snapshot where the block stood shows it');
  assert.equal(dom.querySelector('[data-map-id="block:record:second"]').hasAttribute('hidden'), true);
  assert.equal(visible(1), false, 'after removal it is gone');
  assert.equal(visible(2), false);
  controller.dispose();
  assert.equal(store.size, 0);
});

test('map.groupBy clusters floors with labels, from attachFamilies node.group', async () => {
  const { attachFamilies } = await import('../src/families/graph.mjs');
  const families = [{ id: 'screen', floor: 0, configIndex: 0, config: { id: 'screen', manifests: 'blocks/*.ts' } }];
  const values = { a: 'admin', b: 'public', c: 'admin', d: undefined, e: { nested: true } };
  const manifests = Object.entries(values).map(([id, area]) => ({ family: 'screen', id, path: `blocks/${id}.ts`, value: { id, family: 'screen', name: `Screen ${id}`, description: id, ...(area === undefined ? {} : { area }) } }));
  const build = (groupBy) => attachFamilies({ root: '.', nodes: [], edges: [], apps: [], summary: {} }, { load: { families, manifests, generators: [], diagnostics: [] }, project: { resolveImport() { return null; } }, groupBy });
  const plain = build(undefined);
  assert.ok(plain.nodes.every((node) => !Object.hasOwn(node, 'group')), 'no groupBy, no group field');
  const grouped = build('area');
  assert.deepEqual(grouped.nodes.map((node) => node.group), ['admin', 'public', 'admin', null, null]);
  assert.notEqual(grouped.fingerprint, plain.fingerprint);
  const map = renderFamilyMap(grouped);
  const labels = [...map.matchAll(/<text class="group-label"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['admin · 2', 'public · 1', 'Ungrouped · 2']);
  const drawn = [...map.matchAll(/data-map-id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(drawn, ['block:screen:a', 'block:screen:c', 'block:screen:b', 'block:screen:d', 'block:screen:e']);
  assert.match(map, /data-map-group="admin"/);
  assert.equal(renderFamilyMap(grouped), map);
  grouped.nodes[0].group = '<b>"x"</b>';
  assert.match(renderFamilyMap(grouped), /&lt;b&gt;&quot;x&quot;&lt;\/b&gt; · 1/);
});

test('a family map.group wins over config groupBy for its floor only, and format is not applied without a value', async () => {
  const { attachFamilies } = await import('../src/families/graph.mjs');
  const families = [{ id: 'screen', floor: 0, configIndex: 0, config: { id: 'screen', manifests: 'blocks/*.ts' }, map: { group: { field: 'meta.area', format: 'Area {value}' } } }, { id: 'page', floor: 1, configIndex: 1, config: { id: 'page', manifests: 'pages/*.ts' } }];
  const manifests = [['screen', 'a', { meta: { area: 'x' }, area: 'ignored' }], ['screen', 'b', { meta: null, area: 'ignored' }], ['page', 'c', { area: 'p' }]].map(([family, id, extra]) => ({ family, id, path: `${family}/${id}.ts`, value: { id, family, name: id, description: id, ...extra } }));
  const graph = attachFamilies({ root: '.', nodes: [], edges: [], apps: [], summary: {} }, { load: { families, manifests, generators: [], diagnostics: [] }, project: { resolveImport() { return null; } }, groupBy: 'area' });
  assert.deepEqual(graph.nodes.map((node) => node.group), ['Area x', null, 'p']);
  const labels = [...renderFamilyMap(graph).matchAll(/<text class="group-label"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['Area x · 1', 'Ungrouped · 1', 'p · 1']);
});

test('map.skins render validated, nonce-carrying sheets with a remembered per-browser toggle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-skins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'paper.css'), '.family-map{background:#fdfbf4}');
  await writeFile(join(root, 'night.css'), '.family-map{background:#14232b}');
  await writeFile(join(root, 'evil.css'), '</style><script>alert(1)</script>');
  const style = await prepareMapStyle(root, { map: { tokens: { 'block-surface': '#eee' }, skins: [{ id: 'paper', path: 'paper.css' }, { id: 'night', path: 'night.css', tokens: { 'map-text': '#fff', bad: 'red;x:y' } }, { id: 'evil', path: 'evil.css' }, { id: 'Bad Id' }] } });
  assert.deepEqual(style.skins.map((skin) => [skin.id, skin.css]), [['paper', '.family-map{background:#fdfbf4}'], ['night', '.family-map{background:#14232b}'], ['evil', '']]);
  assert.deepEqual(style.skins[1].tokens, { 'map-text': '#fff' });
  assert.ok(style.diagnostics.some((entry) => /Skin evil:/.test(entry.message) && entry.file === 'evil.css'));
  assert.ok(style.diagnostics.some((entry) => /Skin night: Invalid map token: bad/.test(entry.message)));
  assert.ok(style.diagnostics.some((entry) => /kebab-case/.test(entry.message)));
  assert.ok(style.diagnostics.every((entry) => entry.rule === 'config-valid' && entry.code === 'map-style-invalid'));
  assert.deepEqual(Object.keys(await prepareMapStyle(root, { map: { tokens: { a: '#fff' } } })), ['css', 'tokens', 'diagnostics'], 'legacy style data is unchanged');

  const graph = familyMapFixture();
  graph.mapStyle = { ...style, skins: [...style.skins, { id: '"><script>', css: 'x' }] };
  const html = renderBlockMap(graph);
  assert.match(html, /<style nonce="__BLOCK_BEAVER_NONCE__" data-map-skin="paper" media="all">\.family-map\{background:#fdfbf4\}<\/style><style nonce="__BLOCK_BEAVER_NONCE__" data-map-skin="night" media="not all">:root\{--bb-map-text:#fff\}\n\.family-map\{background:#14232b\}<\/style>/);
  assert.doesNotMatch(html, /alert\(1\)|"><script>/);
  assert.match(html, /<select id="family-skin" data-storage-key="block-beaver:fixture-repository:family-skin"><option value="paper">paper<\/option><option value="night">night<\/option><option value="evil">evil<\/option><\/select>/);
  assert.match(html, /<section class="family-map" aria-label="Family map" data-skin="paper">/);
  for (const tag of html.matchAll(/<(script|style)\b([^>]*)>/gi)) assert.match(tag[2], /nonce="__BLOCK_BEAVER_NONCE__"/);
  assert.doesNotMatch(html, /(?:https?:)?\/\/|\son\w+=|javascript:|\beval\s*\(|\sstyle=/i);
  assert.equal(html, renderBlockMap(graph));

  const store = withBrowserGlobals(t, new Map([['block-beaver:fixture-repository:family-skin', 'night']]));
  const dom = fakeDocument(html);
  const sheet = (id) => dom.querySelector(`style[data-map-skin="${id}"]`);
  const controller = installFamilyMap(dom, graph);
  assert.equal(sheet('night').media, 'all', 'a remembered skin is restored');
  assert.equal(sheet('paper').media, 'not all');
  assert.equal(dom.querySelector('.family-map').attributes.get('data-skin'), 'night');
  const select = dom.querySelector('#family-skin');
  select.value = 'paper';
  select.listeners.get('change')();
  assert.equal(store.get('block-beaver:fixture-repository:family-skin'), 'paper');
  assert.equal(sheet('paper').media, 'all');
  assert.equal(sheet('night').media, 'not all');
  controller.dispose();
  assert.equal(select.listeners.size, 0);
  const single = familyMapFixture();
  single.mapStyle = { ...style, skins: style.skins.slice(0, 1) };
  assert.doesNotMatch(renderBlockMap(single), /id="family-skin"/, 'one skin needs no toggle');
});

test('hostile text in reach, unused, ghost and group data is escaped', () => {
  const graph = parityFixture();
  const hostile = '<img src=x onerror=alert(1)>"\'';
  graph.nodes[1].name = hostile;
  graph.nodes.push({ id: `file:${hostile}/a.ts`, kind: 'file', name: 'a.ts', path: `${hostile}/a.ts`, app: 'web' });
  graph.codeReach.push({ app: 'web', folder: hostile, block: 'block:record:second', via: 'import', files: [`${hostile}/a.ts`] });
  graph.history[0].blocks.push(`block:record:${hostile}`);
  const html = renderBlockMap(graph);
  assert.doesNotMatch(html, /<img/i, 'no raw tag survives; the payload only appears escaped');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;/);
  assert.match(html, /aria-label="&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39; reaches 1 block"/);
});

const mapDetailFixture = () => {
  const graph = parityFixture();
  graph.edges = [
    { from: 'file:src/main.ts', to: 'file:apps/admin/lib/main.ts', kind: 'imports', crossApp: true, evidence: { file: 'src/main.ts', line: 1, column: 9, text: 'import "../apps/admin/lib/main"' } },
    ...graph.edges,
    { from: 'block:record:second', to: 'file:src/main.ts', kind: 'implemented-by' },
  ];
  return graph;
};
const payload = (html) => JSON.parse(html.match(/<script type="application\/json" id="family-map-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
// The cross-app evidence list (data-map-history-*) is page detail, not the drawing; edge indices are compared separately.
const mapAttributes = (html) => [...html.matchAll(/ (data-(?:map|family|floor|reach)[\w-]*)="([^"]*)"/g)].map(([, name, value]) => `${name}=${value}`).filter((pair) => !/^data-map-(?:edge|history-)/.test(pair));

test('map detail embeds only what the family map draws and keeps the same drawing', () => {
  const graph = mapDetailFixture();
  const full = renderBlockMap(graph), slim = renderBlockMap(graph, { detail: 'map' });
  assert.equal(renderBlockMap(graph, { detail: 'full' }), full);
  const data = payload(slim), fullData = payload(full);
  assert.deepEqual(data.edges.map((edge) => edge.kind), ['displays'], 'link edges only');
  assert.equal(fullData.edges.length, 3);
  assert.deepEqual(data.edges[0].evidence, { file: 'blocks/screens/main.ts', line: 1 }, 'evidence keeps file and line, never text or column');
  assert.ok(!/"text"/.test(JSON.stringify(data.edges)) && !slim.includes('record → first') && !slim.includes('../apps/admin/lib/main"'));
  assert.ok(data.nodes.every((node) => node.kind === 'block'), 'no file-level nodes');
  assert.equal(fullData.nodes.filter((node) => node.kind === 'file').length, 2);
  assert.ok(data.history.length === 3 && data.history.every((snapshot) => !('gone' in snapshot)));
  assert.ok(fullData.history.every((snapshot) => 'gone' in snapshot));
  assert.deepEqual(data.codeReach, graph.codeReach);
  assert.deepEqual(mapAttributes(slim), mapAttributes(full), 'same floors, bricks, links, slabs and reach lines');
  assert.deepEqual(renderFamilyMap(graph, { edges: graph.edges.filter((edge) => edge.link) }).replace(/data-map-edge="\d+"/, ''), renderFamilyMap(graph).replace(/data-map-edge="\d+"/, ''));
  assert.doesNotMatch(slim, / data-map-history-from="/);
  assert.match(full, /data-map-edge="1"/);
  assert.match(slim, /data-map-edge="0"/, 'edge indices follow the embedded list');
  assert.ok(slim.length < full.length);
});

test('the controller resolves renumbered edge indices against the trimmed payload', (t) => {
  withBrowserGlobals(t);
  const slim = renderBlockMap(mapDetailFixture(), { detail: 'map' });
  const dom = fakeDocument(slim);
  const search = { value: '' }, app = { value: 'all' };
  const controller = installFamilyMap(dom, payload(slim), { filters: () => ({ query: search.value, app: app.value }) });
  const path = dom.querySelector('[data-map-edge]');
  assert.equal(path.dataset.mapEdge, '0');
  dom.listeners.get('click')({ type: 'click', target: { closest: () => path } });
  const panel = dom.querySelector('#family-evidence');
  assert.equal(panel.hidden, false);
  assert.match(panel.innerHTML, /<strong>displays<\/strong><p>Main screen → First record<\/p><p><code>blocks\/screens\/main\.ts:1<\/code><\/p>/);
  assert.match(panel.innerHTML, /<pre><\/pre>/, 'missing evidence text renders empty, not "undefined"');
  assert.doesNotMatch(panel.innerHTML, /undefined/);
  app.value = 'cross'; controller.update();
  assert.equal(path.hasAttribute('hidden'), false, 'cross-app filter reads the trimmed edge');
  app.value = 'all'; search.value = 'nomatch'; controller.update();
  assert.equal(path.hasAttribute('hidden'), true);
  controller.dispose();
});

test('map.group treats empty strings as no value, so the empty fallback applies and 0 and false still group', async () => {
  const { attachFamilies } = await import('../src/families/graph.mjs');
  const families = [{ id: 'screen', floor: 0, configIndex: 0, config: { id: 'screen', manifests: 'blocks/*.ts' }, map: { group: { field: 'area', empty: 'internal', format: 'Area {value}' } } }, { id: 'tool', floor: 1, configIndex: 1, config: { id: 'tool', manifests: 'tools/*.ts' }, map: { group: { field: 'modes[]', join: ' + ' } } }];
  const manifests = [['screen', 'a', { area: '' }], ['screen', 'b', { area: 0 }], ['tool', 'c', { modes: [''] }], ['tool', 'd', { modes: ['', 'chat', false] }]].map(([family, id, extra]) => ({ family, id, path: `${family}/${id}.ts`, value: { id, family, name: id, description: id, ...extra } }));
  const graph = attachFamilies({ root: '.', nodes: [], edges: [], apps: [], summary: {} }, { load: { families, manifests, generators: [], diagnostics: [] }, project: { resolveImport() { return null; } } });
  assert.deepEqual(graph.nodes.map((node) => node.group), ['Area internal', 'Area 0', null, 'chat + false']);
});

const brickFixture = (count, groups) => {
  const graph = familyMapFixture();
  graph.families = [{ id: 'unit', floor: 0, title: 'Units' }];
  graph.nodes = Array.from({ length: count }, (_, index) => ({ id: `block:unit:u${String(index).padStart(2, '0')}`, family: 'unit', kind: 'block', floor: 0, name: `Unit ${index}`, description: '', path: `u${index}.ts`, app: 'web', ...(groups ? { group: groups[index % groups.length] } : {}) }));
  graph.edges = []; graph.history = [];
  return graph;
};
const bricksOf = (map) => [...map.matchAll(/<g class="family-node[^"]*"[^>]*data-map-id="([^"]+)"(?: data-family-block="[^"]*" data-map-app="[^"]*")?(?: data-map-group="([^"]*)")?[^>]*>.*?<use href="#bb-brick" x="([\d.-]+)" y="([\d.-]+)"\/>/g)].map(([, id, group, x, y]) => ({ id, group, x: Number(x), y: Number(y) }));
const slabWidth = (map) => { const xs = map.match(/<polygon class="slab family-surface" points="([^"]+)"/)[1].split(' ').map((pair) => Number(pair.split(',')[0])); return Math.round((Math.max(...xs) - Math.min(...xs)) * 10) / 10; };

test('blocks are isometric bricks on a tight near-square plate, drawn back to front', () => {
  const map = renderFamilyMap(brickFixture(10));
  assert.equal(map.match(/<g id="bb-brick">/g).length, 1, 'one shared brick shape');
  assert.match(map, /<g id="bb-brick"><polygon class="l" points="[^"]+"\/><polygon class="r" points="[^"]+"\/><polygon class="top family-block-slab" points="[^"]+"\/><ellipse class="stud base"[^>]*\/><ellipse class="stud cap"[^>]*\/><\/g>/);
  const bricks = bricksOf(map);
  assert.equal(bricks.length, 10);
  assert.ok(bricks.every((brick, index) => !index || brick.y >= bricks[index - 1].y), 'nearer bricks come later');
  // 10 blocks make a 4 × 3 grid: the plate spans cols + rows plus 0.7 cells of padding on each side, 17 units per cell.
  assert.equal(slabWidth(map), Math.round((4 + 3 + 2.8) * 17 * 10) / 10);
  assert.equal(slabWidth(renderFamilyMap(brickFixture(60))), Math.round((8 + 8 + 2.8) * 17 * 10) / 10);
  assert.match(map, /<polygon class="slab-edge" points=/);
  assert.match(map, /<path class="gridline" d="M/);
  assert.match(map, /<text class="brick-label" x="[\d.]+" y="[\d.]+">Unit 0<\/text>/);
  assert.doesNotMatch(map, /class="family-floor[^"]* few"/, 'labels wait for hover, selection or zoom on a full floor');
  assert.match(renderFamilyMap(brickFixture(2)), /class="family-floor fam-0 few"/, 'a small floor shows its names');
});

test('grouped floors pack each group as its own box, one empty cell from the next', () => {
  const map = renderFamilyMap(brickFixture(23, ['read', 'write', 'admin', null]));
  const bricks = bricksOf(map);
  assert.equal(bricks.length, 23);
  const cell = (a, b) => { const across = (b.x - a.x) / 17, down = (b.y - a.y) / 8.5; return [Math.round((across + down) / 2), Math.round((down - across) / 2)]; };
  for (const a of bricks) for (const b of bricks) {
    if (a.group === b.group) continue;
    const [dx, dy] = cell(a, b);
    assert.ok(Math.max(Math.abs(dx), Math.abs(dy)) >= 2, `${a.id} and ${b.id} sit in different groups but touch`);
  }
  assert.deepEqual([...map.matchAll(/<text class="group-label"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]), ['admin · 6', 'read · 6', 'write · 6', 'Ungrouped · 5']);
  assert.equal(renderFamilyMap(brickFixture(23, ['read', 'write', 'admin', null])), map, 'packing is deterministic');
});

test('floor colours follow floor order and family tokens override them through the stylesheet only', async (t) => {
  const graph = familyMapFixture();
  const map = renderFamilyMap(graph);
  assert.match(map, /<g class="family-floor fam-0 few" data-family="record" data-floor="0">/);
  assert.match(map, /<g class="family-floor fam-1 few" data-family="screen" data-floor="1">/);
  const colours = [...FAMILY_MAP_CSS.matchAll(/\.fam-\d+\{--fam:(#[0-9a-f]{6})\}/g)].map((match) => match[1]);
  assert.ok(new Set(colours).size >= 8, 'at least eight distinct floor colours');
  assert.match(map, /<g class="floor-tag"><title>Record inventory · Tracked records<\/title><path d="M[^"]+"\/><text class="floor-title" x="\d+" y="\d+">Record inventory<\/text><text class="floor-count"[^>]*>2<\/text><\/g>/);
  graph.mapStyle = { css: '', tokens: { 'family-record': '#123456', 'link-displays': '#654321' } };
  const html = renderBlockMap(graph);
  assert.match(html, /:root\{--bb-family-record:#123456;--bb-link-displays:#654321\}\n\.family-floor\[data-family="record"\]\{--fam:var\(--bb-family-record\)\}/);
  assert.doesNotMatch(html, /\sstyle=/);
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-family-token-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checked = await prepareMapStyle(root, { map: { tokens: { 'family-record': 'red;x:y', 'family-Bad': '#fff' } } });
  assert.deepEqual(checked.tokens, {});
  assert.equal(checked.diagnostics.length, 2);
  assert.doesNotMatch(renderMapStyle({ tokens: { 'family-"]{}x': '#fff' } }), /data-family/);
});

test('conduits count drawn links per floor pair and kind, beside the tower', () => {
  const graph = familyMapFixture();
  graph.edges.push(
    { from: 'block:screen:main', to: 'block:record:second', kind: 'displays', link: true, evidence: {} },
    { from: 'block:record:first', to: 'block:record:second', kind: 'related-to', link: true, evidence: {} },
    { from: 'block:record:first', to: 'file:src/main.ts', kind: 'implemented-by' },
  );
  const map = renderFamilyMap(graph);
  const conduits = [...map.matchAll(/<g class="conduit-pair" data-kind="([^"]+)"><title>[^<]*<\/title><path class="conduit" stroke="([^"]+)" d="[^"]+"\/><text class="conduit-label mono"[^>]*transform="rotate\(-90 [^"]+\)">([^<]+)<\/text><\/g>/g)].map((match) => [match[1], match[2], match[3]]);
  assert.deepEqual(conduits, [['related-to', `var(--bb-link-related-to,${linkColor('related-to')})`, '1 related-to'], ['displays', `var(--bb-link-displays,${linkColor('displays')})`, '2 displays']]);
  assert.match(map, /<title>2 displays links: Screen inventory → Record inventory<\/title>/);
  assert.equal([...map.matchAll(/class="family-link[^"]*"[^>]*hidden>/g)].length, 3, 'individual links start hidden');
});

test('selecting a brick lights it, its linked bricks and links and dims the rest until cleared', (t) => {
  withBrowserGlobals(t);
  const graph = parityFixture();
  const dom = fakeDocument(renderFamilyMap(graph));
  const controller = installFamilyMap(dom, graph);
  const scene = dom.querySelector('.family-scene'), path = dom.querySelector('[data-map-edge]');
  const brick = (id) => dom.querySelector(`[data-map-id="${id}"]`);
  assert.equal(path.hasAttribute('hidden'), true, 'no selection, no individual links');
  dom.listeners.get('click')({ type: 'click', target: { closest: () => brick('block:record:first') } });
  assert.ok(scene.classes.has('dim'));
  assert.ok(brick('block:record:first').classes.has('lit') && brick('block:record:first').classes.has('sel'));
  assert.ok(brick('block:screen:main').classes.has('lit'), 'the linked brick lights');
  assert.ok(!brick('block:record:second').classes.has('lit'));
  assert.equal(path.hasAttribute('hidden'), false);
  assert.ok(path.classes.has('lit'));
  assert.ok(dom.querySelector('[data-map-reach]').classes.has('lit'), 'the code folder that reaches it lights');
  assert.equal(dom.querySelectorAll('[data-reach-block="block:record:first"]').filter((line) => !line.hasAttribute('hidden')).length, 1);
  assert.equal(dom.querySelector('#family-evidence').hidden, false, 'the details panel still opens');
  dom.listeners.get('click')({ type: 'click', target: { closest: (selector) => selector === '.family-scene' ? scene : null } });
  assert.ok(!scene.classes.has('dim'));
  assert.equal(dom.querySelectorAll('.lit').length, 0);
  assert.equal(path.hasAttribute('hidden'), true);
  dom.listeners.get('click')({ type: 'click', target: { closest: () => brick('block:screen:main') } });
  dom.listeners.get('keydown')({ type: 'keydown', key: 'Escape', target: { closest: () => null } });
  assert.ok(!scene.classes.has('dim'), 'Escape clears the selection');
  controller.dispose();
});

test('zoom buttons move the viewBox, show labels when close and fit back; play steps through history', (t) => {
  withBrowserGlobals(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const graph = parityFixture();
  const dom = fakeDocument(renderFamilyMap(graph));
  const controller = installFamilyMap(dom, graph);
  const scene = dom.querySelector('.family-scene'), fit = scene.getAttribute('viewBox');
  const press = (name) => dom.listeners.get('click')({ type: 'click', target: { closest: () => dom.querySelector(`[data-map-zoom="${name}"]`) } });
  press('in');
  const [, , width] = scene.getAttribute('viewBox').split(' ').map(Number);
  assert.ok(width < Number(fit.split(' ')[2]));
  assert.ok(!scene.classes.has('lod'));
  press('in'); press('in');
  assert.ok(scene.classes.has('lod'), 'labels show once zoomed in two times or more');
  press('fit');
  assert.equal(scene.getAttribute('viewBox'), fit);
  assert.ok(!scene.classes.has('lod'));
  for (let index = 0; index < 20; index++) press('out');
  assert.equal(scene.getAttribute('viewBox'), fit, 'never zooms out past the whole map');
  const slider = dom.querySelector('#family-history'), play = dom.querySelector('#family-history-play'), ghost = dom.querySelector('[data-map-ghost]');
  play.listeners.get('click')();
  assert.equal(slider.value, '0');
  assert.equal(play.textContent, 'Pause');
  assert.equal(ghost.hasAttribute('hidden'), false);
  t.mock.timers.tick(800);
  assert.equal(slider.value, '1');
  t.mock.timers.tick(1600);
  assert.equal(slider.value, '3');
  t.mock.timers.tick(800);
  assert.equal(play.textContent, 'Play', 'stops at the current state');
  assert.equal(ghost.hasAttribute('hidden'), true);
  controller.dispose();
  assert.equal(play.listeners.size, 0);
  assert.equal(scene.listeners.size, 0);
});

test('the ordinary-code rail lists folders by reach, then size, right of the tower', () => {
  const map = renderFamilyMap(parityFixture());
  const rows = [...map.matchAll(/<g class="ordinary-code[^"]*"[^>]*?data-map-app="([^"]*)"[^>]*>[\s\S]*?<text class="rail-name"[^>]*>([^<]+)<\/text><path class="ordinary-slab" d="M([\d.]+) [\d.]+h([\d.-]+)/g)].map((match) => [match[2], Number(match[4])]);
  assert.deepEqual(rows.map(([name]) => name), ['web · src', 'admin · lib']);
  assert.match(map, /<text class="floor-title" x="\d+" y="\d+">Ordinary code<\/text><text class="rail-sub mono"[^>]*>Not blocks yet · source files by folder<\/text>/);
  assert.match(map, /<circle class="rail-port"/, 'reaching rows get a port for their reach lines');
});
