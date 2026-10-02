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

const skinId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * `map.skins` (0.6.0): each skin is validated again here and rendered to its own stylesheet.
 * The legacy `map.skin`/`map.tokens` sheet stays the base; the selected skin layers over it.
 */
export function renderMapSkins(mapStyle = {}) {
  const seen = new Set();
  return (Array.isArray(mapStyle?.skins) ? mapStyle.skins : []).flatMap((skin) => {
    if (!skin || typeof skin.id !== 'string' || !skinId.test(skin.id) || seen.has(skin.id)) return [];
    seen.add(skin.id);
    return [{ id: skin.id, css: renderMapStyle(skin) }];
  });
}

export const FAMILY_MAP_CSS = `
.family-map{margin:32px 0;padding:20px;background:var(--bb-map-background,#edf0ec);border:1px solid #cbd4d3;border-radius:12px;font-family:var(--bb-font-family,system-ui,sans-serif)}.family-map h2{font-size:24px}.family-history{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0}.family-history input{flex:1;min-width:180px;width:auto;padding:0}.family-history output{font-size:13px}.family-canvas{overflow-x:auto}.family-scene{width:100%;min-width:760px;height:auto;display:block;overflow:visible}.family-surface{fill:var(--bb-floor-surface,#d7e2df);stroke:#a0b4b1;stroke-width:1.5}.family-block-slab{fill:var(--bb-block-surface,#ffffff);stroke:#4b7c79;stroke-width:1.5}.ordinary-slab{fill:var(--bb-ordinary-surface,#cbd0d0);stroke:#8b969a}.family-scene text{fill:var(--bb-map-text,#203c46);font-family:var(--bb-font-family,system-ui,sans-serif)}.floor-title{font-size:22px;font-weight:650}.floor-blurb{font-size:14px}.slab-label{font-size:14px;pointer-events:none}.family-node{cursor:pointer}.family-node:focus .family-block-slab,.family-node:hover .family-block-slab{stroke:#203c46;stroke-width:3}.family-link{fill:none;stroke-width:3;cursor:pointer}.family-link.cross-app{stroke-dasharray:7 4}.family-link:focus,.family-link:hover{stroke-width:5}.family-map-key{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;margin:12px 0}.link-key{border-left:4px solid;padding-left:7px}.family-map-empty{font-size:13px}.family-evidence{margin-top:12px;padding:12px;background:#fff;border:1px solid #cbd4d3;border-radius:8px}.family-evidence pre{white-space:pre-wrap}.family-scene [hidden]{display:none}.history-note{font-size:12px;color:#527078}
.family-node.unused .family-block-slab{stroke:var(--bb-unused-stroke,#a65969);stroke-dasharray:6 4}.family-ghost .family-block-slab{fill:var(--bb-ghost-surface,#f4f1ec);fill-opacity:.55;stroke:#8b969a;stroke-dasharray:3 4}.family-ghost .slab-label{fill-opacity:.6;font-style:italic}.group-label{font-size:12px;font-weight:600;fill-opacity:.75;letter-spacing:.04em}.ordinary-code.reaches{cursor:pointer}.ordinary-code.reaches .ordinary-slab{stroke:var(--bb-reach-line,#c46b2b);stroke-width:1.5}.ordinary-code.reaches:focus .ordinary-slab,.ordinary-code.reaches:hover .ordinary-slab{stroke-width:3}.reach-count{font-size:12px;font-weight:600}.reach-line{fill:none;stroke:var(--bb-reach-line,#c46b2b);stroke-width:1.5;stroke-dasharray:4 3;pointer-events:none}.family-node.reach-lit .family-block-slab{stroke:var(--bb-reach-line,#c46b2b);stroke-width:3}.family-skins{display:flex;align-items:center;gap:8px;margin:12px 0}.family-skins select{width:auto;padding:6px 10px}.family-map-key details{flex-basis:100%}.family-map-key summary{cursor:pointer}.family-map-key ul{margin:6px 0;padding-left:20px;columns:2 220px}.family-map-key button{font:inherit;background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer}.unused-key{border-left:4px dashed var(--bb-unused-stroke,#a65969);padding-left:7px}.reach-key{border-left:4px solid var(--bb-reach-line,#c46b2b);padding-left:7px}.ghost-key{border-left:4px dotted #8b969a;padding-left:7px}
`;

/**
 * Ghost bricks: blocks that stood in some history snapshot but are not current nodes.
 * Each is drawn on its family's floor, hidden until a snapshot that contains it is selected.
 * A block whose family no longer exists has no floor and is not drawn.
 */
function ghostBlocks(graph, nodes) {
  const families = new Set(graph.families.map((family) => family.id)), ghosts = new Map();
  for (const snapshot of graph.history || []) for (const id of Array.isArray(snapshot?.blocks) ? snapshot.blocks : []) {
    if (typeof id !== 'string' || nodes.has(id) || ghosts.has(id)) continue;
    const match = /^block:([^:]+):(.+)$/.exec(id);
    if (match && families.has(match[1])) ghosts.set(id, { id, family: match[1], name: match[2], ghost: true });
  }
  return [...ghosts.values()].sort((a, b) => order(a.id, b.id));
}

export function renderFamilyMap(graph) {
  if (!graph.families?.length) return '';
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const points = new Map();
  const unused = new Set((Array.isArray(graph.unused) ? graph.unused : []).filter((id) => nodes.get(id)?.kind === 'block'));
  const ghosts = ghostBlocks(graph, nodes);
  let y = 70, width = 1080;
  const floors = [...graph.families].sort((a, b) => (Number(a.floor) || 0) - (Number(b.floor) || 0)).map((family) => {
    const blocks = graph.nodes.filter((node) => node.kind === 'block' && node.family === family.id).sort((a, b) => order(a.id, b.id));
    const removed = ghosts.filter((ghost) => ghost.family === family.id);
    // map.groupBy: block nodes carry `group` only when it is configured; each cluster starts a new labelled row.
    const grouped = blocks.some((block) => Object.hasOwn(block, 'group'));
    const clusters = [];
    if (grouped) {
      const byGroup = new Map();
      for (const block of blocks) {
        const key = block.group == null ? null : String(block.group);
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key).push(block);
      }
      for (const key of [...byGroup.keys()].sort((a, b) => a === null ? 1 : b === null ? -1 : order(a, b))) clusters.push({ label: key ?? 'Ungrouped', items: byGroup.get(key) });
      if (removed.length) clusters.push({ label: 'Removed', items: removed, ghost: true });
    } else clusters.push({ label: null, items: [...blocks, ...removed] });
    const floorY = y, cells = [], labels = [];
    let row = 0, extra = 0;
    for (const cluster of clusters) {
      if (cluster.label !== null) {
        extra += 24;
        labels.push(`<text class="group-label" x="${275 + row * 35}" y="${floorY + 45 + row * 45 + extra - 28}"${cluster.ghost ? ' data-map-ghost-label="" hidden' : ''}>${escape(String(cluster.label).slice(0, 40))} · ${cluster.items.length}</text>`);
      }
      cluster.items.forEach((item, index) => cells.push({ item, row: row + Math.floor(index / 4), column: index % 4, extra }));
      row += Math.max(1, Math.ceil(cluster.items.length / 4));
    }
    const rows = Math.max(1, row), height = rows * 45 + extra + 80;
    width = Math.max(width, 810 + rows * 35 + 110);
    y += height + 70;
    const slabs = cells.map(({ item: block, row, column, extra }) => {
      const x = 275 + column * 130 + row * 35, top = floorY + 45 + row * 45 + extra;
      const shape = `<polygon class="family-block-slab" points="${x},${top} ${x + 65},${top - 22} ${x + 125},${top} ${x + 60},${top + 22}"/><text class="slab-label" x="${x + 60}" y="${top + 4}" text-anchor="middle">${escape(String(block.name || block.id).slice(0, 15))}</text>`;
      if (block.ghost) return `<g class="family-node family-ghost" data-map-ghost="${escape(block.id)}" data-map-search="${escape([block.name, block.id].join(' ').toLowerCase())}" hidden><title>${escape(block.name)} · ${escape(block.id)} · removed</title>${shape}</g>`;
      points.set(block.id, { x: x + 60, y: top });
      const isUnused = unused.has(block.id);
      return `<g class="family-node${isUnused ? ' unused' : ''}" tabindex="0" role="button" aria-label="Inspect ${escape(block.name)}${isUnused ? ' (unused)' : ''}" data-map-id="${escape(block.id)}" data-family-block="${escape(block.id)}" data-map-app="${escape(block.app ?? '')}"${grouped ? ` data-map-group="${escape(block.group ?? '')}"` : ''} data-map-search="${escape([block.name, block.id, block.description, block.path].join(' ').toLowerCase())}"><title>${escape(block.name)} · ${escape(block.id)}${isUnused ? ' · unused: no links or code reach it' : ''}</title>${shape}</g>`;
    }).join('');
    return `<g class="family-floor" data-family="${escape(family.id)}" data-floor="${Number(family.floor) || 0}"><text class="floor-title" x="20" y="${floorY + 18}">${escape(family.title || family.id)}</text><text class="floor-blurb" x="20" y="${floorY + 40}">${blocks.length} blocks</text><text class="floor-blurb" x="20" y="${floorY + 60}">${escape(String(family.blurb || '').slice(0, 34))}</text><polygon class="family-surface" points="240,${floorY} 810,${floorY} ${810 + rows * 35 + 75},${floorY + height} ${240 + rows * 35 + 75},${floorY + height}"/>${labels.join('')}${slabs}</g>`;
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
  // graph.codeReach uses the same (app ?? '', folder) key as these slabs.
  const reach = new Map();
  for (const entry of Array.isArray(graph.codeReach) ? graph.codeReach : []) {
    if (!entry || !points.has(entry.block)) continue;
    const key = `${entry.app ?? ''}\0${entry.folder}`;
    if (!groups.has(key)) continue;
    if (!reach.has(key)) reach.set(key, new Set());
    reach.get(key).add(entry.block);
  }
  const reachLines = [];
  const ordinary = [...groups].sort(([a], [b]) => order(a, b)).map(([key, group], index) => {
    const top = y + Math.floor(index / 3) * 65, x = 230 + index % 3 * 225;
    const reached = [...(reach.get(key) || [])].sort(order);
    const shape = `<title>${escape(group.files.map((file) => file.path).join('\n'))}${reached.length ? `\nReaches: ${escape(reached.map((id) => nodes.get(id)?.name || id).join(', '))}` : ''}</title><polygon class="ordinary-slab" points="${x},${top} ${x + 155},${top} ${x + 195},${top + 40} ${x + 40},${top + 40}"/><text class="slab-label" x="${x + 30}" y="${top + 16}">${escape(group.app || 'Outside apps')}</text><text class="slab-label" x="${x + 40}" y="${top + 32}">${escape(group.folder)} · ${group.files.length} files</text>`;
    if (!reached.length) return `<g class="ordinary-code" data-map-app="${escape(group.app)}" data-map-search="${escape(group.files.map((file) => file.path).join(' ').toLowerCase())}">${shape}</g>`;
    for (const block of reached) {
      const to = points.get(block), fromX = x + 97;
      reachLines.push(`<path class="reach-line" data-reach-source="${index}" data-reach-block="${escape(block)}" d="M${fromX} ${top} C${fromX} ${top - 90},${to.x} ${to.y + 112},${to.x} ${to.y + 22}" hidden/>`);
    }
    return `<g class="ordinary-code reaches" tabindex="0" role="button" aria-label="${escape(`${group.folder} reaches ${reached.length} ${reached.length === 1 ? 'block' : 'blocks'}`)}" data-map-reach="${index}" data-map-folder="${escape(group.folder)}" data-map-app="${escape(group.app)}" data-map-search="${escape(group.files.map((file) => file.path).join(' ').toLowerCase())}">${shape}<text class="reach-count" x="${x + 195}" y="${top - 5}" text-anchor="end">reaches ${reached.length} ${reached.length === 1 ? 'block' : 'blocks'}</text></g>`;
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
  const skins = renderMapSkins(graph.mapStyle);
  const skinToggle = skins.length > 1 ? `<div class="family-skins"><label for="family-skin">Skin</label><select id="family-skin" data-storage-key="${escape(mapStorageKey(graph, 'family-skin'))}">${skins.map((skin) => `<option value="${escape(skin.id)}">${escape(skin.id)}</option>`).join('')}</select></div>` : '';
  const unusedBlocks = [...unused].sort(order).map((id) => nodes.get(id));
  const keyParts = [
    ...(reach.size ? [`<span class="reach-key">${reach.size} code ${reach.size === 1 ? 'folder reaches' : 'folders reach'} blocks · hover or focus an outlined grey slab to light them</span>`] : []),
    ...(ghosts.length ? [`<span class="ghost-key">${ghosts.length} removed ${ghosts.length === 1 ? 'block appears' : 'blocks appear'} as ghost bricks when history is scrubbed back</span>`] : []),
    ...(unusedBlocks.length ? [`<span class="unused-key">${unusedBlocks.length} unused ${unusedBlocks.length === 1 ? 'block' : 'blocks'} (dashed)</span><details class="family-unused"><summary>Unused blocks · ${unusedBlocks.length}</summary><ul>${unusedBlocks.map((block) => `<li><button type="button" data-map-select="${escape(block.id)}">${escape(block.name || block.id)}</button> <small>${escape(block.family || '')}</small></li>`).join('')}</ul></details>`] : []),
  ];
  const mapKey = keyParts.length ? `<div class="family-map-key">${keyParts.join('')}</div>` : '';
  return `<section class="family-map" aria-label="Family map"${skins.length ? ` data-skin="${escape(skins[0].id)}"` : ''}><h2>Block families</h2>${skinToggle}${history.length ? `<div class="family-history"><label for="family-history">History</label><input id="family-history" type="range" min="0" max="${history.length}" value="${history.length}" data-storage-key="${escape(key)}"><output id="family-history-label">Current</output></div><p class="history-note">History shows which current blocks existed in the selected snapshot.${ghosts.length ? ' Removed blocks return as ghost bricks.' : ''}</p>` : ''}${mapKey}<div class="family-canvas"><svg class="family-scene" viewBox="0 0 ${width} ${height}" role="group" aria-label="Family floors and ordinary code">${floors}${links}${reachLines.join('')}<text class="floor-title" x="20" y="${y + 20}">Ordinary code</text>${ordinary}</svg></div><div class="family-evidence" id="family-evidence" hidden></div></section>`;
}

/** Shared browser controller; its source is inlined into generated documents. */
export function installFamilyMap(container, graph, { filters = () => ({ query: '', app: 'all' }), onSelect, onEdge, onChange } = {}) {
  const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const slider = container.querySelector('#family-history');
  const label = container.querySelector('#family-history-label');
  const skinSelect = container.querySelector('#family-skin');
  const history = graph.history || [];
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (slider) {
    try {
      const saved = localStorage.getItem(slider.dataset.storageKey);
      if (saved != null && Number.isInteger(Number(saved)) && Number(saved) >= 0 && Number(saved) <= history.length) slider.value = saved;
    } catch { /* Storage is optional when serving offline or under host policies. */ }
  }
  function applySkin() {
    if (!skinSelect) return;
    const root = container.ownerDocument || container;
    for (const style of root.querySelectorAll('style[data-map-skin]')) style.media = style.dataset.mapSkin === skinSelect.value ? 'all' : 'not all';
    const section = container.querySelector('.family-map');
    if (section) section.dataset.skin = skinSelect.value;
  }
  function changeSkin() { try { localStorage.setItem(skinSelect.dataset.storageKey, skinSelect.value); } catch {} applySkin(); }
  if (skinSelect) {
    try {
      const saved = localStorage.getItem(skinSelect.dataset.storageKey);
      if (saved != null && [...skinSelect.options].some((option) => option.value === saved)) skinSelect.value = saved;
    } catch { /* Storage is optional. */ }
    skinSelect.addEventListener('change', changeSkin);
    applySkin();
  }
  let lit = null;
  function clearReach() {
    lit = null;
    for (const item of container.querySelectorAll('.reach-lit')) item.classList.remove('reach-lit');
    for (const line of container.querySelectorAll('[data-reach-source]')) line.setAttribute('hidden', '');
  }
  function showReach(event) {
    const slab = event.target?.closest?.('[data-map-reach]');
    if (!slab || !container.contains(slab) || slab === lit) return;
    clearReach();
    lit = slab;
    for (const line of container.querySelectorAll(`[data-reach-source="${CSS.escape(slab.dataset.mapReach)}"]`)) {
      const block = container.querySelector(`[data-map-id="${CSS.escape(line.dataset.reachBlock)}"]`);
      if (!block || block.hasAttribute('hidden')) continue;
      block.classList.add('reach-lit');
      line.removeAttribute('hidden');
    }
  }
  function hideReach(event) {
    const slab = event.target?.closest?.('[data-map-reach]');
    if (slab && slab === lit && !(event.relatedTarget && slab.contains(event.relatedTarget))) clearReach();
  }
  const activeBlocks = () => !slider || Number(slider.value) === history.length ? null : new Set(history[Number(slider.value)]?.blocks || []);
  function update() {
    const snapshot = slider && history[Number(slider.value)];
    if (label) label.textContent = snapshot ? `${snapshot.date} · ${snapshot.label || 'Snapshot'}` : 'Current';
    const active = activeBlocks(), current = filters();
    const query = (current.query || '').toLowerCase();
    const app = current.app || 'all';
    const cross = app === 'cross' || app === 'cross-app';
    clearReach();
    for (const item of container.querySelectorAll('[data-family-block]')) {
      const matchApp = app === 'all' || cross || (app === 'outside' ? item.dataset.mapApp === '' : app === `app:${item.dataset.mapApp}`);
      const matchSearch = !(item.dataset.mapSearch || item.dataset.search || '').includes(query) ? !query : true;
      item.toggleAttribute('hidden', Boolean((active && !active.has(item.dataset.familyBlock)) || !matchApp || !matchSearch || cross));
    }
    for (const item of container.querySelectorAll('[data-map-ghost]')) item.toggleAttribute('hidden', !active || !active.has(item.dataset.mapGhost) || cross || !(item.dataset.mapSearch || '').includes(query));
    for (const item of container.querySelectorAll('[data-map-ghost-label]')) item.toggleAttribute('hidden', !active);
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
    const target = event.target.closest('[data-map-id], [data-map-edge], [data-map-select], [data-map-reach]');
    if (!target || !container.contains(target)) return;
    if (event.type === 'keydown') { if (!['Enter', ' '].includes(event.key)) return; event.preventDefault(); }
    const panel = container.querySelector('#family-evidence');
    if (target.dataset.mapEdge != null) {
      const index = Number(target.dataset.mapEdge), edge = graph.edges[index];
      if (onEdge) onEdge(index);
      else if (panel) { panel.hidden = false; panel.innerHTML = `<strong>${escapeText(edge.kind)}</strong><p>${escapeText(nodes.get(edge.from)?.name)} → ${escapeText(nodes.get(edge.to)?.name)}</p><p><code>${escapeText(edge.evidence?.file)}:${escapeText(edge.evidence?.line)}</code></p><pre>${escapeText(edge.evidence?.text)}</pre>`; }
    } else if (target.dataset.mapReach != null) {
      const entries = (graph.codeReach || []).filter((entry) => (entry.app ?? '') === target.dataset.mapApp && entry.folder === target.dataset.mapFolder);
      if (panel) { panel.hidden = false; panel.innerHTML = `<strong>${escapeText(target.dataset.mapFolder)}</strong><p>${escapeText(target.dataset.mapApp || 'Outside apps')} · reaches ${new Set(entries.map((entry) => entry.block)).size} blocks</p><ul>${entries.map((entry) => `<li>${escapeText(nodes.get(entry.block)?.name || entry.block)} <small>via ${escapeText(entry.via)}</small><br><code>${escapeText((entry.files || []).join(', '))}</code></li>`).join('')}</ul>`; }
    } else {
      const node = nodes.get(target.dataset.mapId ?? target.dataset.mapSelect);
      if (!node) return;
      if (onSelect) onSelect(node.id);
      else if (panel) { panel.hidden = false; panel.innerHTML = `<strong>${escapeText(node.name)}</strong><p>${escapeText(node.description)}</p><code>${escapeText(node.path || node.id)}</code>`; }
    }
  }
  container.addEventListener('click', activate);
  container.addEventListener('keydown', activate);
  container.addEventListener('pointerover', showReach);
  container.addEventListener('pointerout', hideReach);
  container.addEventListener('focusin', showReach);
  container.addEventListener('focusout', hideReach);
  update();
  function dispose() {
    container.removeEventListener('click', activate);
    container.removeEventListener('keydown', activate);
    container.removeEventListener('pointerover', showReach);
    container.removeEventListener('pointerout', hideReach);
    container.removeEventListener('focusin', showReach);
    container.removeEventListener('focusout', hideReach);
    slider?.removeEventListener('input', changeHistory);
    skinSelect?.removeEventListener('change', changeSkin);
  }
  return { update, activeBlocks, dispose };
}
