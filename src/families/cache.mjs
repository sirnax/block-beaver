import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { canonicalJson } from './canonical.mjs';

export const cachePath = '.blocks/cache/generators.json';
export const blockBeaverVersion = createRequire(import.meta.url)('../../package.json').version;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const outputHash = (text) => `sha256:${sha256(text)}`;

/** An unreadable, malformed or differently versioned cache is just an empty cache. */
export function readCache(text) {
  const empty = { schemaVersion: 1, blockBeaver: blockBeaverVersion, entries: {} };
  if (typeof text !== 'string') return empty;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return empty; }
  if (!object(parsed) || parsed.schemaVersion !== 1 || !object(parsed.entries)) return empty;
  const entries = {};
  for (const key of Object.keys(parsed.entries).sort(compare)) {
    const entry = parsed.entries[key];
    if (object(entry) && typeof entry.inputsHash === 'string' && typeof entry.outHash === 'string') entries[key] = { inputsHash: entry.inputsHash, outHash: entry.outHash };
  }
  return { ...empty, entries };
}

export function serializeCache(entries) {
  const sorted = {};
  for (const key of Object.keys(entries).sort(compare)) sorted[key] = { inputsHash: entries[key].inputsHash, outHash: entries[key].outHash };
  return `${JSON.stringify({ schemaVersion: 1, blockBeaver: blockBeaverVersion, entries: sorted }, null, 2)}\n`;
}

/** Hash the real bytes of every input a generator's globs matched. */
export async function hashInputs(root, paths) {
  return Promise.all([...new Set(paths)].sort(compare).map(async (path) => {
    try { return [path, sha256(await readFile(join(root, path)))]; }
    catch (error) { return [path, `missing:${error.code || 'unreadable'}`]; }
  }));
}

export function inputsHash({ closureHash, out, inputs, context = null }) {
  return sha256(canonicalJson({ version: blockBeaverVersion, closureHash: closureHash ?? '', out, inputs, context }));
}
