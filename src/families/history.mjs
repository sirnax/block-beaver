export const historyPath = '.blocks/history.json';

const refPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const datePattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/;
const hashPattern = /^sha256:\S+$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export class HistoryError extends Error {
  constructor(message) { super(message); this.name = 'HistoryError'; this.code = 'history-invalid'; }
}

const emptyDoc = () => ({ schemaVersion: 1, entries: [] });

/** Imported dates may be date-only; both forms are real UTC instants. */
function instant(date) {
  if (typeof date !== 'string' || !datePattern.test(date)) return NaN;
  const time = Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date);
  if (Number.isNaN(time)) return NaN;
  return new Date(time).toISOString().startsWith(date.length === 10 ? date : date.slice(0, 19)) ? time : NaN;
}

/** UTC with seconds precision, from an injected clock value. */
export function utcStamp(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError('History needs a valid date');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeEntry(entry, index) {
  const at = `entries[${index}]`;
  if (!object(entry)) throw new HistoryError(`${at} must be an object`);
  if (Number.isNaN(instant(entry.date))) throw new HistoryError(`${at}.date must be a UTC date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)`);
  if (entry.label !== null && entry.label !== undefined && typeof entry.label !== 'string') throw new HistoryError(`${at}.label must be a string or null`);
  if (entry.source !== 'gen' && entry.source !== 'import') throw new HistoryError(`${at}.source must be gen or import`);
  if (!Array.isArray(entry.changes)) throw new HistoryError(`${at}.changes must be an array`);
  const changes = entry.changes.map((change, position) => {
    if (!object(change) || typeof change.block !== 'string' || !refPattern.test(change.block)) throw new HistoryError(`${at}.changes[${position}].block must be a family:id reference`);
    if (change.op === 'delete') return { op: 'delete', block: change.block };
    if (change.op !== 'upsert') throw new HistoryError(`${at}.changes[${position}].op must be upsert or delete`);
    if (change.hash !== null && (typeof change.hash !== 'string' || !hashPattern.test(change.hash))) throw new HistoryError(`${at}.changes[${position}].hash must be a sha256 hash or null`);
    return { op: 'upsert', block: change.block, hash: change.hash };
  });
  return { date: entry.date, label: entry.label ?? null, source: entry.source, changes };
}

/** Parse and validate `.blocks/history.json`; absent or blank text is an empty history. */
export function readHistory(text) {
  if (text === null || text === undefined || (typeof text === 'string' && text.trim() === '')) return emptyDoc();
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new HistoryError(`History is not valid JSON: ${error.message}`); }
  if (!object(parsed) || parsed.schemaVersion !== 1) throw new HistoryError('History must be an object with schemaVersion 1');
  if (!Array.isArray(parsed.entries)) throw new HistoryError('History entries must be an array');
  return { schemaVersion: 1, entries: parsed.entries.map(normalizeEntry) };
}

export const serializeHistory = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

/** Fold every entry in order into the block reference → hash map it ends at. */
export function replayHistory(doc) {
  const state = new Map();
  for (const entry of doc.entries) {
    for (const change of entry.changes) {
      if (change.op === 'upsert') state.set(change.block, change.hash);
      else state.delete(change.block);
    }
  }
  return state;
}

/** Add one gen entry only when the replayed hashes differ from the current ones. */
export function appendHistory(doc, current, { label = null, now } = {}) {
  const replayed = replayHistory(doc);
  const changes = [];
  for (const [block, hash] of current) {
    if (typeof hash !== 'string') throw new TypeError(`Block ${block} needs a hash`);
    if (!replayed.has(block) || replayed.get(block) !== hash) changes.push({ op: 'upsert', block, hash });
  }
  for (const block of replayed.keys()) if (!current.has(block)) changes.push({ op: 'delete', block });
  if (!changes.length) return { doc, changed: false, entry: null };
  changes.sort((a, b) => compare(a.block, b.block));
  const entry = { date: utcStamp(now), label: label ?? null, source: 'gen', changes };
  return { doc: { schemaVersion: 1, entries: [...doc.entries, entry] }, changed: true, entry };
}

/**
 * The graph block IDs standing after each entry; feeds the map's history slider.
 * Each snapshot is `{ date, label, blocks, gone }`. `gone` (0.6.0, additive) lists every
 * block that stood after some earlier-or-equal entry but no longer stands at this one, as
 * `{ id: 'block:<family>:<id>', family, name }` sorted by id. History stores only block
 * references, so `name` is the reference's id part; the manifest left with the block.
 */
export function historySnapshots(doc) {
  const state = new Set(), seen = new Set();
  return doc.entries.map((entry) => {
    for (const change of entry.changes) {
      if (change.op === 'upsert') { state.add(change.block); seen.add(change.block); }
      else state.delete(change.block);
    }
    const gone = [...seen].filter((block) => !state.has(block)).sort(compare).map((block) => {
      const split = block.indexOf(':');
      return { id: `block:${block}`, family: block.slice(0, split), name: block.slice(split + 1) };
    });
    return { date: entry.date, label: entry.label, blocks: [...state].sort(compare).map((block) => `block:${block}`), gone };
  });
}

const problem = (code, message, extra = {}) => ({ rule: 'family-drift', code, severity: 'error', message, file: historyPath, ...extra });

/**
 * Convert a hand-built history into this format. Refuses rather than guesses: every
 * key must be mapped, dates must not go backwards, and replaying the result must end at
 * exactly the current block set.
 */
export function importHistory(source, mapping, current, existing = null) {
  const diagnostics = [];
  if (existing?.entries?.length) return { ok: false, diagnostics: [problem('import-history-exists', 'History already has entries; an import only starts an empty history')] };
  if (!object(source) || source.schemaVersion !== 1 || !Array.isArray(source.entries)) return { ok: false, diagnostics: [problem('import-invalid', 'Import file must be { schemaVersion: 1, entries: [...] }')] };
  if (!object(mapping)) return { ok: false, diagnostics: [problem('import-invalid', 'Mapping must be an object of old key → family:id')] };
  for (const [key, ref] of Object.entries(mapping)) {
    if (typeof ref !== 'string' || !refPattern.test(ref)) diagnostics.push(problem('import-invalid', `Mapping for ${JSON.stringify(key)} must be a family:id reference`));
  }
  const unmapped = new Set();
  const entries = [];
  let previous = -Infinity;
  for (const [index, entry] of source.entries.entries()) {
    const at = `entries[${index}]`;
    if (!object(entry) || Number.isNaN(instant(entry.date)) || !Array.isArray(entry.changes) || (entry.label !== undefined && entry.label !== null && typeof entry.label !== 'string')) {
      diagnostics.push(problem('import-invalid', `${at} needs a UTC date, an optional string label and a changes array`));
      continue;
    }
    const time = instant(entry.date);
    if (time < previous) diagnostics.push(problem('import-date-order', `${at} is dated ${entry.date}, earlier than the entry before it`));
    previous = Math.max(previous, time);
    // Within one entry the last operation on a block wins; the entry stores one per block.
    const final = new Map();
    for (const [position, change] of entry.changes.entries()) {
      if (!object(change) || (change.op !== 'upsert' && change.op !== 'delete') || typeof change.key !== 'string' || !change.key) {
        diagnostics.push(problem('import-invalid', `${at}.changes[${position}] needs op upsert or delete and a key`));
        continue;
      }
      if (!Object.hasOwn(mapping, change.key)) { unmapped.add(change.key); continue; }
      const ref = mapping[change.key];
      if (typeof ref === 'string' && refPattern.test(ref)) final.set(ref, change.op);
    }
    const changes = [...final].sort(([a], [b]) => compare(a, b)).map(([block, op]) => (op === 'upsert' ? { op, block, hash: null } : { op, block }));
    entries.push({ date: entry.date, label: entry.label ?? null, source: 'import', changes });
  }
  for (const key of [...unmapped].sort(compare)) diagnostics.push(problem('import-unmapped-key', `Old key ${JSON.stringify(key)} has no mapping`));
  if (diagnostics.length) return { ok: false, diagnostics };

  const replayed = replayHistory({ entries });
  const missing = [...current.keys()].filter((block) => !replayed.has(block)).sort(compare);
  const extra = [...replayed.keys()].filter((block) => !current.has(block)).sort(compare);
  if (missing.length || extra.length) {
    return { ok: false, diagnostics: [problem('import-replay-mismatch', `Replaying the imported history does not reach the current blocks (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`)] };
  }
  // Give each surviving block's final upsert its current hash so the next gen is a no-op.
  const settled = new Set();
  for (let index = entries.length - 1; index >= 0; index--) {
    for (const change of entries[index].changes) {
      if (change.op === 'upsert' && current.has(change.block) && !settled.has(change.block)) { change.hash = current.get(change.block); settled.add(change.block); }
    }
  }
  return { ok: true, doc: { schemaVersion: 1, entries }, diagnostics: [] };
}
