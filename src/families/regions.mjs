import { posix } from 'node:path';

/**
 * Region outputs: a generator owns the lines between two whole-line markers in a hand-edited
 * file, written in that file's comment style. Region markers never match the managed
 * `block-beaver:start/end` sections, and a region that overlaps a managed section is unsafe.
 * In Markdown, lines inside fenced code blocks are examples and never count as markers.
 */
export const regionIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const lineComment = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);
const htmlComment = new Set(['.md', '.html', '.htm']);
const anyRegionMarker = /^\s*(?:<!--|\/\/|\/\*)\s*\/?block-beaver:region(?:\s|$)/;
// The exact tokens the managed-section parsers (managed-files.mjs sectionBounds, project-integration.mjs
// managedSection, the `#` form for ignore and hook files) recognise anywhere in a file, as [start, end].
const managedPairs = [['<!-- block-beaver:start -->', '<!-- block-beaver:end -->'], ['# block-beaver:start', '# block-beaver:end']];
const hasManagedToken = (text) => managedPairs.some((pair) => pair.some((token) => text.includes(token)));
/** A span overlaps managed content when it holds a token or starts while a managed section is open. */
function overlapsManaged(text, from, to) {
  if (hasManagedToken(text.slice(from, to))) return true;
  const before = text.slice(0, from);
  return managedPairs.some(([start, end]) => before.lastIndexOf(start) > before.lastIndexOf(end));
}

export const regionStyles = '.md .html .htm .js .mjs .cjs .jsx .ts .mts .cts .tsx .css';
export function regionStyle(path) {
  const extension = posix.extname(path).toLowerCase();
  return lineComment.has(extension) ? 'line' : extension === '.css' ? 'block' : htmlComment.has(extension) ? 'html' : null;
}

export function regionMarkers(style, id) {
  const wrap = (text) => style === 'line' ? `// ${text}` : style === 'block' ? `/* ${text} */` : `<!-- ${text} -->`;
  return { start: wrap(`block-beaver:region ${id}`), end: wrap(`/block-beaver:region ${id}`) };
}

const lf = (text) => text.replace(/\r\n?/g, '\n');
const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
/** A region body compares and hashes with LF endings and no final newline. */
const canonical = (text) => lf(text).replace(/\n$/, '');
// Any indentation, then a chain of list (`-`, `*`, `+`, `1.`, `1)`) and blockquote (`>`) container markers.
// This errs towards seeing a fence: a hidden marker only makes gen refuse, a missed fence could overwrite an example.
const container = String.raw`^\s*(?:(?:[-*+]|\d{1,9}[.)]|>)\s*)*`;
const fence = new RegExp(`${container}(\`{3,}|~{3,})(.*)$`), fenceClose = new RegExp(`${container}(\`{3,}|~{3,})\\s*$`);
/**
 * CommonMark-style fences, top level or inside list items and blockquotes: ``` or ~~~ with an info
 * string, closed by a bare run of the same character at least as long; an open fence runs to the end.
 * Marker discovery, nesting checks, splicing and generated-content checks all use this one parser.
 */
function fencedLines(lines) {
  const fenced = new Set();
  let open = null;
  lines.forEach((line, index) => {
    const text = line.replace(/\r?\n$/, '');
    if (open) {
      fenced.add(index);
      const close = text.match(fenceClose);
      if (close && close[1][0] === open[0] && close[1].length >= open.length) open = null;
      return;
    }
    const match = text.match(fence);
    if (match && !(match[1][0] === '`' && match[2].includes('`'))) { open = match[1]; fenced.add(index); }
  });
  return { fenced, open: open !== null };
}
const markdown = (out) => posix.extname(out).toLowerCase() === '.md';

function locate(text, out, id) {
  const lines = linesOf(text), { start, end } = regionMarkers(regionStyle(out), id);
  const markers = `${start} … ${end}`;
  const { fenced } = markdown(out) ? fencedLines(lines) : { fenced: new Set() };
  const starts = [], ends = [];
  lines.forEach((line, index) => { if (fenced.has(index)) return; if (line.trim() === start) starts.push(index); else if (line.trim() === end) ends.push(index); });
  if (!starts.length || !ends.length) return { code: 'region-missing', message: `${out} has no ${starts.length ? 'end' : 'start'} marker for region ${id}; add the whole lines ${markers}` };
  if (starts.length > 1 || ends.length > 1) return { code: 'region-duplicate', message: `${out} marks region ${id} more than once; keep exactly one ${markers} pair` };
  const [first] = starts, [last] = ends;
  if (last < first) return { code: 'region-duplicate', message: `${out} has the end marker of region ${id} before its start marker` };
  if (lines.slice(first + 1, last).some((line, offset) => !fenced.has(first + 1 + offset) && anyRegionMarker.test(line))) return { code: 'region-duplicate', message: `${out} nests another region marker inside region ${id}` };
  // Managed content is rewritten by init and upgrade, so a region may neither sit inside it nor wrap it.
  // Fences do not hide managed tokens: the managed parsers match them anywhere.
  const from = lines.slice(0, first).join('').length, to = from + lines.slice(first, last + 1).join('').length;
  if (overlapsManaged(text, from, to)) return { code: 'output-unsafe', message: `Region ${id} of ${out} overlaps a managed block-beaver:start/end section; move its markers outside that section` };
  return { lines, first, last };
}

/** The current body of a claimed region, or the problem that stops it from being generated. */
export function readRegion(text, claim) {
  if (text === null) return { problem: { code: 'region-missing', message: `${claim.out} does not exist; region ${claim.region} needs a file with its markers` } };
  const found = locate(text, claim.out, claim.region);
  if (found.code) return { problem: found };
  return { body: canonical(found.lines.slice(found.first + 1, found.last).join('')) };
}

/** Generated region content: LF lines without one final newline, and no markers of its own. */
export function regionBody(claim, content) {
  if (typeof content !== 'string') return { problem: { code: 'generator-failed', message: `Output ${claim.out} region ${claim.region} must be a string` } };
  const body = canonical(content);
  if (hasManagedToken(body) || body.split('\n').some((line) => anyRegionMarker.test(line))) return { problem: { code: 'generator-failed', message: `Region ${claim.region} of ${claim.out} must not contain block-beaver region or managed markers` } };
  // An unclosed fence would swallow the end marker on the next read.
  if (markdown(claim.out) && fencedLines(linesOf(body)).open) return { problem: { code: 'generator-failed', message: `Region ${claim.region} of ${claim.out} must close every code fence it opens` } };
  return { body };
}

/** Replace one region's body, keeping the marker lines and the file's line endings. */
function splice(text, out, id, body) {
  const { lines, first, last } = locate(text, out, id);
  const eol = lines[first].endsWith('\r\n') ? '\r\n' : '\n';
  const inner = body === '' ? '' : body.split('\n').map((line) => line + eol).join('');
  return lines.slice(0, first + 1).join('') + inner + lines.slice(last).join('');
}

/**
 * One output per file: stale regions are spliced into the current text, so fresh and cached
 * regions and everything outside the markers keep their exact bytes.
 */
export function composeRegions(results, texts) {
  const files = new Map();
  for (const result of results) {
    const slot = result.claim.out.toLowerCase();
    files.set(slot, [...(files.get(slot) ?? []), result]);
  }
  return [...files.values()].map((group) => {
    const { out, key } = group[0].claim, current = texts.get(key);
    let expected = current;
    for (const { claim, body, status } of group) if (status === 'stale') expected = splice(expected, out, claim.region, body);
    const status = group.some((item) => item.status === 'stale') ? 'stale' : group.every((item) => item.status === 'cached') ? 'cached' : 'fresh';
    return { key: group.map((item) => item.claim.key).join(' + '), out, ...(group.length === 1 ? { region: group[0].claim.region } : {}),
      regions: group.map(({ claim, status: state }) => ({ key: claim.key, region: claim.region, status: state })), expected, current, status };
  });
}

/** Claims on one file: whole-file claims never share it, and a region has one owner. */
export function clashesOf(group) {
  if (group.length < 2) return [];
  if (!group.every((claim) => claim.region) || new Set(group.map((claim) => claim.out)).size > 1) return [group];
  const byRegion = new Map();
  for (const claim of group) byRegion.set(claim.region, [...(byRegion.get(claim.region) ?? []), claim]);
  return [...byRegion.values()].filter((clash) => clash.length > 1);
}
