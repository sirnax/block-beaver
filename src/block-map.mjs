import { createHash } from 'node:crypto';
import { scanRepository } from './scanner.mjs';
import { attachLocalRegistry, attachTeacakeRegistry } from './adapter.mjs';
import { readProjectFile, writeProjectFiles } from './project-files.mjs';

const htmlPath = '.blocks/view/index.html';
const graphPath = '.blocks/view/graph.json';
const marker = '<!-- block-beaver:view -->';
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function graphRevision(graph) {
  return createHash('sha256').update(JSON.stringify({ ...graph, root: '.', scannedAt: undefined })).digest('hex');
}

export function renderBlockMap(graph, { live = false } = {}) {
  const revision = graphRevision(graph);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const blocks = graph.nodes.filter((node) => node.kind === 'block');
  const files = graph.nodes.filter((node) => node.kind === 'file');
  const outgoing = new Map();
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }
  const cards = blocks.map((block) => {
    const links = outgoing.get(block.id) || [];
    const implementation = links.filter((edge) => edge.kind === 'implemented-by');
    const dependencies = links.filter((edge) => edge.kind !== 'implemented-by');
    return `<article class="block item" data-search="${escape([block.name, block.description, block.id, ...implementation.map((edge) => nodes.get(edge.to)?.path)].join(' ').toLowerCase())}"><p class="eyebrow">${escape(block.family || 'block')}</p><h3>${escape(block.name)}</h3><p>${escape(block.description)}</p><small>${escape(block.id)}</small><h4>Implementation</h4><ul>${implementation.map((edge) => `<li>${escape(nodes.get(edge.to)?.path || edge.to)}</li>`).join('') || '<li>No scanned implementation links.</li>'}</ul><h4>Connections</h4><ul>${dependencies.map((edge) => `<li>${escape(edge.kind)} → ${escape(nodes.get(edge.to)?.name || edge.to)}<small>${escape(edge.evidence?.file)}</small></li>`).join('') || '<li>No declared connections in this graph.</li>'}</ul></article>`;
  }).join('');
  const source = files.map((file) => `<li class="file item" data-search="${escape(file.path.toLowerCase())}"><code>${escape(file.path)}</code><span>${Number(file.lines) || 0} lines</span></li>`).join('');
  return `<!doctype html>
${marker}
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project block map · Block Beaver</title>
<style>
:root{color-scheme:light;font-family:system-ui,sans-serif;color:#203c46;background:#f5f3ed}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:48px 24px}header{border-bottom:1px solid #cbd4d3;padding-bottom:28px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.15em;color:#517d7f}h1{font-size:clamp(32px,5vw,54px);letter-spacing:-.04em;margin:12px 0}h2{margin-top:34px}p{line-height:1.6}small{display:block;color:#527078;overflow-wrap:anywhere}.stats{display:flex;gap:24px;flex-wrap:wrap;margin:24px 0}.stats strong{font-size:25px;display:block}.tools{margin:24px 0}input{width:100%;padding:14px;border:1px solid #b7c9ca;background:white;border-radius:8px;font:inherit}label{display:block;margin-bottom:8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}.block{padding:24px;background:white;border:1px solid #ced9d8;border-radius:12px;border-top:4px solid #357b78;overflow-wrap:anywhere}h3{font-size:24px;margin:8px 0}h4{font-size:13px;margin-bottom:8px}ul{padding-left:20px;line-height:1.7}.files{list-style:none;padding:0;border-top:1px solid #ccd6d4}.file{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #dce2de;overflow-wrap:anywhere}.file span{white-space:nowrap;color:#61777c;font-size:13px}code{font-size:13px}.empty{padding:28px;border:1px dashed #8daaa8;border-radius:10px}[hidden]{display:none!important}footer{margin-top:36px;padding-top:18px;border-top:1px solid #cbd4d3;font-size:13px;color:#567176}
</style></head><body><main>
<header><p class="eyebrow">Block Beaver / project workspace</p><h1>Software, in blocks.</h1><p>Feature boundaries and connections from this checkout’s source and declared registry.</p><small id="status">${live ? 'Live updates enabled' : 'Generated snapshot · run block-beaver start for live updates'}</small></header>
<div class="stats"><div><strong>${blocks.length}</strong>declared blocks</div><div><strong>${files.length}</strong>source files</div><div><strong>${graph.edges.length}</strong>relationships</div></div>
<div class="tools"><label for="search">Find a block or file</label><input id="search" type="search" placeholder="Search names, descriptions, and paths"></div>
<h2>Declared blocks</h2><div class="grid">${cards || '<p class="empty">No declared blocks yet. The source files below are mapped; adopt a feature through the block workflow to declare its boundary.</p>'}</div>
<h2>Source files</h2><ul class="files">${source || '<li>No supported source files found.</li>'}</ul>
<footer>Generated from source and manifests. This map does not certify checks or approval. ${escape(graph.adapter ? `Registry: ${graph.adapter}.` : 'Registry: local manifests.')}</footer>
</main><script>
const search = document.querySelector('#search');
search.value = new URL(location.href).searchParams.get('q') || '';
function filter() { for (const item of document.querySelectorAll('.item')) item.hidden = !item.dataset.search.includes(search.value.toLowerCase()); }
search.addEventListener('input', filter); filter();
${live ? `let polling = false;
setInterval(async () => {
  if (polling || document.hidden) return;
  polling = true;
  try {
    const response = await fetch('/_revision', { cache: 'no-store' });
    if (!response.ok) throw new Error('Refresh failed');
    const state = await response.json();
    document.querySelector('#status').textContent = state.error ? 'Refresh paused: ' + state.error : 'Live updates enabled';
    if (state.revision !== '${revision}') { const url = new URL(location.href); search.value ? url.searchParams.set('q', search.value) : url.searchParams.delete('q'); location.replace(url.href); }
  } catch { document.querySelector('#status').textContent = 'Live session disconnected; restart block-beaver start to reconnect.'; }
  finally { polling = false; }
}, 1000);` : ''}
</script></body></html>\n`;
}

export async function updateProject(root) {
  const scanned = await attachTeacakeRegistry(await attachLocalRegistry(await scanRepository(root)));
  const graph = { ...scanned, root: '.', generator: 'block-beaver' };
  const beforeGraph = await readProjectFile(root, graphPath);
  const beforeHtml = await readProjectFile(root, htmlPath);
  let previous;
  if (beforeGraph !== null) {
    try { previous = JSON.parse(beforeGraph); } catch { throw new Error(`Unrecognized generated graph at ${graphPath}; existing file was preserved.`); }
    if (previous.generator !== 'block-beaver') throw new Error(`Existing file conflicts with generated graph: ${graphPath}`);
  }
  if (beforeHtml !== null && !beforeHtml.startsWith(`<!doctype html>\n${marker}`)) throw new Error(`Existing file conflicts with generated view: ${htmlPath}`);
  const revision = graphRevision(graph);
  if (previous && graphRevision(previous) === revision) graph.scannedAt = previous.scannedAt;
  const changed = await writeProjectFiles(root, [
    { path: graphPath, before: beforeGraph, content: JSON.stringify(graph, null, 2) + '\n' },
    { path: htmlPath, before: beforeHtml, content: renderBlockMap(graph) },
  ]);
  return { graph, revision, changed, html: htmlPath, json: graphPath };
}
