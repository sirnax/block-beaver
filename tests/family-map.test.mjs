import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { renderBlockMap } from '../src/block-map.mjs';
import { renderFamilyMap, linkColor, mapStorageKey, renderMapStyle, installFamilyMap } from '../src/families/map-render.mjs';
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
  assert.match(html, /lib · 1 files/);
  assert.match(html, /block-beaver:fixture-repository:family-history/);
  assert.match(html, /id="family-history"[^>]*max="2"/);
  assert.equal(html, renderBlockMap(graph));
  for (const tag of html.matchAll(/<(script|style)\b([^>]*)>/g)) assert.match(tag[2], /nonce="__BLOCK_BEAVER_NONCE__"/);
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
