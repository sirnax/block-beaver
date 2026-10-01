const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const palette = ['#447c94', '#8e639e', '#b37842', '#477e65', '#a65969', '#697ab0'];

export function linkColor(kind) {
  let hash = 2166136261;
  for (const char of String(kind)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return palette[hash % palette.length];
}

export function mapStorageKey(graph, suffix) {
  const name = String(graph.repoName || graph.name || graph.root?.split(/[\\/]/).filter(Boolean).pop() || 'project').replace(/[^a-zA-Z0-9._-]/g, '-');
  return `block-beaver:${name || 'project'}:${suffix}`;
}

/** Validate style data again at the rendering boundary; generated HTML is a document. */
export function validateMapStyle(map = {}) {
  const diagnostics = [], tokens = {};
  for (const [name, value] of Object.entries(map.tokens || {})) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || typeof value !== 'string' || /[;{}<>\\]|url\s*\(|image-set\s*\(|(?:https?:)?\/\//i.test(value)) diagnostics.push(`Invalid map token: ${name}`);
    else tokens[name] = value;
  }
  const candidate = typeof map.css === 'string' ? map.css : '';
  let valid = !/<\/style|@import|\\|(?:https?:)?\/\/|image-set\s*\(/i.test(candidate);
  for (const match of candidate.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const url = match[2].trim();
    // Skin fonts may be served by the host. Remote/protocol URLs are rejected.
    if (!/^data:/i.test(url) && (/^[\/\\]{2}|:|[<>]/.test(url) || !url)) valid = false;
  }
  if (!valid) diagnostics.push('Map skin contains an external URL, import, CSS escape, or closing style tag.');
  return { css: valid ? candidate : '', tokens, diagnostics };
}

export function renderMapStyle(map = {}) {
  const safe = validateMapStyle(map);
  const tokens = Object.entries(safe.tokens).sort(([a], [b]) => order(a, b)).map(([name, value]) => `--bb-${name}:${value}`).join(';');
  return `${tokens ? `:root{${tokens}}\n` : ''}${safe.css}`;
}

export const FAMILY_MAP_CSS = `
.family-map{margin:32px 0;padding:20px;background:var(--bb-map-background,#edf0ec);border:1px solid #cbd4d3;border-radius:12px;font-family:var(--bb-font-family,system-ui,sans-serif)}.family-map h2{font-size:24px}.family-history{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0}.family-history input{flex:1;min-width:180px;width:auto;padding:0}.family-history output{font-size:13px}.family-canvas{overflow-x:auto}.family-scene{width:100%;min-width:760px;height:auto;display:block;overflow:visible}.family-surface{fill:var(--bb-floor-surface,#d7e2df);stroke:#a0b4b1;stroke-width:1.5}.family-block-slab{fill:var(--bb-block-surface,#ffffff);stroke:#4b7c79;stroke-width:1.5}.ordinary-slab{fill:var(--bb-ordinary-surface,#cbd0d0);stroke:#8b969a}.family-scene text{fill:var(--bb-map-text,#203c46);font-family:var(--bb-font-family,system-ui,sans-serif)}.floor-title{font-size:22px;font-weight:650}.floor-blurb{font-size:14px}.slab-label{font-size:14px;pointer-events:none}.family-node{cursor:pointer}.family-node:focus .family-block-slab,.family-node:hover .family-block-slab{stroke:#203c46;stroke-width:3}.family-link{fill:none;stroke-width:3;cursor:pointer}.family-link.cross-app{stroke-dasharray:7 4}.family-link:focus,.family-link:hover{stroke-width:5}.family-map-key{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;margin:12px 0}.link-key{border-left:4px solid;padding-left:7px}.family-map-empty{font-size:13px}.family-evidence{margin-top:12px;padding:12px;background:#fff;border:1px solid #cbd4d3;border-radius:8px}.family-evidence pre{white-space:pre-wrap}.family-scene [hidden]{display:none}.history-note{font-size:12px;color:#527078}
`;

export function renderFamilyMap(graph) {
  if (!graph.families?.length) return '';
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const points = new Map();
  let y = 70, width = 1080;
  const floors = graph.families.map((family) => {
    const blocks = graph.nodes.filter((node) => node.kind === 'block' && node.family === family.id).sort((a, b) => order(a.id, b.id));
    const rows = Math.max(1, Math.ceil(blocks.length / 4)), height = rows * 45 + 80;
    width = Math.max(width, 810 + rows * 35 + 110);
    const floorY = y;
    y += height + 70;
    const slabs = blocks.map((block, index) => {
      const row = Math.floor(index / 4), column = index % 4;
      const x = 275 + column * 130 + row * 35, top = floorY + 45 + row * 45;
      points.set(block.id, { x: x + 60, y: top });
      return `<g class="family-node" tabindex="0" role="button" aria-label="Inspect ${escape(block.name)}" data-map-id="${escape(block.id)}" data-family-block="${escape(block.id)}" data-map-app="${escape(block.app ?? '')}" data-map-search="${escape([block.name, block.id, block.description, block.path].join(' ').toLowerCase())}"><title>${escape(block.name)} · ${escape(block.id)}</title><polygon class="family-block-slab" points="${x},${top} ${x + 65},${top - 22} ${x + 125},${top} ${x + 60},${top + 22}"/><text class="slab-label" x="${x + 60}" y="${top + 4}" text-anchor="middle">${escape(String(block.name || block.id).slice(0, 15))}</text></g>`;
    }).join('');
    return `<g class="family-floor" data-family="${escape(family.id)}" data-floor="${Number(family.floor) || 0}"><text class="floor-title" x="20" y="${floorY + 18}">${escape(family.title || family.id)}</text><text class="floor-blurb" x="20" y="${floorY + 40}">${blocks.length} blocks</text><text class="floor-blurb" x="20" y="${floorY + 60}">${escape(String(family.blurb || '').slice(0, 34))}</text><polygon class="family-surface" points="240,${floorY} 810,${floorY} ${810 + rows * 35 + 75},${floorY + height} ${240 + rows * 35 + 75},${floorY + height}"/>${slabs}</g>`;
  }).join('');
  const groups = new Map();
  for (const file of graph.nodes.filter((node) => node.kind === 'file')) {
    const app = graph.apps?.find((entry) => entry.id === file.app);
    const relative = app?.root && app.root !== '.' && file.path.startsWith(app.root + '/') ? file.path.slice(app.root.length + 1) : file.path;
    const folder = relative.split('/').slice(0, -1).join('/') || '.';
    const key = `${file.app ?? ''}\0${folder}`;
    if (!groups.has(key)) groups.set(key, { app: file.app ?? '', folder, files: [] });
    groups.get(key).files.push(file);
  }
  const ordinary = [...groups].sort(([a], [b]) => order(a, b)).map(([, group], index) => {
    const top = y + Math.floor(index / 3) * 65, x = 230 + index % 3 * 225;
    return `<g class="ordinary-code" data-map-app="${escape(group.app)}" data-map-search="${escape(group.files.map((file) => file.path).join(' ').toLowerCase())}"><title>${escape(group.files.map((file) => file.path).join('\n'))}</title><polygon class="ordinary-slab" points="${x},${top} ${x + 155},${top} ${x + 195},${top + 40} ${x + 40},${top + 40}"/><text class="slab-label" x="${x + 30}" y="${top + 16}">${escape(group.app || 'Outside apps')}</text><text class="slab-label" x="${x + 40}" y="${top + 32}">${escape(group.folder)} · ${group.files.length} files</text></g>`;
  }).join('');
  const links = graph.edges.flatMap((edge, index) => {
    if (!edge.link || !points.has(edge.from) || !points.has(edge.to)) return [];
    const from = points.get(edge.from), to = points.get(edge.to);
    const color = linkColor(edge.kind);
    const variable = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(edge.kind) ? `var(--bb-link-${edge.kind},${color})` : color;
    return [`<path class="family-link ${edge.crossApp ? 'cross-app' : ''}" data-map-edge="${index}" data-map-from="${escape(edge.from)}" data-map-to="${escape(edge.to)}" data-map-app="${escape(nodes.get(edge.from)?.app ?? '')}" tabindex="0" role="button" aria-label="Show ${escape(edge.kind)} connection evidence" stroke="${escape(variable)}" d="M${from.x} ${from.y} C${from.x - 100} ${from.y},${to.x - 100} ${to.y},${to.x} ${to.y}"><title>${escape(edge.kind)}: ${escape(nodes.get(edge.from)?.name)} → ${escape(nodes.get(edge.to)?.name)}</title></path>`];
  }).join('');
  const height = y + Math.max(1, Math.ceil(groups.size / 3)) * 65 + 20;
  const history = graph.history || [];
  const key = mapStorageKey(graph, 'family-history');
  return `<section class="family-map" aria-label="Family map"><h2>Block families</h2>${history.length ? `<div class="family-history"><label for="family-history">History</label><input id="family-history" type="range" min="0" max="${history.length}" value="${history.length}" data-storage-key="${escape(key)}"><output id="family-history-label">Current</output></div><p class="history-note">History shows which current blocks existed in the selected snapshot.</p>` : ''}<div class="family-canvas"><svg class="family-scene" viewBox="0 0 ${width} ${height}" role="group" aria-label="Family floors and ordinary code">${floors}${links}<text class="floor-title" x="20" y="${y + 20}">Ordinary code</text>${ordinary}</svg></div><div class="family-evidence" id="family-evidence" hidden></div></section>`;
}

/** Shared browser controller; its source is inlined into generated documents. */
export function installFamilyMap(container, graph, { filters = () => ({ query: '', app: 'all' }), onSelect, onEdge, onChange } = {}) {
  const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const slider = container.querySelector('#family-history');
  const label = container.querySelector('#family-history-label');
  const history = graph.history || [];
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (slider) {
    try {
      const saved = localStorage.getItem(slider.dataset.storageKey);
      if (saved != null && Number.isInteger(Number(saved)) && Number(saved) >= 0 && Number(saved) <= history.length) slider.value = saved;
    } catch { /* Storage is optional when serving offline or under host policies. */ }
  }
  const activeBlocks = () => !slider || Number(slider.value) === history.length ? null : new Set(history[Number(slider.value)]?.blocks || []);
  function update() {
    const snapshot = slider && history[Number(slider.value)];
    if (label) label.textContent = snapshot ? `${snapshot.date} · ${snapshot.label || 'Snapshot'}` : 'Current';
    const active = activeBlocks(), current = filters();
    const query = (current.query || '').toLowerCase();
    const app = current.app || 'all';
    const cross = app === 'cross' || app === 'cross-app';
    for (const item of container.querySelectorAll('[data-family-block]')) {
      const matchApp = app === 'all' || cross || (app === 'outside' ? item.dataset.mapApp === '' : app === `app:${item.dataset.mapApp}`);
      const matchSearch = !(item.dataset.mapSearch || item.dataset.search || '').includes(query) ? !query : true;
      item.toggleAttribute('hidden', Boolean((active && !active.has(item.dataset.familyBlock)) || !matchApp || !matchSearch || cross));
    }
    for (const item of container.querySelectorAll('.ordinary-code')) item.toggleAttribute('hidden', cross || (app !== 'all' && (app === 'outside' ? item.dataset.mapApp !== '' : app !== `app:${item.dataset.mapApp}`)) || !item.dataset.mapSearch.includes(query));
    for (const path of container.querySelectorAll('[data-map-edge]')) {
      const edge = graph.edges[Number(path.dataset.mapEdge)];
      const from = container.querySelector(`[data-map-id="${CSS.escape(path.dataset.mapFrom)}"]`);
      const to = container.querySelector(`[data-map-id="${CSS.escape(path.dataset.mapTo)}"]`);
      const historyHidden = active && (!active.has(path.dataset.mapFrom) || !active.has(path.dataset.mapTo));
      const endpointMatch = !query || [nodes.get(path.dataset.mapFrom), nodes.get(path.dataset.mapTo)].some((node) => `${node?.name} ${node?.id} ${node?.path} ${node?.description}`.toLowerCase().includes(query));
      path.toggleAttribute('hidden', Boolean(historyHidden || !endpointMatch || (cross ? !edge.crossApp : from?.hasAttribute('hidden') || to?.hasAttribute('hidden'))));
    }
    for (const item of container.querySelectorAll('[data-map-history-from]')) {
      const from = nodes.get(item.dataset.mapHistoryFrom), to = nodes.get(item.dataset.mapHistoryTo);
      const hidden = active && ((from?.kind === 'block' && !active.has(from.id)) || (to?.kind === 'block' && !active.has(to.id)));
      item.toggleAttribute('hidden', Boolean(hidden || !(item.dataset.mapSearch || item.dataset.search || '').includes(query)));
    }
    const panel = container.querySelector('#family-evidence');
    if (panel) panel.hidden = true;
    if (onChange) onChange(active);
    return active;
  }
  function changeHistory() { try { localStorage.setItem(slider.dataset.storageKey, Number(slider.value) === history.length ? 'current' : slider.value); } catch {} update(); }
  if (slider) slider.addEventListener('input', changeHistory);
  function activate(event) {
    const target = event.target.closest('[data-map-id], [data-map-edge]');
    if (!target || !container.contains(target)) return;
    if (event.type === 'keydown') { if (!['Enter', ' '].includes(event.key)) return; event.preventDefault(); }
    const panel = container.querySelector('#family-evidence');
    if (target.dataset.mapEdge != null) {
      const index = Number(target.dataset.mapEdge), edge = graph.edges[index];
      if (onEdge) onEdge(index);
      else if (panel) { panel.hidden = false; panel.innerHTML = `<strong>${escapeText(edge.kind)}</strong><p>${escapeText(nodes.get(edge.from)?.name)} → ${escapeText(nodes.get(edge.to)?.name)}</p><p><code>${escapeText(edge.evidence?.file)}:${escapeText(edge.evidence?.line)}</code></p><pre>${escapeText(edge.evidence?.text)}</pre>`; }
    } else {
      const node = nodes.get(target.dataset.mapId);
      if (onSelect) onSelect(node.id);
      else if (panel) { panel.hidden = false; panel.innerHTML = `<strong>${escapeText(node.name)}</strong><p>${escapeText(node.description)}</p><code>${escapeText(node.path || node.id)}</code>`; }
    }
  }
  container.addEventListener('click', activate);
  container.addEventListener('keydown', activate);
  update();
  function dispose() {
    container.removeEventListener('click', activate);
    container.removeEventListener('keydown', activate);
    slider?.removeEventListener('input', changeHistory);
  }
  return { update, activeBlocks, dispose };
}
