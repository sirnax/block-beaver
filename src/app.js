import { FAMILY_MAP_CSS, renderFamilyMap, renderMapStyle, installFamilyMap } from './families/map-render.mjs';
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const state = { graph: null, view: 'map', selected: null, kind: 'all', app: 'all', query: '', suggestions: [], proposal: null, roadmaps: [] };
const kinds = { all: ['All pieces', '#6995a8'], component: ['Components', '#c27f6f'], hook: ['Hooks', '#987bad'], function: ['Functions', '#6999a4'], class: ['Classes', '#78938a'], file: ['Files', '#d1985b'], block: ['Blocks', '#4e83a7'] };
let toastTimer;
let replayTimer;
let crossAppNodes = new Set();
let edgeIndices = new Map();
let familyController;
let familyActiveBlocks = null;
const expandedApps = new Set();
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000); }
function number(value) { return Number(value || 0).toLocaleString(); }
function nodeById(id) { return state.graph?.nodes.find((node) => node.id === id); }
function relations(id) { return { incoming: state.graph.edges.filter((edge) => edge.to === id), outgoing: state.graph.edges.filter((edge) => edge.from === id) }; }
function setView(view) {
  if (view !== 'roadmap' && replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('selected', button.dataset.view === view));
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === `${view}-view`));
  const names = { map: ['Project map', 'Files organized by source neighborhood.'], pieces: ['Observed pieces', 'The functions, components, hooks and classes found in source.'], blocks: ['Declared blocks', 'Feature contracts already present in the repository.'], roadmap: ['Candidate boundaries', 'Suggested starting points for reviewed migration.'] };
  $('#section-title').textContent = names[view][0];
  $('#section-caption').textContent = names[view][1];
  render();
}
function renderKinds() {
  const counts = Object.fromEntries(Object.keys(kinds).map((kind) => [kind, kind === 'all' ? state.graph?.nodes.length || 0 : state.graph?.nodes.filter((node) => node.kind === kind).length || 0]));
  $('#kind-filters').innerHTML = Object.entries(kinds).map(([kind, [label, color]]) => `<button class="kind-filter ${state.kind === kind ? 'selected' : ''}" data-kind="${kind}" type="button"><i class="kind-dot" style="--tone:${color}"></i>${label}<em>${number(counts[kind])}</em></button>`).join('');
}
function graphApps() {
  const apps = state.graph?.apps || [];
  const outside = state.graph?.nodes.some((node) => ['file', 'block'].includes(node.kind) && node.app == null);
  return [...apps, ...(outside || !apps.length ? [{ id: null, root: '.', outside: true }] : [])];
}
function appKey(app) { return app.id == null ? 'outside' : `app:${app.id}`; }
function appMatches(node) {
  if (state.app === 'all') return true;
  if (state.app === 'cross-app') return crossAppNodes.has(node.id);
  return state.app === (node.app == null ? 'outside' : `app:${node.app}`);
}
function matches(node) {
  if (node.kind === 'block' && familyActiveBlocks && !familyActiveBlocks.has(node.id)) return false;
  if (!appMatches(node) || (state.kind !== 'all' && node.kind !== state.kind)) return false;
  return !state.query || `${node.name} ${node.path} ${node.id} ${node.description || ''}`.toLowerCase().includes(state.query);
}
function usedByChip(node) { return node.usedBy?.length > 1 ? `<span class="used-by" title="Reached from these apps">${node.usedBy.map(esc).join(' · ')}</span>` : ''; }
function renderApps() {
  $('#app-filter').innerHTML = `<option value="all">All apps</option>${graphApps().map((app) => `<option value="${esc(appKey(app))}">${esc(app.id ?? 'Outside apps')}</option>`).join('')}<option value="cross-app">Only cross-app links</option>`;
  $('#app-filter').value = state.app;
}
function appHeading(app) {
  const nodes = state.graph.nodes.filter((node) => node.app === app.id || (app.id == null && node.app == null));
  const health = app.health || {};
  const issues = (health.unresolvedImports || 0) + (health.unreachableFiles || 0) + (health.tsconfigErrors?.length || 0);
  return `<div class="app-heading"><div><h3>${esc(app.id ?? 'Outside apps')}</h3><small>${esc(app.root)} · ${number(nodes.filter((node) => node.kind === 'file').length)} files · ${number(nodes.filter((node) => node.kind === 'block').length)} blocks</small></div>${app.id != null ? `<button class="app-health ${esc(health.status || 'healthy')}" type="button" data-app-report="${esc(app.id)}" aria-label="Open ${esc(app.id)} resolution report">${issues ? `${number(issues)} ${issues === 1 ? 'issue' : 'issues'}` : 'Healthy'}</button>` : ''}</div>`;
}
function renderMap() {
  familyController?.dispose();
  familyController = null;
  if (!state.graph) return;
  $('#map-presentation').textContent = state.graph.families?.length ? 'Family floors and source neighborhoods' : 'Source neighborhoods';
  const fileNodes = state.graph.nodes.filter((node) => node.kind === 'file' && matches(node));
  $('#result-count').textContent = `${number(fileNodes.length)} files`;
  const areas = graphApps().filter((app) => state.app === 'all' || state.app === 'cross-app' || state.app === appKey(app)).map((app) => {
    const folders = new Map();
    for (const node of fileNodes.filter((node) => node.app === app.id || (app.id == null && node.app == null))) {
      const relative = app.root !== '.' && node.path.startsWith(`${app.root}/`) ? node.path.slice(app.root.length + 1) : node.path;
      const folder = relative.split('/').slice(0, -1).join('/') || '.';
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push(node);
    }
    if (!folders.size && state.query) return '';
    const expanded = expandedApps.has(appKey(app));
    const ranked = [...folders].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    return `<section class="app-area">${appHeading(app)}${(expanded ? ranked : ranked.slice(0, 60)).map(([folder, nodes]) => `<div class="folder"><div class="folder-head"><button type="button" data-folder="${esc(nodes[0].path.split('/').slice(0, -1).join('/') || '.')}" data-folder-app="${esc(appKey(app))}">▱ &nbsp; ${esc(folder)}</button><span>${nodes.length} files</span></div><div class="folder-files">${(expanded ? nodes : nodes.slice(0, 18)).map((node) => `<button class="file-chip ${state.selected === node.id ? 'selected' : ''}" data-id="${esc(node.id)}" type="button"><b>▤</b> ${esc(node.name)}<small>${node.lines} lines</small>${usedByChip(node)}</button>`).join('')}${!expanded && nodes.length > 18 ? `<button class="show-more" type="button" data-expand-app="${esc(appKey(app))}">Show ${number(nodes.length - 18)} more files</button>` : ''}</div></div>`).join('') || '<div class="empty-list">No files match this app filter.</div>'}${!expanded && ranked.length > 60 ? `<button class="show-more" type="button" data-expand-app="${esc(appKey(app))}">Show ${number(ranked.length - 60)} more folders</button>` : ''}</section>`;
  }).join('');
  const links = state.graph.edges.filter((edge) => edge.crossApp && [nodeById(edge.from), nodeById(edge.to)].some((node) => node && matches(node)));
  const crossLinks = links.length ? `<section class="cross-app-links"><h3>Cross-app links</h3>${links.map((edge) => `<button type="button" class="relation cross-app" data-map-history-from="${esc(edge.from)}" data-map-history-to="${esc(edge.to)}" data-map-search="${esc([nodeById(edge.from)?.name,nodeById(edge.to)?.name,edge.evidence?.file].join(' ').toLowerCase())}" data-edge="${edgeIndices.get(edge)}"><strong>${esc(nodeById(edge.from)?.name)} → ${esc(nodeById(edge.to)?.name)}</strong><span>${esc(edge.evidence?.file)}:${esc(edge.evidence?.line)}</span></button>`).join('')}</section>` : '';
  const familyHtml = renderFamilyMap(state.graph);
  $('#family-map-host').innerHTML = familyHtml;
  $('#map-content').innerHTML = areas + crossLinks || '<div class="empty-list">No files found. Try another search or app filter.</div>';
  familyController = familyHtml ? installFamilyMap($('#map-view'), state.graph, { filters: () => ({query: state.query, app: state.app}), onSelect: (id) => { state.selected = id; renderDetail(); }, onEdge: showEdge, onChange: (active) => { familyActiveBlocks = active; } }) : null;
}
function listItem(node, glyph) { return `<button class="item" data-id="${esc(node.id)}" type="button"><span class="item-glyph">${glyph}</span><span class="item-body"><strong>${esc(node.name)}</strong><small>${esc(node.path || node.id)}</small>${usedByChip(node)}</span><span class="item-meta">${esc(node.kind)}</span></button>`; }
function renderPieces() {
  if (!state.graph) return;
  const pieces = state.graph.nodes.filter((node) => !['file', 'block'].includes(node.kind) && matches(node));
  $('#result-count').textContent = `${number(pieces.length)} pieces`;
  $('#pieces-content').innerHTML = pieces.slice(0, 200).map((node) => listItem(node, node.kind === 'component' ? '◈' : node.kind === 'hook' ? '⌁' : '◇')).join('') || '<div class="empty-list">No pieces match this view.</div>';
  if (pieces.length > 200) $('#pieces-content').insertAdjacentHTML('beforeend', `<div class="empty-list">Showing the first 200. Search to narrow the list.</div>`);
}
function renderBlocks() {
  if (!state.graph) return;
  const blocks = state.graph.nodes.filter((node) => node.kind === 'block' && matches(node));
  $('#result-count').textContent = `${number(blocks.length)} blocks`;
  $('#block-source').textContent = state.graph.families?.length ? 'Configured family manifests and local blocks' : '.blocks manifests in this repository';
  $('#blocks-content').innerHTML = graphApps().map((app) => {
    const owned = blocks.filter((node) => node.app === app.id || (app.id == null && node.app == null));
    return owned.length ? `<section class="app-area">${appHeading(app)}${owned.map((node) => listItem(node, '▧')).join('')}</section>` : '';
  }).join('') || '<div class="empty-list">No declared blocks found. The map still shows observed pieces.</div>';
}
function renderRoadmap() {
  if (!state.graph) return;
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  const candidates = state.suggestions.filter((entry) => !state.query || `${entry.folder} ${entry.reason}`.toLowerCase().includes(state.query));
  $('#result-count').textContent = `${candidates.length} candidates`;
  $('#roadmap-content').innerHTML = `${candidates.map((entry) => `<button class="item" data-folder="${esc(entry.folder)}" type="button"><span class="item-glyph">▱</span><span class="item-body"><strong>${esc(entry.folder)}</strong><small>${esc(entry.reason)}</small></span><span class="item-meta">score ${entry.score}</span></button>`).join('') || '<div class="empty-list">No candidates yet. Scan a project with related files.</div>'}<div class="ledger-heading">Recorded roadmaps</div>${state.roadmaps.map((roadmap) => `<button class="item" data-roadmap="${esc(roadmap.id)}" type="button"><span class="item-glyph">⌁</span><span class="item-body"><strong>${esc(roadmap.title)}</strong><small>${roadmap.slices.length} slices · ${esc(roadmap.id)}</small></span><span class="item-meta">Replay</span></button>`).join('') || '<div class="empty-list">No recorded roadmaps in this repository.</div>'}<div id="roadmap-replay"></div>`;
}
function miniGraph(node, incoming, outgoing) {
  const ins = incoming.slice(0, 3), outs = outgoing.slice(0, 3);
  const lines = [];
  const labels = [];
  ins.forEach((edge, i) => { const y = 28 + i * 42; lines.push(`<path class="${edge.crossApp ? 'cross-app' : ''}" data-edge="${edgeIndices.get(edge)}" tabindex="0" role="button" aria-label="Show connection evidence" d="M58 ${y} C105 ${y}, 95 89, 140 89"/>`); labels.push(`<circle cx="52" cy="${y}" r="5"/><text x="66" y="${y - 8}">${esc((nodeById(edge.from)?.name || '').slice(0, 15))}</text>`); });
  outs.forEach((edge, i) => { const y = 28 + i * 42; lines.push(`<path class="${edge.crossApp ? 'cross-app' : ''}" data-edge="${edgeIndices.get(edge)}" tabindex="0" role="button" aria-label="Show connection evidence" d="M160 89 C205 89, 195 ${y}, 242 ${y}"/>`); labels.push(`<circle cx="248" cy="${y}" r="5"/><text x="229" y="${y - 8}" text-anchor="end">${esc((nodeById(edge.to)?.name || '').slice(0, 15))}</text>`); });
  return `<div class="mini-graph" aria-label="${ins.length} incoming and ${outs.length} outgoing relationships"><svg viewBox="0 0 300 175" role="img" aria-label="Connections for ${esc(node.name)}"><g class="graph-lines">${lines.join('')}</g><g class="graph-points">${labels.join('')}<rect x="140" y="79" width="20" height="20" rx="4"/><text class="center-label" x="150" y="121" text-anchor="middle">${esc(node.name.slice(0, 21))}</text></g></svg></div>`;
}
function renderDetail() {
  const el = $('#detail');
  const node = nodeById(state.selected);
  if (!node) { el.innerHTML = '<div class="empty-detail"><span>↗</span><h3>Inspect a connection</h3><p>Choose a file, piece or block to see its relationships and source evidence.</p></div>'; return; }
  const { incoming, outgoing } = relations(node.id);
  const relation = (edge, direction) => { const other = nodeById(direction === 'out' ? edge.to : edge.from); if (!other) return ''; return `<div class="relation-row"><button class="relation ${edge.crossApp ? 'cross-app' : ''}" data-edge="${edgeIndices.get(edge)}" type="button"><strong>${esc(other.name)}</strong><span>${edge.crossApp ? 'Cross-app · ' : ''}${esc(direction === 'out' ? edge.kind : `used by · ${edge.kind}`)} · ${esc(edge.evidence.file)}:${edge.evidence.line}</span></button><button class="relation-target" data-id="${esc(other.id)}" type="button">Inspect ${esc(other.name)}</button></div>`; };
  const proof = (edge) => `<div class="source-proof">${esc(edge.kind)} · ${esc(edge.evidence.file)}:${edge.evidence.line}:${edge.evidence.column}<code>${esc(edge.evidence.text)}</code></div>`;
  const options = node.kind === 'block' && node.family === 'local' ? state.graph.nodes.filter((other) => other.kind === 'block' && other.id !== node.id && !(node.manifest.dependencies || []).includes(other.id)) : [];
  const connectionEditor = options.length ? `<div class="detail-section"><h4>Propose a connection</h4><div class="proposal-box"><label for="connection-target">This block depends on</label><select id="connection-target">${options.map((other) => `<option value="${esc(other.id)}">${esc(other.name)}</option>`).join('')}</select><button id="preview-connection" type="button">Preview change</button><div id="connection-result"></div></div></div>` : '';
  el.innerHTML = `<div class="detail-inner"><span class="detail-kind">${esc(node.family || node.kind)}</span><h3>${esc(node.name)}</h3><div class="detail-path">${esc(node.path || node.id)}</div>${usedByChip(node)}${node.description ? `<p class="detail-desc">${esc(node.description)}</p>` : ''}${miniGraph(node, incoming, outgoing)}${node.evidence ? proof({ kind: 'declared', evidence: node.evidence }) : ''}<div class="detail-section"><h4>Uses (${outgoing.length})</h4>${outgoing.slice(0, 25).map((edge) => relation(edge, 'out')).join('') || '<p class="detail-desc">No outgoing relationships observed.</p>'}</div><div class="detail-section"><h4>Used by (${incoming.length})</h4>${incoming.slice(0, 25).map((edge) => relation(edge, 'in')).join('') || '<p class="detail-desc">No incoming relationships observed.</p>'}</div><div class="detail-section"><h4>Evidence</h4>${[...outgoing, ...incoming].slice(0, 15).map(proof).join('') || '<p class="detail-desc">No relationship evidence for this item.</p>'}</div>${connectionEditor}</div>`;
  if (options.length) $('#preview-connection').addEventListener('click', async () => {
    const response = await fetch('/api/connection-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blockId: node.id, dependencyId: $('#connection-target').value }) });
    const result = await response.json();
    if (!response.ok) { toast(result.error || 'Could not preview connection.'); return; }
    $('#connection-result').innerHTML = `<p class="detail-desc">${result.check.valid ? 'Review the manifest change below.' : result.check.errors.map((error) => esc(error.message)).join('<br>')}</p><div class="diff-label">Before</div><pre>${esc(JSON.stringify(result.before, null, 2))}</pre><div class="diff-label">Proposed</div><pre>${esc(JSON.stringify(result.manifest, null, 2))}</pre><button id="download-connection" type="button">Download proposal</button>`;
    $('#download-connection').addEventListener('click', () => { const blob = new Blob([JSON.stringify(result, null, 2) + '\n'], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${result.manifest.id}.proposal.json`; link.click(); URL.revokeObjectURL(link.href); });
  });
}
function render() {
  edgeIndices = new Map((state.graph?.edges || []).map((edge, index) => [edge, index]));
  crossAppNodes = new Set((state.graph?.edges || []).filter((edge) => edge.crossApp).flatMap((edge) => [edge.from, edge.to]));
  renderKinds();
  renderApps();
  if (state.view === 'map') renderMap();
  if (state.view === 'pieces') renderPieces();
  if (state.view === 'blocks') renderBlocks();
  if (state.view === 'roadmap') renderRoadmap();
  renderDetail();
}
async function scan() {
  const root = $('#repo-path').value.trim();
  if (!root) { toast('Enter an absolute repository path.'); return; }
  $('#scan-button').disabled = true;
  $('#scan-button').textContent = 'Scanning…';
  $('#scan-status').textContent = 'Scanning source';
  try {
    const response = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Scan failed');
    state.graph = result;
    familyActiveBlocks = null;
    let style = document.querySelector('#family-map-style');
    if (!style) { style = document.createElement('style'); style.id = 'family-map-style'; style.nonce = document.querySelector('script[nonce]')?.nonce || '__BLOCK_BEAVER_NONCE__'; document.head.append(style); }
    style.textContent = result.families?.length ? FAMILY_MAP_CSS + renderMapStyle(result.mapStyle) : '';
    expandedApps.clear();
    state.selected = null;
    state.query = '';
    state.kind = 'all';
    state.app = 'all';
    $('#search').value = '';
    $('#count-files').textContent = number(result.summary.files);
    $('#count-pieces').textContent = number(result.summary.pieces);
    $('#count-links').textContent = number(result.summary.relationships);
    $('#count-blocks').textContent = number(result.summary.blocks || 0);
    $('#fingerprint').textContent = `Scan ${result.fingerprint}`;
    $('#scan-status').textContent = result.resolutionReport?.length ? `Scan complete · ${number(result.resolutionReport.length)} unresolved ${result.resolutionReport.length === 1 ? 'import' : 'imports'}` : 'Scan complete';
    const suggestions = await fetch('/api/suggestions');
    state.suggestions = suggestions.ok ? await suggestions.json() : [];
    const roadmaps = await fetch('/api/roadmaps');
    state.roadmaps = roadmaps.ok ? await roadmaps.json() : [];
    setView('map');
    toast(`Mapped ${number(result.summary.files)} files.`);
  } catch (error) { $('#scan-status').textContent = 'Scan failed'; toast(error.message); }
  finally { $('#scan-button').disabled = false; $('#scan-button').innerHTML = 'Scan project <span>↗</span>'; }
}
function folderDetail(folder, app) {
  if (state.view !== 'map') setView('map');
  const entry = state.suggestions.find((candidate) => candidate.folder === folder);
  const files = entry && !app ? entry.files : state.graph.nodes.filter((node) => node.kind === 'file' && (folder === '.' ? !node.path.includes('/') : node.path.startsWith(folder + '/')) && (!app || app === (node.app == null ? 'outside' : `app:${node.app}`))).map((node) => node.path);
  state.selected = null;
  $('#detail').innerHTML = `<div class="detail-inner"><span class="detail-kind">Candidate boundary</span><h3>${esc(folder)}</h3><p class="detail-desc">${esc(entry?.reason || `${files.length} source files`)}</p><div class="detail-section"><h4>Files in this boundary</h4>${files.slice(0, 40).map((path) => `<button class="relation" data-id="${esc(`file:${path}`)}" type="button"><strong>${esc(path)}</strong></button>`).join('')}</div><div class="detail-section"><h4>Propose a block</h4><div class="proposal-box"><label for="proposal-id">Block ID</label><input id="proposal-id" value="${esc(folder.split('/').pop().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '') || 'new-block')}"><label for="proposal-name">Name</label><input id="proposal-name" value="${esc(folder.split('/').pop())}"><label for="proposal-rationale">Why do these files belong together?</label><textarea id="proposal-rationale" placeholder="Describe the feature boundary"></textarea><button id="preview-proposal" type="button">Preview manifest</button><div id="proposal-result"></div></div></div></div>`;
  $('#preview-proposal').addEventListener('click', async () => {
    const candidate = { id: $('#proposal-id').value.trim(), name: $('#proposal-name').value.trim(), description: `Feature boundary for ${folder}.`, rationale: $('#proposal-rationale').value.trim(), files };
    const response = await fetch('/api/proposal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(candidate) });
    const result = await response.json();
    state.proposal = result;
    $('#proposal-result').innerHTML = `${result.check.valid ? '<p class="detail-desc">Valid Block Beaver manifest. Review it before adoption.</p>' : `<p class="detail-desc">${result.check.errors.map((error) => esc(`${error.path}: ${error.message}`)).join('<br>')}</p>`}<pre>${esc(JSON.stringify(result.manifest, null, 2))}</pre><button id="download-proposal" type="button">Download proposal</button>`;
    $('#download-proposal').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(result, null, 2) + '\n'], { type: 'application/json' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${result.manifest.id || 'block'}.proposal.json`; link.click(); URL.revokeObjectURL(link.href);
    });
  });
}
function showAppReport(id) {
  if (state.view !== 'map') setView('map');
  state.selected = null;
  const app = state.graph.apps.find((entry) => entry.id === id);
  const report = (state.graph.resolutionReport || []).filter((entry) => entry.app === id);
  const diagnostics = (state.graph.diagnostics || []).filter((entry) => entry.app === id);
  const unreachable = state.graph.nodes.filter((node) => node.kind === 'file' && node.app === id && (state.graph.unreachableFiles || []).includes(node.path));
  $('#detail').innerHTML = `<div class="detail-inner"><span class="detail-kind">App health</span><h3>${esc(id)}</h3><div class="detail-path">${esc(app?.root)}</div><div class="detail-section"><h4>Unresolved imports (${report.length})</h4>${report.map((entry) => `<div class="source-proof">${esc(entry.file)}:${esc(entry.line)}:${esc(entry.column)}<code>${esc(entry.specifier)}</code>${esc(entry.message)}</div>`).join('') || '<p class="detail-desc">All imports resolved.</p>'}</div><div class="detail-section"><h4>Configuration errors (${diagnostics.length})</h4>${diagnostics.map((entry) => `<p class="detail-desc">${esc(entry.field)}: ${esc(entry.message)}</p>`).join('') || '<p class="detail-desc">No configuration errors.</p>'}</div><div class="detail-section"><h4>Unreachable files (${unreachable.length})</h4>${unreachable.map((node) => listItem(node, '▤')).join('') || '<p class="detail-desc">Every file is reached from an app entry point.</p>'}</div></div>`;
}
function showEdge(index) {
  const edge = state.graph?.edges[index];
  if (!edge) return;
  if (state.view !== 'map') setView('map');
  state.selected = null;
  const source = nodeById(edge.from), target = nodeById(edge.to), evidence = edge.evidence || {};
  $('#detail').innerHTML = `<div class="detail-inner"><span class="detail-kind">${edge.crossApp ? 'Cross-app connection' : 'Connection'}</span><h3>${esc(source?.name)} → ${esc(target?.name)}</h3><p class="detail-desc">${esc(source?.app ?? 'Outside apps')} → ${esc(target?.app ?? 'Outside apps')} · ${esc(edge.kind)}</p><div class="source-proof">${esc(evidence.file)}:${esc(evidence.line)}:${esc(evidence.column)}<code>${esc(evidence.text)}</code></div>${[source, target].filter(Boolean).map((node) => listItem(node, '▤')).join('')}</div>`;
}
document.addEventListener('click', (event) => {
  const expand = event.target.closest('[data-expand-app]');
  if (expand) { expandedApps.add(expand.dataset.expandApp); render(); }
  const edge = event.target.closest('[data-edge]');
  const app = event.target.closest('[data-app-report]');
  if (edge) showEdge(Number(edge.dataset.edge));
  if (app) showAppReport(app.dataset.appReport);
});
document.addEventListener('keydown', (event) => {
  const edge = event.target.closest('path[data-edge]');
  if (edge && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); showEdge(Number(edge.dataset.edge)); }
});
$('.main-nav').addEventListener('click', (event) => { const button = event.target.closest('[data-view]'); if (button) { state.kind = 'all'; setView(button.dataset.view); } });
$('#kind-filters').addEventListener('click', (event) => { const button = event.target.closest('[data-kind]'); if (button) { state.kind = button.dataset.kind; setView(state.kind === 'block' ? 'blocks' : state.kind === 'file' || state.kind === 'all' ? 'map' : 'pieces'); } });
$('#scan-button').addEventListener('click', scan);
$('#repo-path').addEventListener('keydown', (event) => { if (event.key === 'Enter') scan(); });
$('#app-filter').addEventListener('change', (event) => { state.app = event.target.value; render(); });
$('#search').addEventListener('input', (event) => { state.query = event.target.value.trim().toLowerCase(); render(); });
document.addEventListener('click', (event) => { const id = event.target.closest('[data-id]')?.dataset.id; const folder = event.target.closest('[data-folder]')?.dataset.folder; if (id) { state.selected = id; if (state.view !== 'map') setView('map'); else renderDetail(); } else if (folder && state.graph) folderDetail(folder, event.target.closest('[data-folder]')?.dataset.folderApp); });
document.addEventListener('click', async (event) => {
  const id = event.target.closest('[data-roadmap]')?.dataset.roadmap;
  if (!id) return;
  const response = await fetch(`/api/roadmap?id=${encodeURIComponent(id)}`);
  const data = await response.json();
  if (!response.ok) { toast(data.error || 'Could not load roadmap.'); return; }
  const panel = $('#roadmap-replay');
  panel.innerHTML = `<div class="replay-panel"><strong>${esc(data.roadmap.title)}</strong><p>${data.events.length} recorded events · ${data.roadmap.scope.length} files in scope</p><div class="replay-controls"><button class="replay-play" type="button">Play</button><input type="range" min="1" max="${Math.max(1, data.events.length)}" value="${Math.max(1, data.events.length)}" aria-label="Roadmap event"></div><div class="replay-event"></div></div>`;
  const slider = panel.querySelector('input');
  const show = () => { const entry = data.events[Number(slider.value) - 1]; const files = entry?.slice ? data.slices[entry.slice]?.files || [] : []; panel.querySelector('.replay-event').innerHTML = entry ? `<span>Event ${entry.seq} of ${data.events.length}</span><strong>${esc(entry.type.replaceAll('-', ' '))}</strong><small>${esc(entry.at)}${entry.slice ? ` · ${esc(entry.slice)}` : ''}</small>${files.length ? `<div class="replay-files">${files.map((path) => `<button type="button" data-id="${esc(`file:${path}`)}">${esc(path)}</button>`).join('')}</div>` : ''}` : ''; };
  slider.addEventListener('input', show);
  const play = panel.querySelector('.replay-play');
  play.addEventListener('click', () => { if (replayTimer) { clearInterval(replayTimer); replayTimer = null; play.textContent = 'Play'; return; } slider.value = '1'; show(); play.textContent = 'Pause'; replayTimer = setInterval(() => { if (Number(slider.value) >= data.events.length) { clearInterval(replayTimer); replayTimer = null; play.textContent = 'Play'; return; } slider.value = String(Number(slider.value) + 1); show(); }, 750); });
  show();
});
const meta = await fetch('/api/meta').then((response) => response.json());
$('#repo-path').value = meta.root;
