import { resolve } from 'node:path';
import { readProjectFile, writeProjectFiles } from './project-files.mjs';
import { scanRepository } from './scanner.mjs';
import { attachProjectRegistry } from './adapter.mjs';
import { auditCounts } from './audit-rules.mjs';

export const BASELINE_PATH = '.blocks/baseline.json';
// The ratchet reads these as required nonnegative integers, so a key at zero stays at zero.
const RATCHET_KEYS = ['coverage', 'resolution'];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

/** Parses the stored baseline, or null when there is none. Throws on a schema the ratchet cannot read. */
export function parseBaseline(text) {
  if (text === null) return null;
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${BASELINE_PATH}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || RATCHET_KEYS.some((key) => !count(value[key]))) {
    throw new Error('Unsupported or invalid baseline schema; latest supported schemaVersion is 1 with nonnegative coverage and resolution counts.');
  }
  return value;
}

/**
 * Plans lowering a stored baseline to the current counts. Each ratchet key becomes the smaller of
 * its stored and current value, so the baseline only ever decreases. Other keys (including lint
 * allowances, which need ESLint to count) are kept byte for byte in value.
 * Returns null when there is no baseline. The file entry carries the before-image for writeProjectFiles.
 */
export function planBaselineLowering(before, counts) {
  const stored = parseBaseline(before);
  if (stored === null) return null;
  const next = { ...stored };
  const lowered = {};
  for (const key of RATCHET_KEYS) {
    if (!count(counts[key])) throw new Error(`Cannot lower ${key}: current count is unavailable.`);
    if (counts[key] < stored[key]) { lowered[key] = { from: stored[key], to: counts[key] }; next[key] = counts[key]; }
  }
  const content = Object.keys(lowered).length ? json(next) : before;
  return {
    file: { path: BASELINE_PATH, before, content, kind: 'baseline' },
    previous: Object.fromEntries(RATCHET_KEYS.map((key) => [key, stored[key]])),
    current: Object.fromEntries(RATCHET_KEYS.map((key) => [key, counts[key]])),
    lowered,
  };
}

/** Summarises a lowering plan for command output. */
export const baselineSummary = (plan) => plan && ({ path: BASELINE_PATH, previous: plan.previous, current: plan.current, lowered: plan.lowered, changed: plan.file.before !== plan.file.content });

/** Counts the working tree (respecting config ignore) the same way audit does. */
export async function currentCounts(root) {
  const scanned = await attachProjectRegistry(await scanRepository(root, { writeConfig: false }));
  return auditCounts({ ...scanned, root: '.', generator: 'block-beaver' });
}

/** `block-beaver baseline --lower`: records decreased ratchet counts, never increases. */
export async function lowerBaseline(inputRoot, { dryRun = false } = {}) {
  const root = resolve(inputRoot);
  const before = await readProjectFile(root, BASELINE_PATH);
  if (before === null) throw new Error(`No ${BASELINE_PATH}; run block-beaver install to initialize the baseline.`);
  const plan = planBaselineLowering(before, await currentCounts(root));
  const result = { ...baselineSummary(plan), dryRun, written: false };
  if (dryRun || !result.changed) return result;
  await writeProjectFiles(root, [plan.file]);
  result.written = true;
  // Covers the lowered bytes so a receipts-required gate accepts the commit, like install and upgrade.
  try {
    const { recordManagedSetup } = await import('./compliance.mjs');
    result.exception = await recordManagedSetup(root, { label: 'baseline --lower', paths: [BASELINE_PATH] });
  } catch (error) { result.exception = { status: 'incomplete', reason: error.message }; }
  return result;
}
