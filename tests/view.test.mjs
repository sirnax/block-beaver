import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareView, VIEW_NONCE_PLACEHOLDER, VIEW_HOST_HEADER_SLOT } from '../src/view.mjs';

test('prepareView fills nonce attributes and host slot without altering surrounding HTML', () => {
  const html = `<header>${VIEW_HOST_HEADER_SLOT}</header><style nonce="${VIEW_NONCE_PLACEHOLDER}">body{}</style><script nonce="${VIEW_NONCE_PLACEHOLDER}">const text = 'unchanged';</script>`;
  assert.equal(prepareView(html, { nonce: 'a&"<>', headerHtml: '<nav>$& Host</nav>' }), '<header><nav>$& Host</nav></header><style nonce="a&amp;&quot;&lt;&gt;">body{}</style><script nonce="a&amp;&quot;&lt;&gt;">const text = \'unchanged\';</script>');
});

test('prepareView removes optional placeholders and preserves content outside slots', () => {
  const html = `<header>${VIEW_HOST_HEADER_SLOT}</header><script nonce="${VIEW_NONCE_PLACEHOLDER}">const word = '${VIEW_NONCE_PLACEHOLDER}';</script>`;
  assert.equal(prepareView(html), `<header></header><script>const word = '${VIEW_NONCE_PLACEHOLDER}';</script>`);
  assert.equal(prepareView('<p>owner text</p>'), '<p>owner text</p>');
  assert.equal(prepareView(html, { nonce: 'request-nonce' }), `<header></header><script nonce="request-nonce">const word = '${VIEW_NONCE_PLACEHOLDER}';</script>`);
});

test('prepareView fills the nonce on every skin sheet of a generated family map', async () => {
  const { renderBlockMap } = await import('../src/block-map.mjs');
  const graph = { root: '.', apps: [], families: [{ id: 'record', floor: 0 }], nodes: [{ id: 'block:record:a', kind: 'block', family: 'record', name: 'A' }], edges: [], mapStyle: { css: '', tokens: {}, skins: [{ id: 'paper', css: '', tokens: { 'map-background': '#fff' } }, { id: 'night', css: '', tokens: { 'map-background': '#000' } }] } };
  const prepared = prepareView(renderBlockMap(graph), { nonce: 'n1' });
  assert.doesNotMatch(prepared, new RegExp(` nonce="${VIEW_NONCE_PLACEHOLDER}"`));
  const tags = [...prepared.matchAll(/<(script|style)\b([^>]*)>/gi)];
  assert.equal(tags.filter((tag) => /data-map-skin/.test(tag[2])).length, 2);
  for (const tag of tags) assert.match(tag[2], /nonce="n1"/);
});
