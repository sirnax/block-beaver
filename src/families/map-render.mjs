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
  const names = Object.keys(safe.tokens).sort(order);
  const tokens = names.map((name) => `--bb-${name}:${safe.tokens[name]}`).join(';');
  // `family-<id>` recolours that floor; the name is already a validated kebab-case token.
  const floors = names.filter((name) => name.startsWith('family-')).map((name) => `.family-floor[data-family="${name.slice(7)}"]{--fam:var(--bb-${name})}`).join('');
  return `${tokens ? `:root{${tokens}}\n` : ''}${floors ? `${floors}\n` : ''}${safe.css}`;
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

/** Floor colours by floor order (cycled); a `family-<id>` token overrides one floor. */
export const FAMILY_COLORS = ['#e0a33a', '#e0679f', '#ec8540', '#33b383', '#9a62d6', '#3d96d3', '#d65757', '#78a63a', '#2aa9ad', '#6b78d6'];

export const FAMILY_MAP_CSS = `
.family-map{--mono:var(--bb-mono-font,ui-monospace,SFMono-Regular,Menlo,monospace);--stage:var(--bb-map-stage,#fbfaf6);--ink:var(--bb-map-text,#203c46);margin:32px 0;padding:20px;background:var(--bb-map-background,#edf0ec);border:1px solid #cbd4d3;border-radius:12px;color:var(--ink);font-family:var(--bb-font-family,system-ui,sans-serif)}.family-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.family-map h2{font-size:24px;margin:0}.family-zoom{display:flex;gap:4px}.family-zoom button,.family-history button{font:600 12px/1 var(--mono);border:1px solid #b9c6c4;background:#fff;color:inherit;border-radius:99px;padding:8px 13px;cursor:pointer}.family-zoom button:hover,.family-history button:hover{background:#e3ebe9}.family-history{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0}.family-history label{margin:0}.family-history input{flex:1;min-width:180px;width:auto;padding:0}.family-history output{font-size:13px}.family-hint,.history-note{font-size:12px;color:#527078;margin:6px 0}.family-canvas{overflow:auto;margin-top:10px;border:1px solid #d3dad8;border-radius:10px;background:radial-gradient(rgba(32,60,70,.13) 1px,transparent 1.3px) 0 0/22px 22px var(--stage)}.family-scene{display:block;max-width:100%;min-width:600px;height:auto;margin:auto;user-select:none;-webkit-user-select:none}.family-scene.panning{cursor:grabbing}.family-scene [hidden]{display:none}.family-scene text{fill:var(--ink);font-family:var(--bb-font-family,system-ui,sans-serif)}.family-scene .mono{font-family:var(--mono);fill-opacity:.75}
.family-floor{--fam:#6b8c94}${FAMILY_COLORS.map((color, index) => `.fam-${index}{--fam:${color}}`).join('')}
.slab{fill:color-mix(in srgb,var(--fam) 9%,var(--bb-floor-surface,#fdfcf8));stroke:color-mix(in srgb,var(--fam) 70%,transparent);stroke-width:1.2;stroke-linejoin:round}.slab-edge{fill:color-mix(in srgb,var(--fam) 45%,#fff)}.slab-edge.side{fill:color-mix(in srgb,var(--fam) 62%,#4a5560)}.gridline{fill:none;stroke:color-mix(in srgb,var(--fam) 26%,transparent);stroke-width:.6}.tag-line{stroke:color-mix(in srgb,var(--fam) 60%,transparent);stroke-dasharray:1 3}.floor-tag path{fill:var(--fam)}.family-scene .floor-tag text{fill:var(--bb-tag-text,#13212a);font-family:var(--mono)}.floor-title{font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}.floor-count{font-size:17px;font-weight:600}.floor-blurb{font-size:10px;fill-opacity:.7}
.family-node{cursor:pointer;transition:opacity .2s;--edge:rgba(20,30,40,.28)}.family-node:focus{outline:none}.top,.l,.r,.stud{stroke:var(--side,none);stroke-width:var(--edge-w,.5);stroke-dasharray:var(--dash,none);fill-opacity:var(--fo,1);stroke-linejoin:round}.top{fill:var(--top,var(--bb-block-surface,var(--fam)));stroke:var(--edge)}.l{fill:var(--face,color-mix(in srgb,var(--fam) 80%,#1a2028))}.r,.stud.base{fill:var(--face,color-mix(in srgb,var(--fam) 60%,#1a2028))}.stud.cap{fill:var(--face,color-mix(in srgb,var(--fam) 86%,#fff));stroke:var(--edge)}.family-node:hover,.family-node.lit{--edge:#13212a;--edge-w:1}.family-node.sel{--edge-w:1.8}.family-node:focus-visible{--edge:var(--bb-focus,#1a6fd8);--edge-w:2}.family-node.reach-lit{--edge:var(--bb-reach-line,#c46b2b);--edge-w:1.6}.family-node.unused{--edge:var(--bb-unused-stroke,#a65969);--side:var(--edge);--dash:2 1.5;--fo:.5;--edge-w:.9}.family-ghost{opacity:.55;cursor:default;--face:transparent;--top:transparent;--edge:var(--bb-ghost-stroke,#7d8a8e);--side:var(--edge);--dash:2 1.5;--edge-w:.8}
.brick-label{font-size:6.5px;text-anchor:middle;pointer-events:none;paint-order:stroke;stroke:var(--stage);stroke-width:2px;stroke-linejoin:round;opacity:0;transition:opacity .15s}.family-node:hover .brick-label,.family-node:focus .brick-label,.family-node.lit .brick-label,.lod .brick-label,.few .brick-label{opacity:1}.lod .brick-label{font-size:5px}.lod .family-node:hover .brick-label,.lod .family-node.lit .brick-label{font-size:6.5px}.family-ghost .brick-label{font-style:italic}.dim .family-node:not(.lit){opacity:.14}.dim .conduits,.dim .ordinary-code:not(.lit){opacity:.3}.group-label{font-size:7.5px;font-weight:600;letter-spacing:.04em;text-anchor:end;pointer-events:none;paint-order:stroke;stroke:var(--stage);stroke-width:2.5px;stroke-linejoin:round}
.conduit{fill:none;stroke-width:1.3;stroke-dasharray:1 3;stroke-linecap:round}.conduit-label{font-size:9px;text-anchor:middle}.family-link{fill:none;stroke-width:1.6;stroke-linecap:round;stroke-dasharray:5 4;cursor:pointer;animation:bb-flow 1.1s linear infinite}.family-link.cross-app{stroke-dasharray:2 4}.family-link:focus,.family-link:hover{stroke-width:3;outline:none}@keyframes bb-flow{to{stroke-dashoffset:-18}}@media (prefers-reduced-motion:reduce){.family-link{animation:none}}
.rail-sub{font-size:10px}.rail-name{font-size:11px}.rail-count{font-size:10.5px}.rail-port{fill:#8b969a}.ordinary-code{pointer-events:bounding-box}.ordinary-slab{fill:var(--bb-ordinary-surface,rgba(32,60,70,.06));stroke:rgba(32,60,70,.45);stroke-dasharray:3 2.5}.reaches{cursor:pointer}.reaches:focus{outline:none}.reaches .ordinary-slab{fill:rgba(196,107,43,.13);stroke:var(--bb-reach-line,#c46b2b);stroke-dasharray:none}.reaches:focus .ordinary-slab,.reaches:hover .ordinary-slab,.ordinary-code.lit .ordinary-slab{stroke-width:2}.family-scene .reach-count{font-size:10.5px;font-weight:600;fill:var(--bb-reach-line,#c46b2b)}.reach-line{fill:none;stroke:var(--bb-reach-line,#c46b2b);stroke-width:1.4;stroke-dasharray:4 3;pointer-events:none}
.family-map-key{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;margin:12px 0}.family-evidence{margin-top:12px;padding:12px;background:#fff;border:1px solid #cbd4d3;border-radius:8px}.family-evidence pre{white-space:pre-wrap}.family-skins{display:flex;align-items:center;gap:8px;margin:12px 0}.family-skins select{width:auto;padding:6px 10px}.family-map-key details{flex-basis:100%}.family-map-key summary{cursor:pointer}.family-map-key ul{margin:6px 0;padding-left:20px;columns:2 220px}.family-map-key button{font:inherit;background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer}.unused-key{border-left:4px dashed var(--bb-unused-stroke,#a65969);padding-left:7px}.reach-key{border-left:4px solid var(--bb-reach-line,#c46b2b);padding-left:7px}.ghost-key{border-left:4px dotted #8b969a;padding-left:7px}
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

// Isometric world (SVG units): cell width/height, brick height, plate thickness, floor gap, plate padding in cells.
const TW = 34, TH = 17, BH = 12, SLAB = 7, GAP = 38, PAD = 0.7, BRICK = 0.8;
const TAG_X = 16, TAG_W = 176, TAG_H = 30, STEP = 16, ROW_H = 22, NAME_W = 200, BAR_MIN = 18, BAR_MAX = 120, COUNT_W = 64;
const f1 = (value) => String(Math.round(value * 10) / 10);
const pts = (list) => list.map(([x, y]) => `${f1(x)},${f1(y)}`).join(' ');
const iso = (ox, oy, gx, gy) => [ox + (gx - gy) * TW / 2, oy + (gx + gy) * TH / 2];
const gridFor = (n) => { const cols = Math.max(1, Math.ceil(Math.sqrt(n))); return { cols, rows: Math.max(1, Math.ceil(n / cols)) }; };
const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const BRICK_SHAPE = (() => {
  const a = TW / 2 * BRICK, b = TH / 2 * BRICK, h = BH;
  // Drawn once and placed with <use>; faces take their state from inherited custom properties.
  return `<defs><g id="bb-brick"><polygon class="l" points="${pts([[-a, -h], [0, -h + b], [0, b], [-a, 0]])}"/><polygon class="r" points="${pts([[a, -h], [0, -h + b], [0, b], [a, 0]])}"/><polygon class="top family-block-slab" points="${pts([[0, -h - b], [a, -h], [0, -h + b], [-a, -h]])}"/><ellipse class="stud base" cy="${f1(-h + 0.2)}" rx="4.6" ry="2.3"/><ellipse class="stud cap" cy="${f1(-h - 2.2)}" rx="4.6" ry="2.3"/></g></defs>`;
})();

/** Pack each cluster as a near-square box, shelf by shelf, one empty cell apart; keep the floor near square. */
function packFloor(clusters) {
  const boxes = clusters.map((cluster) => ({ cluster, ...gridFor(cluster.items.length) }));
  const shelve = (width, place) => {
    let x = 0, y = 0, shelf = 0, cols = 0;
    for (const box of boxes) {
      if (x && x + box.cols > width) { x = 0; y += shelf + 1; shelf = 0; }
      place?.(box, x, y);
      x += box.cols + 1; shelf = Math.max(shelf, box.rows); cols = Math.max(cols, x - 1);
    }
    return { cols, rows: y + shelf };
  };
  const widest = Math.max(...boxes.map((box) => box.cols)), total = boxes.reduce((sum, box) => sum + box.cols + 1, -1);
  // A layout packed at width w is the same layout packed at its own column count, so widths past the best size never win.
  let best;
  for (let width = widest; width <= total && !(best && width > best.size); width++) {
    const { cols, rows } = shelve(width), size = Math.max(cols, rows), area = cols * rows;
    if (!best || size < best.size || (size === best.size && area < best.area)) best = { cols, rows, size, area, width };
  }
  const placed = [];
  shelve(best.width, (box, x, y) => placed.push({ ...box, x, y }));
  return { cols: best.cols, rows: best.rows, boxes: placed };
}

export function renderFamilyMap(graph, { edges = graph.edges } = {}) {
  if (!graph.families?.length) return '';
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const points = new Map(), floorOf = new Map();
  const unused = new Set((Array.isArray(graph.unused) ? graph.unused : []).filter((id) => nodes.get(id)?.kind === 'block'));
  const ghosts = ghostBlocks(graph, nodes);
  const families = [...graph.families].sort((a, b) => (Number(a.floor) || 0) - (Number(b.floor) || 0));
  const plans = families.map((family, index) => {
    const blocks = graph.nodes.filter((node) => node.kind === 'block' && node.family === family.id).sort((a, b) => order(a.id, b.id));
    const removed = ghosts.filter((ghost) => ghost.family === family.id);
    // map.groupBy: block nodes carry `group` only when it is configured; each cluster is its own labelled box.
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
    for (const block of blocks) floorOf.set(block.id, index);
    return { family, index, blocks, grouped, clusters, few: blocks.length + removed.length <= 2, ...packFloor(clusters) };
  });
  // Conduits: one riser per (from floor, to floor, kind) with at least one drawn link.
  const conduitCount = new Map();
  for (const edge of edges) {
    if (!edge.link || !floorOf.has(edge.from) || !floorOf.has(edge.to)) continue;
    const key = JSON.stringify([floorOf.get(edge.from), floorOf.get(edge.to), String(edge.kind)]);
    conduitCount.set(key, (conduitCount.get(key) || 0) + 1);
  }
  const pairs = [...conduitCount].map(([key, count]) => [...JSON.parse(key), count]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || order(a[2], b[2]));
  const towerW = Math.max(...plans.map((plan) => (plan.cols + plan.rows + 4 * PAD) * TW / 2));
  const CX = TAG_X + TAG_W + 30 + pairs.length * STEP + 30 + towerW / 2;
  let y = 40;
  for (const plan of plans) {
    plan.ox = CX - (plan.cols - plan.rows) * TW / 4;
    plan.oy = y + BH + 14 + PAD * TH;
    plan.midY = plan.oy + (plan.cols + plan.rows) * TH / 4;
    y += (plan.cols + plan.rows + 4 * PAD) * TH / 2 + SLAB + BH + 14 + GAP;
  }
  const towerBottom = y - GAP;
  const floors = plans.map(({ family, index, blocks, grouped, boxes, cols, rows, ox, oy, midY, few }) => {
    const at = (gx, gy) => iso(ox, oy, gx, gy);
    const c = [at(-PAD, -PAD), at(cols + PAD, -PAD), at(cols + PAD, rows + PAD), at(-PAD, rows + PAD)];
    const down = ([x, y]) => [x, y + SLAB];
    const grid = [...Array.from({ length: cols - 1 }, (_, i) => [at(i + 1, -PAD / 2), at(i + 1, rows + PAD / 2)]), ...Array.from({ length: rows - 1 }, (_, j) => [at(-PAD / 2, j + 1), at(cols + PAD / 2, j + 1)])].map(([p, q]) => `M${f1(p[0])} ${f1(p[1])}L${f1(q[0])} ${f1(q[1])}`).join('');
    const labels = [];
    const bricks = boxes.map(({ cluster, cols: boxCols, x: bx, y: by, rows: boxRows }) => {
      if (cluster.label !== null) {
        const [lx, ly] = at(bx, by + boxRows);
        labels.push(`<text class="group-label" x="${f1(lx - 5)}" y="${f1(ly + 3)}"${cluster.ghost ? ' data-map-ghost-label="" hidden' : ''}>${escape(String(cluster.label).slice(0, 40))} · ${cluster.items.length}</text>`);
      }
      // Back to front inside the box, so nearer bricks overlap farther ones.
      const cells = cluster.items.map((item, i) => ({ item, gx: bx + i % boxCols, gy: by + Math.floor(i / boxCols) })).sort((p, q) => (p.gx + p.gy) - (q.gx + q.gy) || p.gx - q.gx);
      return cells.map(({ item: block, gx, gy }) => {
        const [x, top] = at(gx + 0.5, gy + 0.5);
        const shape = `<use href="#bb-brick" x="${f1(x)}" y="${f1(top)}"/><text class="brick-label" x="${f1(x)}" y="${f1(top - BH - 10)}">${escape(clip(String(block.name || block.id), 24))}</text>`;
        if (block.ghost) return `<g class="family-node family-ghost" data-map-ghost="${escape(block.id)}" data-map-search="${escape([block.name, block.id].join(' ').toLowerCase())}" hidden><title>${escape(block.name)} · ${escape(block.id)} · removed</title>${shape}</g>`;
        points.set(block.id, { x, y: top - BH - 7 });
        const isUnused = unused.has(block.id);
        return `<g class="family-node${isUnused ? ' unused' : ''}" tabindex="0" role="button" aria-label="Inspect ${escape(block.name)}${isUnused ? ' (unused)' : ''}" data-map-id="${escape(block.id)}" data-family-block="${escape(block.id)}" data-map-app="${escape(block.app ?? '')}"${grouped ? ` data-map-group="${escape(block.group ?? '')}"` : ''} data-map-search="${escape([block.name, block.id, block.description, block.path].join(' ').toLowerCase())}"><title>${escape(block.name)} · ${escape(block.id)}${block.group != null ? ` · ${escape(block.group)}` : ''}${isUnused ? ' · unused: no links or code reach it' : ''}</title>${shape}</g>`;
      }).join('');
    }).join('');
    const title = String(family.title || family.id), ty = Math.round(midY - TAG_H / 2);
    const tag = `<g class="floor-tag"><title>${escape(title)}${family.blurb ? ` · ${escape(family.blurb)}` : ''}</title><path d="M${TAG_X + TAG_H / 2} ${ty}h${TAG_W - TAG_H / 2}v${TAG_H}h${-(TAG_W - TAG_H / 2)}a${TAG_H / 2} ${TAG_H / 2} 0 0 1 0 ${-TAG_H}z"/><text class="floor-title" x="${TAG_X + 18}" y="${ty + 19}">${escape(clip(title, 20))}</text><text class="floor-count" x="${TAG_X + TAG_W - 10}" y="${ty + 21}" text-anchor="end">${blocks.length}</text></g>${family.blurb ? `<text class="floor-blurb" x="${TAG_X + 18}" y="${ty + TAG_H + 13}">${escape(clip(String(family.blurb), 34))}</text>` : ''}`;
    return `<g class="family-floor fam-${index % FAMILY_COLORS.length}${few ? ' few' : ''}" data-family="${escape(family.id)}" data-floor="${Number(family.floor) || 0}"><line class="tag-line" x1="${TAG_X + TAG_W}" y1="${f1(midY)}" x2="${f1(c[3][0] - 8)}" y2="${f1(midY)}"/><polygon class="slab-edge" points="${pts([c[3], c[2], down(c[2]), down(c[3])])}"/><polygon class="slab-edge side" points="${pts([c[2], c[1], down(c[1]), down(c[2])])}"/><polygon class="slab family-surface" points="${pts(c)}"/>${grid ? `<path class="gridline" d="${grid}"/>` : ''}${bricks}${labels.join('')}${tag}</g>`;
  }).join('');
  const kindColor = (kind) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(kind) ? `var(--bb-link-${kind},${linkColor(kind)})` : linkColor(kind);
  const baseX = CX - towerW / 2 - 30;
  const conduits = pairs.map(([from, to, kind, count], index) => {
    const x = baseX - index * STEP;
    let a = plans[from].midY, b = plans[to].midY;
    if (a === b) { a -= 10; b += 10; }
    const mid = f1((a + b) / 2), lx = f1(x - 4);
    return `<g class="conduit-pair" data-kind="${escape(kind)}"><title>${count} ${escape(kind)} ${count === 1 ? 'link' : 'links'}: ${escape(plans[from].family.title || plans[from].family.id)} → ${escape(plans[to].family.title || plans[to].family.id)}</title><path class="conduit" stroke="${escape(kindColor(kind))}" d="M${f1(x + 6)} ${f1(a)}H${f1(x)}V${f1(b)}H${f1(x + 6)}"/><text class="conduit-label mono" x="${lx}" y="${mid}" transform="rotate(-90 ${lx} ${mid})">${count} ${escape(kind)}</text></g>`;
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
  // graph.codeReach uses the same (app ?? '', folder) key as these rows.
  const reach = new Map();
  for (const entry of Array.isArray(graph.codeReach) ? graph.codeReach : []) {
    if (!entry || !points.has(entry.block)) continue;
    const key = `${entry.app ?? ''}\0${entry.folder}`;
    if (!groups.has(key)) continue;
    if (!reach.has(key)) reach.set(key, new Set());
    reach.get(key).add(entry.block);
  }
  // The rail: ordinary code by folder, widest reach first, then most files.
  const rows = [...groups].map(([key, group]) => ({ key, group, reached: [...(reach.get(key) || [])].sort(order) })).sort((a, b) => b.reached.length - a.reached.length || b.group.files.length - a.group.files.length || order(a.key, b.key));
  const manyApps = new Set(rows.map((row) => row.group.app)).size > 1;
  const mostFiles = Math.max(1, ...rows.map((row) => row.group.files.length));
  const RAIL_X = CX + towerW / 2 + 70;
  const railTop = Math.round(Math.max(70, 40 + (towerBottom - 40 - rows.length * ROW_H) / 2));
  const reachLines = [];
  const ordinary = rows.map(({ group, reached }, index) => {
    const top = railTop + index * ROW_H, w = BAR_MIN + (BAR_MAX - BAR_MIN) * group.files.length / mostFiles, port = [RAIL_X - 10, top + 7];
    const name = `${manyApps ? `${group.app || 'outside'} · ` : ''}${group.folder}`;
    const shape = `<title>${escape(group.app || 'Outside apps')} · ${escape(group.folder)} · ${group.files.length} ${group.files.length === 1 ? 'file' : 'files'}${reached.length ? `\nReaches: ${escape(reached.map((id) => nodes.get(id)?.name || id).join(', '))}` : ''}</title>${reached.length ? `<circle class="rail-port" cx="${f1(port[0])}" cy="${port[1]}" r="2.5"/>` : ''}<text class="rail-name" x="${f1(RAIL_X)}" y="${top + 11}">${escape(name.length > 34 ? `…${name.slice(-33)}` : name)}</text><path class="ordinary-slab" d="M${f1(RAIL_X + NAME_W + 7)} ${top}h${f1(w - 14)}a7 7 0 0 1 0 14h${f1(14 - w)}a7 7 0 0 1 0-14z"/><text class="rail-count mono" x="${f1(RAIL_X + NAME_W + w + 8)}" y="${top + 11}">${group.files.length} ${group.files.length === 1 ? 'file' : 'files'}</text>`;
    if (!reached.length) return `<g class="ordinary-code" data-map-app="${escape(group.app)}" data-map-search="${escape(group.files.map((file) => file.path).join(' ').toLowerCase())}">${shape}</g>`;
    for (const block of reached) {
      const to = points.get(block), mx = (port[0] + to.x) / 2;
      reachLines.push(`<path class="reach-line" data-reach-source="${index}" data-reach-block="${escape(block)}" d="M${f1(port[0])} ${f1(port[1])}C${f1(mx)} ${f1(port[1])},${f1(to.x + 40)} ${f1(to.y - 30)},${f1(to.x)} ${f1(to.y)}" hidden/>`);
    }
    return `<g class="ordinary-code reaches" tabindex="0" role="button" aria-label="${escape(`${group.folder} reaches ${reached.length} ${reached.length === 1 ? 'block' : 'blocks'}`)}" data-map-reach="${index}" data-map-folder="${escape(group.folder)}" data-map-app="${escape(group.app)}" data-map-search="${escape(group.files.map((file) => file.path).join(' ').toLowerCase())}">${shape}<text class="reach-count" x="${f1(RAIL_X + NAME_W + BAR_MAX + COUNT_W)}" y="${top + 11}">reaches ${reached.length} ${reached.length === 1 ? 'block' : 'blocks'}</text></g>`;
  }).join('');
  const rail = `<g class="grey-rail"><text class="floor-title" x="${Math.round(RAIL_X)}" y="${railTop - 28}">Ordinary code</text><text class="rail-sub mono" x="${f1(RAIL_X)}" y="${railTop - 14}">${rows.length ? 'Not blocks yet · source files by folder' : 'No source files outside blocks'}</text>${ordinary}</g>`;
  // Individual links are drawn hidden; the controller shows those of the selected brick.
  const links = edges.flatMap((edge, index) => {
    if (!edge.link || !points.has(edge.from) || !points.has(edge.to)) return [];
    const from = points.get(edge.from), to = points.get(edge.to);
    const bend = Math.min(130, 24 + Math.abs(from.y - to.y) * 0.2), side = from.x <= CX ? -1 : 1;
    return [`<path class="family-link${edge.crossApp ? ' cross-app' : ''}" data-map-edge="${index}" data-map-from="${escape(edge.from)}" data-map-to="${escape(edge.to)}" data-map-app="${escape(nodes.get(edge.from)?.app ?? '')}" tabindex="0" role="button" aria-label="Show ${escape(edge.kind)} connection evidence" stroke="${escape(kindColor(edge.kind))}" d="M${f1(from.x)} ${f1(from.y)}C${f1(from.x + side * bend)} ${f1(from.y)},${f1(to.x + side * bend)} ${f1(to.y)},${f1(to.x)} ${f1(to.y)}" hidden><title>${escape(edge.kind)}: ${escape(nodes.get(edge.from)?.name)} → ${escape(nodes.get(edge.to)?.name)}</title></path>`];
  }).join('');
  const width = Math.ceil(RAIL_X + NAME_W + BAR_MAX + COUNT_W + (reach.size ? 110 : 0));
  const height = Math.ceil(Math.max(towerBottom, railTop + rows.length * ROW_H) + 30);
  const history = graph.history || [];
  const key = mapStorageKey(graph, 'family-history');
  const skins = renderMapSkins(graph.mapStyle);
  const skinToggle = skins.length > 1 ? `<div class="family-skins"><label for="family-skin">Skin</label><select id="family-skin" data-storage-key="${escape(mapStorageKey(graph, 'family-skin'))}">${skins.map((skin) => `<option value="${escape(skin.id)}">${escape(skin.id)}</option>`).join('')}</select></div>` : '';
  const unusedBlocks = [...unused].sort(order).map((id) => nodes.get(id));
  const keyParts = [
    ...(reach.size ? [`<span class="reach-key">${reach.size} code ${reach.size === 1 ? 'folder reaches' : 'folders reach'} blocks · hover or focus an outlined grey bar to light them</span>`] : []),
    ...(ghosts.length ? [`<span class="ghost-key">${ghosts.length} removed ${ghosts.length === 1 ? 'block appears' : 'blocks appear'} as ghost bricks when history is scrubbed back</span>`] : []),
    ...(unusedBlocks.length ? [`<span class="unused-key">${unusedBlocks.length} unused ${unusedBlocks.length === 1 ? 'block' : 'blocks'} (dashed)</span><details class="family-unused"><summary>Unused blocks · ${unusedBlocks.length}</summary><ul>${unusedBlocks.map((block) => `<li><button type="button" data-map-select="${escape(block.id)}">${escape(block.name || block.id)}</button> <small>${escape(block.family || '')}</small></li>`).join('')}</ul></details>`] : []),
  ];
  const mapKey = keyParts.length ? `<div class="family-map-key">${keyParts.join('')}</div>` : '';
  const zoom = '<div class="family-zoom" role="group" aria-label="Zoom"><button type="button" data-map-zoom="out" aria-label="Zoom out">−</button><button type="button" data-map-zoom="fit">Fit</button><button type="button" data-map-zoom="in" aria-label="Zoom in">+</button></div>';
  return `<section class="family-map" aria-label="Family map"${skins.length ? ` data-skin="${escape(skins[0].id)}"` : ''}><div class="family-head"><h2>Block families</h2>${zoom}</div>${skinToggle}${history.length ? `<div class="family-history"><button type="button" id="family-history-play">Play</button><label for="family-history">History</label><input id="family-history" type="range" min="0" max="${history.length}" value="${history.length}" data-storage-key="${escape(key)}"><output id="family-history-label">Current</output></div><p class="history-note">History shows which current blocks existed in the selected snapshot.${ghosts.length ? ' Removed blocks return as ghost bricks.' : ''}</p>` : ''}${mapKey}<p class="family-hint">One floor per family, one brick per block. Select a brick to light its links; Ctrl or ⌘ with the scroll wheel zooms, and dragging pans when zoomed in.</p><div class="family-canvas"><svg class="family-scene" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="Family floors and ordinary code">${BRICK_SHAPE}<g class="conduits">${conduits}</g>${floors}${rail}${links}${reachLines.join('')}</svg></div><div class="family-evidence" id="family-evidence" hidden></div></section>`;
}

/** Shared browser controller; its source is inlined into generated documents. */
export function installFamilyMap(container, graph, { filters = () => ({ query: '', app: 'all' }), onSelect, onEdge, onChange } = {}) {
  const cssEscape = (value) => typeof CSS === 'undefined' ? String(value).replace(/["\\]/g, '\\$&') : CSS.escape(value);
  const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const slider = container.querySelector('#family-history');
  const label = container.querySelector('#family-history-label');
  const skinSelect = container.querySelector('#family-skin');
  const playButton = container.querySelector('#family-history-play');
  const scene = container.querySelector('.family-scene');
  const history = graph.history || [];
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let selected = null, timer = null, drag = null, dragged = false;
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
    applySkin();
  }
  /* The camera moves the SVG viewBox (an attribute, so strict CSP holds); labels show once zoomed in. */
  const world = typeof scene?.getAttribute === 'function' ? String(scene.getAttribute('viewBox') || '').split(' ').map(Number) : [];
  let view = world.length === 4 ? [...world] : null;
  function setView(next) {
    if (!view) return;
    const w = Math.min(world[2], Math.max(world[2] / 12, next[2])), h = w * world[3] / world[2];
    const x = Math.min(world[0] + world[2] - w, Math.max(world[0], next[0] + (next[2] - w) / 2)), y = Math.min(world[1] + world[3] - h, Math.max(world[1], next[1] + (next[3] - h) / 2));
    view = [x, y, w, h];
    scene.setAttribute('viewBox', view.map((value) => Math.round(value * 10) / 10).join(' '));
    if (world[2] / w >= 2) scene.classList.add('lod'); else scene.classList.remove('lod');
  }
  function zoom(factor, fx = 0.5, fy = 0.5) {
    if (!view) return;
    const w = view[2] / factor, h = view[3] / factor;
    setView([view[0] + (view[2] - w) * fx, view[1] + (view[3] - h) * fy, w, h]);
  }
  function wheel(event) {
    if (!view || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const box = scene.getBoundingClientRect();
    zoom(Math.exp(-Math.max(-60, Math.min(60, event.deltaY)) * 0.01), (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
  }
  function press(event) {
    dragged = false;
    if (!view || view[2] >= world[2] || event.button !== 0 || event.target?.closest?.('[data-map-id], [data-map-edge], [data-map-reach]')) return;
    drag = { x: event.clientX, y: event.clientY, view: [...view], box: scene.getBoundingClientRect() };
    scene.setPointerCapture?.(event.pointerId);
  }
  function pan(event) {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    dragged = true;
    scene.classList.add('panning');
    setView([drag.view[0] - dx * drag.view[2] / drag.box.width, drag.view[1] - dy * drag.view[3] / drag.box.height, drag.view[2], drag.view[3]]);
  }
  function release() { drag = null; scene?.classList.remove('panning'); }
  /* Selection lights the selected brick, its linked bricks, its links and the code folders that reach it. */
  function paintReach() {
    if (!selected) return;
    const block = container.querySelector(`[data-map-id="${cssEscape(selected)}"]`);
    if (!block || block.hasAttribute('hidden')) return;
    for (const line of container.querySelectorAll('[data-reach-block]')) {
      const row = line.dataset.reachBlock === selected && container.querySelector(`[data-map-reach="${cssEscape(line.dataset.reachSource)}"]`);
      if (!row || row.hasAttribute('hidden')) continue;
      line.removeAttribute('hidden');
      row.classList.add('lit');
    }
  }
  function paint() {
    for (const item of container.querySelectorAll('.lit')) item.classList.remove('lit');
    for (const item of container.querySelectorAll('.sel')) item.classList.remove('sel');
    if (!selected) { scene?.classList.remove('dim'); return; }
    scene?.classList.add('dim');
    const light = (id) => container.querySelector(`[data-map-id="${cssEscape(id)}"]`)?.classList.add('lit');
    container.querySelector(`[data-map-id="${cssEscape(selected)}"]`)?.classList.add('sel');
    light(selected);
    for (const path of container.querySelectorAll('[data-map-edge]')) {
      if (path.dataset.mapFrom !== selected && path.dataset.mapTo !== selected) continue;
      path.classList.add('lit');
      light(path.dataset.mapFrom === selected ? path.dataset.mapTo : path.dataset.mapFrom);
    }
    paintReach();
  }
  let lit = null;
  function clearReach() {
    lit = null;
    for (const item of container.querySelectorAll('.reach-lit')) item.classList.remove('reach-lit');
    for (const line of container.querySelectorAll('[data-reach-source]')) line.setAttribute('hidden', '');
    paintReach();
  }
  function showReach(event) {
    const slab = event.target?.closest?.('[data-map-reach]');
    if (!slab || !container.contains(slab) || slab === lit) return;
    clearReach();
    lit = slab;
    for (const line of container.querySelectorAll(`[data-reach-source="${cssEscape(slab.dataset.mapReach)}"]`)) {
      const block = container.querySelector(`[data-map-id="${cssEscape(line.dataset.reachBlock)}"]`);
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
    for (const item of container.querySelectorAll('[data-family-block]')) {
      const matchApp = app === 'all' || cross || (app === 'outside' ? item.dataset.mapApp === '' : app === `app:${item.dataset.mapApp}`);
      const matchSearch = !(item.dataset.mapSearch || item.dataset.search || '').includes(query) ? !query : true;
      item.toggleAttribute('hidden', Boolean((active && !active.has(item.dataset.familyBlock)) || !matchApp || !matchSearch || cross));
    }
    /* A selection the history step or filters hide is dropped, so nothing stays dimmed around a missing brick. */
    if (selected && container.querySelector(`[data-map-id="${cssEscape(selected)}"]`)?.hasAttribute('hidden') !== false) selected = null;
    for (const item of container.querySelectorAll('[data-map-ghost]')) item.toggleAttribute('hidden', !active || !active.has(item.dataset.mapGhost) || cross || !(item.dataset.mapSearch || '').includes(query));
    for (const item of container.querySelectorAll('[data-map-ghost-label]')) item.toggleAttribute('hidden', !active);
    for (const item of container.querySelectorAll('.ordinary-code')) item.toggleAttribute('hidden', cross || (app !== 'all' && (app === 'outside' ? item.dataset.mapApp !== '' : app !== `app:${item.dataset.mapApp}`)) || !item.dataset.mapSearch.includes(query));
    clearReach();
    for (const path of container.querySelectorAll('[data-map-edge]')) {
      const edge = graph.edges[Number(path.dataset.mapEdge)];
      const from = container.querySelector(`[data-map-id="${cssEscape(path.dataset.mapFrom)}"]`);
      const to = container.querySelector(`[data-map-id="${cssEscape(path.dataset.mapTo)}"]`);
      const historyHidden = active && (!active.has(path.dataset.mapFrom) || !active.has(path.dataset.mapTo));
      const endpointMatch = !query || [nodes.get(path.dataset.mapFrom), nodes.get(path.dataset.mapTo)].some((node) => `${node?.name} ${node?.id} ${node?.path} ${node?.description}`.toLowerCase().includes(query));
      const linked = selected && (path.dataset.mapFrom === selected || path.dataset.mapTo === selected);
      path.toggleAttribute('hidden', Boolean(historyHidden || !endpointMatch || (cross ? !edge.crossApp : !linked || from?.hasAttribute('hidden') || to?.hasAttribute('hidden'))));
    }
    for (const item of container.querySelectorAll('[data-map-history-from]')) {
      const from = nodes.get(item.dataset.mapHistoryFrom), to = nodes.get(item.dataset.mapHistoryTo);
      const hidden = active && ((from?.kind === 'block' && !active.has(from.id)) || (to?.kind === 'block' && !active.has(to.id)));
      item.toggleAttribute('hidden', Boolean(hidden || !(item.dataset.mapSearch || item.dataset.search || '').includes(query)));
    }
    paint();
    const panel = container.querySelector('#family-evidence');
    if (panel) panel.hidden = true;
    if (onChange) onChange(active);
    return active;
  }
  function changeHistory() { stop(); try { localStorage.setItem(slider.dataset.storageKey, Number(slider.value) === history.length ? 'current' : slider.value); } catch {} update(); }
  function stop() { clearInterval(timer); timer = null; if (playButton) playButton.textContent = 'Play'; }
  function play() {
    if (!slider || timer) { stop(); return; }
    if (Number(slider.value) >= history.length) slider.value = '0';
    playButton.textContent = 'Pause';
    update();
    timer = setInterval(() => {
      if (Number(slider.value) >= history.length) { stop(); return; }
      slider.value = String(Number(slider.value) + 1);
      update();
    }, 800);
  }
  function activate(event) {
    if (event.type === 'click' && dragged) { dragged = false; return; }
    const target = event.target.closest('[data-map-id], [data-map-edge], [data-map-select], [data-map-reach], [data-map-zoom]');
    if (!target || !container.contains(target)) {
      if (selected && (event.key === 'Escape' || (event.type === 'click' && event.target.closest('.family-scene')))) { selected = null; update(); }
      return;
    }
    if (target.dataset.mapZoom != null) {
      if (event.type === 'click') { if (target.dataset.mapZoom === 'fit') setView([...world]); else zoom(target.dataset.mapZoom === 'in' ? 1.4 : 1 / 1.4); }
      return;
    }
    if (event.type === 'keydown') { if (event.key === 'Escape' && selected) { selected = null; update(); return; } if (!['Enter', ' '].includes(event.key)) return; event.preventDefault(); }
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
      if (node.kind === 'block') { selected = node.id; update(); }
      if (onSelect) onSelect(node.id);
      else if (panel) { panel.hidden = false; panel.innerHTML = `<strong>${escapeText(node.name)}</strong><p>${escapeText(node.description)}</p><code>${escapeText(node.path || node.id)}</code>`; }
    }
  }
  const bindings = [[container, 'click', activate], [container, 'keydown', activate], [container, 'pointerover', showReach], [container, 'pointerout', hideReach], [container, 'focusin', showReach], [container, 'focusout', hideReach], [slider, 'input', changeHistory], [skinSelect, 'change', changeSkin], [playButton, 'click', play], [scene, 'wheel', wheel], [scene, 'pointerdown', press], [scene, 'pointermove', pan], [scene, 'pointerup', release], [scene, 'pointercancel', release]].filter(([target]) => target);
  for (const [target, type, listener] of bindings) target.addEventListener(type, listener, type === 'wheel' ? { passive: false } : undefined);
  update();
  function dispose() { stop(); for (const [target, type, listener] of bindings) target.removeEventListener(type, listener); }
  return { update, activeBlocks, dispose };
}
