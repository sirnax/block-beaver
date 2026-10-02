import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBlockMap, graphRevision } from '../src/block-map.mjs';
import { prepareView } from '../src/view.mjs';

const fixture = () => ({
  schemaVersion: 2, root: '/fixture', scannedAt: '2026-10-01',
  apps: [
    { id: 'web', root: '.', health: { status: 'healthy', unresolvedImports: 0, unreachableFiles: 0, tsconfigErrors: [] } },
    { id: 'admin', root: 'apps/admin', health: { status: 'error', unresolvedImports: 1, unreachableFiles: 1, tsconfigErrors: ['Invalid tsconfig'] } },
  ],
  nodes: [
    { id: 'file:src/shared.ts', kind: 'file', path: 'src/shared.ts', app: 'web', usedBy: ['web', 'admin'], lines: 3 },
    { id: 'file:apps/admin/lib/panel.ts', kind: 'file', path: 'apps/admin/lib/panel.ts', app: 'admin', usedBy: ['admin'], lines: 4 },
    { id: 'file:apps/admin/lib/orphan.ts', kind: 'file', path: 'apps/admin/lib/orphan.ts', app: 'admin', usedBy: [], lines: 1 },
    { id: 'file:scripts/tool.mjs', kind: 'file', path: 'scripts/tool.mjs', app: null, usedBy: [], lines: 2 },
    { id: 'block:shared', kind: 'block', name: 'Shared component', description: 'Reusable component' },
  ],
  edges: [
    { from: 'file:apps/admin/lib/panel.ts', to: 'file:src/shared.ts', kind: 'imports', crossApp: true, evidence: { file: 'apps/admin/lib/panel.ts', line: 2, text: 'import shared from "shared"' } },
    { from: 'block:shared', to: 'file:src/shared.ts', kind: 'implemented-by' },
  ],
  unreachableFiles: ['apps/admin/lib/orphan.ts'],
  resolutionReport: [{ app: 'admin', file: 'apps/admin/lib/panel.ts', line: 3, specifier: 'missing', message: 'Module not found' }],
});

test('generated view groups apps and relative folders with ownership and health evidence', () => {
  const html = renderBlockMap(fixture());
  assert.match(html, /data-app="web"/);
  assert.match(html, /data-app="admin"/);
  assert.match(html, /<h2>Outside apps<\/h2>/);
  assert.match(html, /<h4>lib<\/h4>/);
  assert.match(html, /<code>lib\/panel.ts<\/code>/);
  assert.match(html, /web · admin|admin · web/);
  assert.match(html, /3 health issues/);
  assert.match(html, /Invalid tsconfig/);
  assert.match(html, /Module not found/);
  assert.match(html, /apps\/admin\/lib\/panel.ts:2/);
  assert.match(html, /cross-edge/);
  assert.match(html, /Only cross-app links/);
  assert.match(html, /Shared component/);
});

test('snapshots are self-contained, CSP-ready, deterministic and escaped', () => {
  const graph = fixture();
  graph.nodes[4].name = '<script>alert("x")</script>';
  const html = renderBlockMap(graph);
  assert.equal(html, renderBlockMap(graph));
  assert.doesNotMatch(html, /(?:https?:)?\/\/|\son\w+=|javascript:|\beval\s*\(|\sstyle=/i);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  for (const tag of html.matchAll(/<(script|style)\b([^>]*)>/g)) assert.match(tag[2], /nonce="__BLOCK_BEAVER_NONCE__"/);
  const prepared = prepareView(html, { nonce: 'request', headerHtml: '<nav>Product home</nav>' });
  assert.doesNotMatch(prepared, /__BLOCK_BEAVER_NONCE__|<!--block-beaver:host-header-->/);
  assert.match(prepared, /<nav>Product home<\/nav>/);
  assert.equal(graphRevision(graph), graphRevision({ ...graph, root: '/different', scannedAt: 'later' }));
});

test('old snapshots render all source files in a single project area', () => {
  const graph = fixture();
  delete graph.apps;
  for (const node of graph.nodes) { delete node.app; delete node.usedBy; }
  const html = renderBlockMap(graph);
  assert.match(html, /<h2>Project<\/h2>/);
  assert.match(html, /scripts\/tool.mjs/);
});

test('projects without families ignore map parity data and skins entirely', () => {
  const plain = renderBlockMap(fixture());
  const extended = renderBlockMap({ ...fixture(), codeReach: [], unused: ['block:shared'], mapStyle: { css: '', tokens: {}, skins: [{ id: 'paper', css: 'p{}', tokens: {} }, { id: 'night', css: 'n{}', tokens: {} }] } });
  assert.equal(extended, plain);
  assert.doesNotMatch(plain, /family-map|data-map-skin|family-skin/);
});
