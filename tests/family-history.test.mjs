import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateProject, importProjectHistory } from '../src/families/commands.mjs';
import { HistoryError, appendHistory, historySnapshots, importHistory, readHistory, replayHistory, serializeHistory } from '../src/families/history.mjs';

const NOW = new Date('2026-10-01T12:00:00Z');
const entry = (date, changes, extra = {}) => ({ date, label: null, source: 'gen', changes, ...extra });
const up = (block, hash) => ({ op: 'upsert', block, hash });
const del = (block) => ({ op: 'delete', block });
const doc = (...entries) => ({ schemaVersion: 1, entries });
const current = (object) => new Map(Object.entries(object));
const codes = (result) => result.diagnostics.map((item) => item.code);

test('absent or blank history reads as empty, and a valid document round-trips byte for byte', () => {
  assert.deepEqual(readHistory(null), doc());
  assert.deepEqual(readHistory('  \n'), doc());
  const text = serializeHistory(doc(entry('2026-10-01T12:00:00Z', [del('a:z'), up('a:x', 'sha256:1'), up('a:y', null)], { label: 'first', source: 'import' })));
  assert.equal(serializeHistory(readHistory(text)), text);
  assert.equal(readHistory(text).entries[0].label, 'first');
});

test('malformed history is refused with a HistoryError naming the problem', () => {
  const good = entry('2026-10-01', [up('a:x', 'sha256:1')]);
  const bad = [
    '{nope', '[]', 'null', '{"schemaVersion":2,"entries":[]}', '{"schemaVersion":1}', '{"schemaVersion":1,"entries":{}}',
    ...[
      { ...good, date: '2026-13-01' }, { ...good, date: '2026-10-01T12:00:00+00:00' }, { ...good, date: 'yesterday' }, { ...good, date: 20261001 },
      { ...good, source: 'hand' }, { ...good, label: 5 }, { ...good, changes: {} },
      { ...good, changes: [{ op: 'rename', block: 'a:x' }] }, { ...good, changes: [{ op: 'delete', block: 'no-colon' }] },
      { ...good, changes: [{ op: 'upsert', block: 'a:x', hash: 5 }] }, { ...good, changes: [{ op: 'upsert', block: 'A:x', hash: null }] }, null,
    ].map((item) => JSON.stringify(doc(item))),
  ];
  for (const text of bad) assert.throws(() => readHistory(text), (error) => error instanceof HistoryError && error.code === 'history-invalid', text);
});

test('replay folds every entry in order to the block → hash map it ends at', () => {
  const history = doc(entry('2026-01-01', [up('a:x', 'sha256:1'), up('a:y', 'sha256:2')]), entry('2026-01-02', [up('a:x', 'sha256:3'), del('a:y'), up('a:z', null)]));
  assert.deepEqual([...replayHistory(history)], [['a:x', 'sha256:3'], ['a:z', null]]);
  assert.deepEqual([...replayHistory(doc())], []);
});

test('an entry is appended only for changed hashes, sorted, UTC, and the input is never mutated', () => {
  const base = doc(entry('2026-01-01T00:00:00Z', [up('a:x', 'sha256:1'), up('a:y', 'sha256:2'), up('a:gone', 'sha256:9')]));
  const frozen = structuredClone(base);
  const unchanged = appendHistory(base, current({ 'a:x': 'sha256:1', 'a:y': 'sha256:2', 'a:gone': 'sha256:9' }), { label: 'ignored', now: NOW });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.doc, base);
  assert.equal(unchanged.entry, null);

  const next = appendHistory(base, current({ 'a:y': 'sha256:2', 'a:x': 'sha256:1b', 'b:new': 'sha256:5' }), { label: 'release 4', now: new Date('2026-10-01T14:00:00.999+02:00') });
  assert.equal(next.changed, true);
  assert.deepEqual(next.entry, entry('2026-10-01T12:00:00Z', [del('a:gone'), up('a:x', 'sha256:1b'), up('b:new', 'sha256:5')], { label: 'release 4' }));
  assert.equal(next.doc.entries.length, 2);
  assert.deepEqual(base, frozen);
  assert.equal(appendHistory(doc(), current({ 'a:x': 'sha256:1' }), { now: NOW }).entry.label, null);
  assert.throws(() => appendHistory(doc(), current({ 'a:x': 'sha256:1' }), { now: 'not a date' }), TypeError);
  assert.throws(() => appendHistory(doc(), current({ 'a:x': undefined }), { now: NOW }), TypeError);
});

test('an unknown imported hash differs from the real one, so the next gen records it once', () => {
  const imported = doc(entry('2026-01-01', [up('a:x', null)], { source: 'import' }));
  const first = appendHistory(imported, current({ 'a:x': 'sha256:1' }), { now: NOW });
  assert.deepEqual(first.entry.changes, [up('a:x', 'sha256:1')]);
  assert.equal(appendHistory(first.doc, current({ 'a:x': 'sha256:1' }), { now: NOW }).changed, false);
});

test('snapshots list the graph IDs standing after each entry', () => {
  const history = doc(entry('2026-01-01', [up('b:two', 'sha256:2'), up('a:one', 'sha256:1')], { label: 'start' }), entry('2026-01-02', [del('b:two'), up('a:three', 'sha256:3')]));
  assert.deepEqual(historySnapshots(history), [
    { date: '2026-01-01', label: 'start', blocks: ['block:a:one', 'block:b:two'] },
    { date: '2026-01-02', label: null, blocks: ['block:a:one', 'block:a:three'] },
  ]);
  assert.deepEqual(historySnapshots(doc()), []);
});

const source = (...entries) => ({ schemaVersion: 1, entries });
const old = (date, changes, label) => ({ date, ...(label === undefined ? {} : { label }), changes });
const importMap = { 'old-x': 'a:x', 'old-y': 'a:y', 'old-x-alias': 'a:x', 'old-gone': 'a:gone' };

test('an import keeps every date and label, maps keys, and leaves the next gen a no-op', () => {
  const result = importHistory(source(
    old('2025-03-01', [{ op: 'upsert', key: 'old-y' }, { op: 'upsert', key: 'old-x' }, { op: 'upsert', key: 'old-gone' }], 'step 1'),
    old('2025-03-01', [{ op: 'upsert', key: 'old-x-alias' }, { op: 'delete', key: 'old-x' }, { op: 'upsert', key: 'old-x' }]),
    old('2025-04-02T08:30:00Z', [{ op: 'delete', key: 'old-gone' }], 'step 3'),
    old('2025-05-01', [{ op: 'upsert', key: 'old-y' }]),
  ), importMap, current({ 'a:x': 'sha256:xx', 'a:y': 'sha256:yy' }), doc());
  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.doc.entries.map((item) => [item.date, item.label, item.source]), [
    ['2025-03-01', 'step 1', 'import'], ['2025-03-01', null, 'import'], ['2025-04-02T08:30:00Z', 'step 3', 'import'], ['2025-05-01', null, 'import'],
  ]);
  assert.deepEqual(result.doc.entries[0].changes, [up('a:gone', null), up('a:x', null), up('a:y', null)], 'sorted by block; superseded hashes stay unknown');
  assert.deepEqual(result.doc.entries[1].changes, [up('a:x', 'sha256:xx')], 'the last operation in an entry wins, and the final upsert gets the real hash');
  assert.deepEqual(result.doc.entries[2].changes, [del('a:gone')]);
  assert.deepEqual(result.doc.entries[3].changes, [up('a:y', 'sha256:yy')]);
  assert.deepEqual([...replayHistory(result.doc)], [['a:x', 'sha256:xx'], ['a:y', 'sha256:yy']]);
  assert.equal(appendHistory(result.doc, current({ 'a:x': 'sha256:xx', 'a:y': 'sha256:yy' }), { now: NOW }).changed, false);
  assert.deepEqual(readHistory(serializeHistory(result.doc)), result.doc);
});

test('an import with nothing to import into nothing is an empty, valid history', () => {
  assert.deepEqual(importHistory(source(), {}, current({}), null).doc, doc());
});

test('an import is refused for each way it can be wrong, and says so with a stable code', () => {
  const entries = (list) => source(old('2025-01-01', list));
  const here = current({ 'a:x': 'sha256:xx' });
  const attempt = (src, map = importMap, now = here, existing = doc()) => importHistory(src, map, now, existing);
  const upsert = (key) => ({ op: 'upsert', key });

  const exists = attempt(entries([upsert('old-x')]), importMap, here, doc(entry('2026-01-01', [up('a:x', 'sha256:1')])));
  assert.deepEqual([exists.ok, codes(exists)], [false, ['import-history-exists']]);
  assert.equal(attempt(entries([upsert('old-x')]), importMap, here, doc()).ok, true, 'an empty existing history is fine');

  const unmapped = attempt(entries([upsert('old-x'), upsert('zzz'), upsert('aaa')]));
  assert.deepEqual(codes(unmapped), ['import-unmapped-key', 'import-unmapped-key']);
  assert.match(unmapped.diagnostics[0].message, /"aaa"/, 'sorted');
  assert.match(unmapped.diagnostics[1].message, /"zzz"/);

  const backwards = attempt(source(old('2025-02-01', [upsert('old-x')]), old('2025-01-31T23:59:59Z', [])));
  assert.deepEqual(codes(backwards), ['import-date-order']);
  assert.equal(attempt(source(old('2025-02-01', [upsert('old-x')]), old('2025-02-01T00:00:00Z', []))).ok, true, 'equal instants are in order');

  const missing = attempt(entries([upsert('old-y')]));
  assert.deepEqual(codes(missing), ['import-replay-mismatch']);
  assert.match(missing.diagnostics[0].message, /missing: a:x; extra: a:y/);
  const extra = attempt(entries([upsert('old-x'), upsert('old-gone')]));
  assert.match(extra.diagnostics[0].message, /extra: a:gone/);
  const removed = attempt(entries([upsert('old-x'), { op: 'delete', key: 'old-x' }]));
  assert.match(removed.diagnostics[0].message, /missing: a:x/);

  for (const bad of [null, [], { schemaVersion: 2, entries: [] }, { schemaVersion: 1 }, { schemaVersion: 1, entries: {} }]) assert.deepEqual(codes(attempt(bad)), ['import-invalid']);
  for (const item of [null, old('someday', []), old('2025-02-30', []), old('2025-01-01', {}), old('2025-01-01', [], 7), old('2025-01-01', [{ op: 'rename', key: 'old-x' }]), old('2025-01-01', [{ op: 'upsert' }]), old('2025-01-01', [null])]) {
    assert.ok(codes(attempt(source(item))).includes('import-invalid'), JSON.stringify(item));
  }
  for (const map of [null, [], { 'old-x': 'no-colon' }, { 'old-x': 5 }, { 'old-x': 'Bad:x' }, { 'old-x': 'a:' }]) assert.ok(codes(attempt(entries([upsert('old-x')]), map)).includes('import-invalid'), JSON.stringify(map));
});

// ---- command orchestrators, against a real directory and the public loader seam ----

async function repo(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-cmd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
const listing = async (root) => (await readdir(root, { recursive: true })).sort();
const family = (generators) => ({ id: 'gizmo', implementation: ['none'], fields: { type: 'object', shape: {} }, links: [], generators, hasCheck: false, floor: 0, config: { id: 'gizmo', contract: 'gizmo.family.ts', manifests: 'blocks/*.ts', registry: { out: 'gen/gizmo.ts' } } });
const block = (id, hash) => ({ family: 'gizmo', id, ref: `gizmo:${id}`, graphId: `block:gizmo:${id}`, path: `blocks/${id}.ts`, exportName: 'default', hash, value: { id, family: 'gizmo' } });
const loaderFor = (...manifests) => { const calls = []; const load = async (args) => { calls.push(args); return { key: 'k', families: [family(['registry', 'history'])], manifests, generators: [], loadedFiles: [], diagnostics: [] }; }; load.calls = calls; return load; };
const graph = { nodes: [{ kind: 'file', path: 'blocks/a.ts', hash: 'h' }, { kind: 'block', id: 'x' }] };

test('generateProject writes outputs and history, then reports a clean repeat with nothing written', async (t) => {
  const root = await repo(t, { '.blocks/config.json': JSON.stringify({ schemaVersion: 1, history: { label: 'from config' } }) });
  const loadFamilies = loaderFor(block('a', 'sha256:a'));
  const first = await generateProject(root, { graph, loadFamilies, now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.mode, 'write');
  assert.deepEqual(first.written, ['gen/gizmo.ts', '.blocks/history.json']);
  assert.deepEqual(first.outputs.map((item) => [item.key, item.status]), [['registry:gizmo', 'missing'], ['history', 'missing']]);
  assert.deepEqual(loadFamilies.calls[0].paths, ['blocks/a.ts'], 'the loader gets the graph file paths');
  assert.equal(JSON.parse(await readFile(join(root, '.blocks/history.json'), 'utf8')).entries[0].label, 'from config');

  const again = await generateProject(root, { graph, loadFamilies, now: new Date('2030-01-01T00:00:00Z'), label: 'ignored when nothing changed' });
  assert.deepEqual([again.ok, again.written, again.outputs.map((item) => item.status)], [true, [], ['fresh', 'fresh']]);

  const labelled = await generateProject(root, { graph, loadFamilies: loaderFor(block('a', 'sha256:a2')), now: NOW, label: 'cli wins' });
  assert.deepEqual(labelled.written, ['.blocks/history.json']);
  assert.equal(JSON.parse(await readFile(join(root, '.blocks/history.json'), 'utf8')).entries[1].label, 'cli wins');
});

test('generateProject --check and --dry-run report the same work and write nothing', async (t) => {
  const root = await repo(t);
  const loadFamilies = loaderFor(block('a', 'sha256:a'));
  const check = await generateProject(root, { check: true, graph, loadFamilies, now: NOW });
  assert.deepEqual([check.ok, check.mode, check.written, check.pending], [false, 'check', [], ['gen/gizmo.ts', '.blocks/history.json']]);
  assert.deepEqual(check.diagnostics.map((item) => [item.rule, item.code]), [['family-drift', 'output-missing'], ['family-drift', 'history-stale']]);
  const dry = await generateProject(root, { dryRun: true, graph, loadFamilies, now: NOW });
  assert.deepEqual([dry.ok, dry.mode, dry.written, dry.pending, dry.diagnostics], [true, 'dry-run', [], ['gen/gizmo.ts', '.blocks/history.json'], []]);
  assert.deepEqual(await listing(root), [], 'neither mode wrote a file');

  await generateProject(root, { graph, loadFamilies, now: NOW });
  const clean = await generateProject(root, { check: true, graph, loadFamilies, now: NOW });
  assert.deepEqual([clean.ok, clean.pending, clean.diagnostics], [true, [], []]);
});

test('generateProject surfaces a bad config and refuses to write over loader errors', async (t) => {
  const broken = await repo(t, { '.blocks/config.json': '{nope' });
  const result = await generateProject(broken, { graph, loadFamilies: loaderFor() });
  assert.deepEqual([result.ok, result.diagnostics.map((item) => [item.rule, item.code, item.file])], [false, [['config-valid', 'family-path-invalid', '.blocks/config.json']]]);

  const root = await repo(t);
  const loadFamilies = async () => ({ key: 'k', families: [family(['registry'])], manifests: [], generators: [], loadedFiles: [], diagnostics: [{ rule: 'manifest-valid', code: 'manifest-schema', severity: 'error', message: 'bad' }] });
  const refused = await generateProject(root, { graph, loadFamilies });
  assert.deepEqual([refused.ok, refused.written], [false, []]);
  assert.deepEqual(await listing(root), []);
});

const importFiles = {
  'tmp/old.json': JSON.stringify({ schemaVersion: 1, entries: [{ date: '2025-01-01', label: 'one', changes: [{ op: 'upsert', key: 'k-a' }] }, { date: '2025-02-01', changes: [{ op: 'upsert', key: 'k-b' }] }] }),
  'tmp/map.json': JSON.stringify({ 'k-a': 'gizmo:a', 'k-b': 'gizmo:b' }),
};

test('importProjectHistory previews, then writes, and a following gen adds nothing', async (t) => {
  const root = await repo(t, importFiles);
  const loadFamilies = loaderFor(block('a', 'sha256:a'), block('b', 'sha256:b'));
  const file = join(root, 'tmp/old.json'), map = join(root, 'tmp/map.json');
  const dry = await importProjectHistory(root, file, map, { dryRun: true, graph, loadFamilies });
  assert.deepEqual([dry.ok, dry.dryRun, dry.entries, dry.written, dry.diagnostics], [true, true, 2, [], []]);
  assert.ok(!(await listing(root)).includes('.blocks'), 'dry run wrote nothing');

  const done = await importProjectHistory(root, file, map, { graph, loadFamilies });
  assert.deepEqual([done.ok, done.entries, done.written], [true, 2, ['.blocks/history.json']]);
  const history = readHistory(await readFile(join(root, '.blocks/history.json'), 'utf8'));
  assert.deepEqual(history.entries.map((item) => [item.date, item.label, item.source]), [['2025-01-01', 'one', 'import'], ['2025-02-01', null, 'import']]);
  assert.deepEqual([...replayHistory(history)], [['gizmo:a', 'sha256:a'], ['gizmo:b', 'sha256:b']]);

  const generated = await generateProject(root, { graph, loadFamilies, now: NOW });
  assert.ok(!generated.written.includes('.blocks/history.json'), 'imported history is already current');
  assert.deepEqual((await generateProject(root, { check: true, graph, loadFamilies, now: NOW })).diagnostics, []);

  const second = await importProjectHistory(root, file, map, { graph, loadFamilies });
  assert.deepEqual([second.ok, codes(second)], [false, ['import-history-exists']]);
});

test('importProjectHistory refuses a mismatched replay, bad files and loader errors without writing', async (t) => {
  const root = await repo(t, importFiles);
  const file = join(root, 'tmp/old.json'), map = join(root, 'tmp/map.json');
  const mismatch = await importProjectHistory(root, file, map, { graph, loadFamilies: loaderFor(block('a', 'sha256:a')) });
  assert.deepEqual([mismatch.ok, codes(mismatch)], [false, ['import-replay-mismatch']]);

  const missingFile = await importProjectHistory(root, join(root, 'tmp/none.json'), map, { graph, loadFamilies: loaderFor() });
  assert.deepEqual([missingFile.ok, codes(missingFile)], [false, ['import-invalid']]);
  await writeFile(join(root, 'tmp/bad-map.json'), '{nope');
  const badMap = await importProjectHistory(root, file, join(root, 'tmp/bad-map.json'), { graph, loadFamilies: loaderFor() });
  assert.deepEqual(codes(badMap), ['import-invalid']);

  const failing = async () => ({ key: 'k', families: [], manifests: [], generators: [], loadedFiles: [], diagnostics: [{ rule: 'manifest-valid', code: 'load-failed', severity: 'error', message: 'x' }] });
  assert.deepEqual(codes(await importProjectHistory(root, file, map, { graph, loadFamilies: failing })), ['load-failed']);

  await mkdir(join(root, '.blocks'), { recursive: true });
  await writeFile(join(root, '.blocks/history.json'), '{broken');
  const damaged = await importProjectHistory(root, file, map, { graph, loadFamilies: loaderFor(block('a', 'sha256:a'), block('b', 'sha256:b')) });
  assert.deepEqual([damaged.ok, codes(damaged)], [false, ['import-history-exists']]);
  assert.equal(await readFile(join(root, '.blocks/history.json'), 'utf8'), '{broken');
});
