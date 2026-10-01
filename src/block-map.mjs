import { FAMILY_MAP_CSS, renderFamilyMap, renderMapStyle, installFamilyMap } from './families/map-render.mjs';
import { createHash } from 'node:crypto';
import { scanRepository } from './scanner.mjs';
import { attachProjectRegistry } from './adapter.mjs';
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
  const apps = (graph.apps || []).map((app) => ({ ...app }));
  // Older graph snapshots have no ownership metadata and remain a single area.
  const legacy = !apps.length && !files.some((file) => file.app != null);
  if (legacy) apps.push({ id: 'project', root: '.', name: 'Project', health: {} });
  const home = (node) => node?.app ?? (legacy ? 'project' : '');
  const ownership = new Map();
  const usedBy = new Map();
  for (const node of graph.nodes) {
    const implementation = (outgoing.get(node.id) || []).filter((edge) => edge.kind === 'implemented-by').map((edge) => nodes.get(edge.to)).filter(Boolean);
    const owners = [...new Set(implementation.map(home))];
    ownership.set(node.id, node.app ?? (node.kind === 'block' ? owners[0] : home(node)) ?? '');
    usedBy.set(node.id, [...new Set(node.usedBy || implementation.flatMap((file) => file.usedBy || []))].sort());
  }
  for (const id of new Set([...ownership.values()].filter(Boolean))) {
    if (!apps.some((app) => app.id === id)) apps.push({ id, root: '.', health: {} });
  }
  const chip = (node) => (usedBy.get(node.id) || []).length > 1 ? `<span class="chip" title="Used by these apps">${escape(usedBy.get(node.id).join(' · '))}</span>` : '';
  const crossApp = (edge) => edge.crossApp || ownership.get(edge.from) !== ownership.get(edge.to);
  const evidence = (edge) => `<details class="evidence"><summary>${escape(edge.kind)}${crossApp(edge) ? ' <span class="chip">cross-app</span>' : ''} → ${escape(nodes.get(edge.to)?.name || nodes.get(edge.to)?.path || edge.to)}</summary><p><code>${escape(edge.evidence?.file || nodes.get(edge.from)?.path || 'No source file recorded')}${edge.evidence?.line ? `:${Number(edge.evidence.line)}` : ''}</code></p>${edge.evidence?.text ? `<pre>${escape(edge.evidence.text)}</pre>` : ''}</details>`;
  const card = (block) => {
    const links = outgoing.get(block.id) || [];
    const implementation = links.filter((edge) => edge.kind === 'implemented-by');
    const dependencies = links.filter((edge) => edge.kind !== 'implemented-by');
    return `<article class="block item" data-family-block="${escape(block.id)}" data-map-app="${escape(ownership.get(block.id))}" data-search="${escape([block.name, block.description, block.id, ...implementation.map((edge) => nodes.get(edge.to)?.path)].join(' ').toLowerCase())}"><p class="eyebrow">${escape(block.family || 'block')}</p><h3>${escape(block.name)}</h3>${chip(block)}<p>${escape(block.description)}</p><small>${escape(block.id)}</small><h4>Implementation</h4><ul>${implementation.map((edge) => `<li>${escape(nodes.get(edge.to)?.path || edge.to)}</li>`).join('') || '<li>No scanned implementation links.</li>'}</ul><h4>Connections</h4>${dependencies.map(evidence).join('') || '<p>No declared connections in this graph.</p>'}</article>`;
  };
  const relativePath = (path, root) => root && root !== '.' && path.startsWith(root.replace(/\/$/, '') + '/') ? path.slice(root.replace(/\/$/, '').length + 1) : path;
  const report = graph.resolutionReport || {};
  const unresolved = Array.isArray(report) ? report : report.unresolvedImports || report.unresolved || [];
  const errors = Array.isArray(report) ? graph.diagnostics || [] : report.tsconfigErrors || report.errors || graph.diagnostics || [];
  const areas = [...apps, { id: '', name: 'Outside apps', root: '.', health: {} }];
  const areaHtml = areas.map((app, index) => {
    const areaFiles = files.filter((file) => ownership.get(file.id) === app.id);
    const areaBlocks = blocks.filter((block) => ownership.get(block.id) === app.id);
    if (!app.id && !areaFiles.length && !areaBlocks.length) return '';
    const issues = unresolved.filter((entry) => (entry.app ?? '') === app.id);
    const health = typeof app.health === 'object' && app.health ? app.health : {};
    const configErrors = Array.isArray(health.tsconfigErrors) ? health.tsconfigErrors : errors.filter((entry) => (entry.app ?? entry.appId ?? '') === app.id);
    const unreachable = areaFiles.filter((file) => file.unreachable === true || (graph.unreachableFiles || []).includes(file.path) || (Array.isArray(file.usedBy) && file.usedBy.length === 0));
    const unresolvedCount = issues.length || Number(health.unresolvedImports || health.unresolved) || 0;
    const missingAssetCount = issues.length ? issues.filter((entry) => entry.category === 'asset').length : Number(health.missingAssets) || 0;
    const errorCount = configErrors.length || Number(Array.isArray(health.tsconfigErrors) ? health.tsconfigErrors.length : health.tsconfigErrors || health.errors) || (app.health === 'error' || health.status === 'error' ? 1 : 0);
    const unreachableCount = unreachable.length || Number(health.unreachableFiles || health.unreachable) || 0;
    const problemCount = unresolvedCount + errorCount + unreachableCount;
    const folders = new Map();
    for (const file of areaFiles) {
      const path = relativePath(file.path, app.root);
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push({ file, path });
    }
    return `<section class="app-area" data-app="${escape(app.id)}"><div class="area-heading"><div><p class="eyebrow">${escape(app.root || '.')}</p><h2>${escape(app.name || app.id)}</h2><small>${areaFiles.length} files · ${areaBlocks.length} blocks</small></div><button class="health ${problemCount ? 'warning' : ''}" type="button" data-report="report-${index}">${problemCount ? `${problemCount} health issues` : 'Healthy'}</button></div>
<details class="resolution-report" id="report-${index}"><summary>Resolution report · ${escape(app.name || app.id)}</summary><p>${unresolvedCount} unresolved imports${missingAssetCount ? ` (${missingAssetCount} missing ${missingAssetCount === 1 ? 'asset' : 'assets'})` : ''} · ${unreachableCount} unreachable files · ${errorCount} tsconfig errors</p><ul>${issues.map((entry) => `<li><code>${escape(entry.file)}:${Number(entry.line) || 1}</code> [${escape(entry.category || 'module')}] ${escape(entry.specifier || entry.import || '')} ${escape(entry.message || entry.reason || 'Unresolved import')}</li>`).join('')}${configErrors.map((entry) => `<li>${escape(entry.file || app.tsconfig)}: ${escape(entry.message || entry)}</li>`).join('')}${unreachable.map((file) => `<li><code>${escape(file.path)}</code> — unreachable from app entry points</li>`).join('')}</ul></details>
<h3 class="section-title">Declared blocks</h3><div class="grid">${areaBlocks.map(card).join('') || '<p class="empty">No declared blocks yet.</p>'}</div><h3 class="section-title">Source files</h3>${[...folders].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([folder, entries]) => `<section class="folder"><h4>${escape(folder)}</h4><ul class="files">${entries.map(({ file, path }) => `<li class="file item" data-search="${escape([file.path, file.name].join(' ').toLowerCase())}"><div><code>${escape(path)}</code> ${chip(file)}</div><span>${Number(file.lines) || 0} lines</span></li>`).join('')}</ul></section>`).join('') || '<p class="empty">No supported source files found.</p>'}</section>`;
  }).join('');
  const connections = graph.edges.filter((edge) => crossApp(edge));
  const familyData = graph.families?.length ? JSON.stringify({ nodes: graph.nodes.map(({ id, kind, name, path, description }) => ({ id, kind, name, path, description })), edges: graph.edges.map(({ from, to, kind, crossApp, evidence }) => ({ from, to, kind, crossApp, evidence })), history: graph.history || [] }).replaceAll('<', '\\u003c') : '';
  const familyMap = renderFamilyMap(graph);
  return `<!doctype html>
${marker}
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project block map · Block Beaver</title>
<style nonce="__BLOCK_BEAVER_NONCE__">
:root{color-scheme:light;font-family:system-ui,sans-serif;color:#203c46;background:#f5f3ed}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:48px 24px}header{border-bottom:1px solid #cbd4d3;padding-bottom:28px}.host-header:empty{display:none}.host-header{padding-bottom:24px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.15em;color:#517d7f}h1{font-size:clamp(32px,5vw,54px);letter-spacing:-.04em;margin:12px 0}h2{margin:8px 0}p{line-height:1.6}small{display:block;color:#527078;overflow-wrap:anywhere}.stats{display:flex;gap:24px;flex-wrap:wrap;margin:24px 0}.stats strong{font-size:25px;display:block}.tools{display:flex;gap:16px;flex-wrap:wrap;margin:24px 0}.search-field{flex:1;min-width:200px}input,select{width:100%;padding:14px;border:1px solid #b7c9ca;background:white;border-radius:8px;font:inherit}label{display:block;margin-bottom:8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}.block{padding:24px;background:white;border:1px solid #ced9d8;border-radius:12px;border-top:4px solid #357b78;overflow-wrap:anywhere}h3{font-size:24px;margin:8px 0}h4{font-size:13px;margin-bottom:8px}ul{padding-left:20px;line-height:1.7}.files{list-style:none;padding:0;border-top:1px solid #ccd6d4}.file{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #dce2de;overflow-wrap:anywhere}.file>span{white-space:nowrap;color:#61777c;font-size:13px}code{font-size:13px}.empty{padding:20px;border:1px dashed #8daaa8;border-radius:10px}[hidden]{display:none!important}footer{margin-top:36px;padding-top:18px;border-top:1px solid #cbd4d3;font-size:13px;color:#567176}.app-area{margin-top:36px;padding-top:24px;border-top:1px solid #cbd4d3}.area-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.health{font:inherit;font-size:13px;border:1px solid #a4c3b7;background:#eaf3eb;color:#28503d;padding:8px 12px;border-radius:20px;cursor:pointer}.health.warning{border-color:#d5b783;background:#fff2db;color:#785a25}.chip{display:inline-block;background:#e6efee;color:#315c59;font-size:11px;border-radius:12px;padding:3px 8px}.section-title{font-size:18px;margin-top:24px}.evidence{padding:8px 0;overflow-wrap:anywhere}.evidence summary{cursor:pointer}.evidence pre{white-space:pre-wrap}.cross-edge{border-left:3px dashed #8e629c;padding:8px 16px;margin:12px 0}.resolution-report{margin-top:16px;padding:16px;background:#fff;border:1px solid #ced9d8;border-radius:8px}.resolution-report summary{cursor:pointer}.folder h4{color:#517d7f}
${familyMap ? FAMILY_MAP_CSS : ''}
</style>${familyMap ? `<style nonce="__BLOCK_BEAVER_NONCE__">${renderMapStyle(graph.mapStyle)}</style>` : ''}</head><body><main>
<header><div class="host-header"><!--block-beaver:host-header--></div><p class="eyebrow">Block Beaver / project workspace</p><h1>Software, in blocks.</h1><p>Feature boundaries and connections from this checkout’s source and declared registry.</p><small id="status">${live ? 'Live updates enabled' : 'Generated snapshot · run block-beaver start for live updates'}</small></header>
<div class="stats"><div><strong>${blocks.length}</strong>declared blocks</div><div><strong>${files.length}</strong>source files</div><div><strong>${graph.edges.length}</strong>relationships</div></div>
<div class="tools"><div class="search-field"><label for="search">Find a block or file</label><input id="search" type="search" placeholder="Search names, descriptions, and paths"></div><div><label for="app-filter">App filter</label><select id="app-filter"><option value="all">All apps</option>${apps.map((app) => `<option value="app:${escape(app.id)}">${escape(app.name || app.id)}</option>`).join('')}<option value="app:">Outside apps</option><option value="cross">Only cross-app links</option></select></div></div>
${familyMap}
${areaHtml}
<section id="cross-app-links"><h2>Cross-app links</h2>${connections.map((edge) => `<article class="cross-edge item" data-map-history-from="${escape(edge.from)}" data-map-history-to="${escape(edge.to)}" data-search="${escape([nodes.get(edge.from)?.path, nodes.get(edge.to)?.path, edge.kind, edge.evidence?.text].join(' ').toLowerCase())}"><small>${escape(ownership.get(edge.from) || 'Outside apps')} → ${escape(ownership.get(edge.to) || 'Outside apps')}</small><p><code>${escape(nodes.get(edge.from)?.path || edge.from)}</code></p>${evidence(edge)}</article>`).join('') || '<p class="empty">No cross-app links.</p>'}</section>
<footer>Generated from source and manifests. This map does not certify checks or approval. ${escape(graph.adapter ? `Registry: ${graph.adapter}.` : 'Registry: local manifests.')}</footer>
</main>${familyMap ? `<script type="application/json" id="family-map-data" nonce="__BLOCK_BEAVER_NONCE__">${familyData}</script>` : ''}<script nonce="__BLOCK_BEAVER_NONCE__">
const search = document.querySelector('#search');
const appFilter = document.querySelector('#app-filter');
const params = new URL(location.href).searchParams;
${familyMap ? `const familyController = (${installFamilyMap.toString()})(document, JSON.parse(document.querySelector('#family-map-data').textContent), { filters: () => ({ query: search.value, app: appFilter.value }) });` : ''}
search.value = params.get('q') || '';
if ([...appFilter.options].some(option => option.value === params.get('app'))) appFilter.value = params.get('app');
function filter() {
  for (const item of document.querySelectorAll('.item')) item.hidden = !item.dataset.search.includes(search.value.toLowerCase());
  for (const area of document.querySelectorAll('.app-area')) area.hidden = appFilter.value === 'cross' || (appFilter.value !== 'all' && appFilter.value !== 'app:' + area.dataset.app);
  document.querySelector('#cross-app-links').hidden = appFilter.value !== 'all' && appFilter.value !== 'cross';
  ${familyMap ? 'familyController.update();' : ''}
}
search.addEventListener('input', filter); appFilter.addEventListener('change', filter); filter();
for (const button of document.querySelectorAll('[data-report]')) button.addEventListener('click', () => { const report = document.getElementById(button.dataset.report); report.open = true; report.querySelector('summary').focus(); });
${live ? `let polling = false;
setInterval(async () => {
  if (polling || document.hidden) return;
  polling = true;
  try {
    const response = await fetch('/_revision', { cache: 'no-store' });
    if (!response.ok) throw new Error('Refresh failed');
    const state = await response.json();
    document.querySelector('#status').textContent = state.error ? 'Refresh paused: ' + state.error : 'Live updates enabled';
    if (state.revision !== '${revision}') { const url = new URL(location.href); search.value ? url.searchParams.set('q', search.value) : url.searchParams.delete('q'); appFilter.value !== 'all' ? url.searchParams.set('app', appFilter.value) : url.searchParams.delete('app'); location.replace(url.href); }
  } catch { document.querySelector('#status').textContent = 'Live session disconnected; restart block-beaver start to reconnect.'; }
  finally { polling = false; }
}, 1000);` : ''}
</script></body></html>\n`;
}

export async function updateProject(root) {
  const scanned = await attachProjectRegistry(await scanRepository(root));
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
