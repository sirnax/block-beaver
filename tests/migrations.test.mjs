import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateDocument, DOCUMENT_SCHEMA_VERSIONS } from '../src/migrations.mjs';

const freeze = (value) => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };

test('legacy config golden upgrade preserves owner fields and is idempotent', () => {
  const legacy = freeze({ apps: [{ id: 'owner-name', root: 'apps/web', source: 'config', entries: ['apps/web/main.ts'] }], ignore: ['archive/**'], enforcement: { agents: 'block', gate: 'audit' }, custom: { team: 'owner' } });
  const first = migrateDocument('config', legacy);
  assert.deepEqual(first.value, { ...legacy, schemaVersion: 1 });
  assert.deepEqual(first.applied, [{ kind: 'config', from: 0, to: 1 }]);
  assert.equal(Object.hasOwn(legacy, 'schemaVersion'), false);
  assert.notEqual(first.value.apps, legacy.apps);
  const second = migrateDocument('config', first.value);
  assert.deepEqual(second.value, first.value);
  assert.deepEqual(second.applied, []);
  second.value.custom.team = 'changed';
  assert.equal(first.value.custom.team, 'owner');
});

test('historical graph golden upgrade adds neutral app metadata and retains graph evidence', () => {
  const legacy = freeze({ schemaVersion: 1, root: '/fixture', fingerprint: 'stable', scannedAt: 'historical', summary: { files: 1 }, nodes: [{ id: 'file:src/a.ts', path: 'src/a.ts', kind: 'file', hash: 'hash' }, { id: 'symbol:src/a.ts#fn', name: 'fn', evidence: { file: 'src/a.ts', line: 1 } }], edges: [{ from: 'file:src/a.ts', to: 'symbol:src/a.ts#fn', kind: 'declares' }], hashes: { 'src/a.ts': 'hash' } });
  const upgraded = migrateDocument('graph', legacy);
  assert.deepEqual(upgraded.value, { ...legacy, schemaVersion: 2, apps: [], nodes: legacy.nodes.map((node) => ({ ...node, app: null, usedBy: [] })) });
  assert.deepEqual(upgraded.applied, [{ kind: 'graph', from: 1, to: 2 }]);
  assert.deepEqual(migrateDocument('graph', upgraded.value).applied, []);
  assert.equal(legacy.schemaVersion, 1);
});

test('unversioned graph advances sequentially and preserves already recorded app metadata', () => {
  const legacy = { apps: [{ id: 'web' }], nodes: [{ id: 'file:a.ts', app: 'web', usedBy: ['web'] }], custom: 'retained' };
  const upgraded = migrateDocument('graph', legacy);
  assert.deepEqual(upgraded.applied, [{ kind: 'graph', from: 0, to: 1 }, { kind: 'graph', from: 1, to: 2 }]);
  assert.deepEqual(upgraded.value.apps, legacy.apps);
  assert.deepEqual(upgraded.value.nodes, legacy.nodes);
  assert.equal(upgraded.value.custom, 'retained');
  assert.equal(migrateDocument('graph', legacy, 1).value.schemaVersion, 1);
});

test('manifest, roadmap, history and index legacy goldens retain their owner data', () => {
  for (const kind of ['manifest', 'roadmap', 'history', 'index']) {
    const legacy = freeze({ id: kind, files: ['src/a.ts'], metadata: { notes: ['owner'] } });
    const result = migrateDocument(kind, legacy);
    assert.deepEqual(result.value, { ...legacy, schemaVersion: 1 });
    assert.deepEqual(result.applied, [{ kind, from: 0, to: 1 }]);
    assert.deepEqual(migrateDocument(kind, result.value).applied, []);
  }
});

test('family index bare arrays retain their public shape and migrate idempotently', () => {
  const input = freeze([{ id: 'alpha', family: 'widget', version: 1, name: 'Alpha', metadata: { notes: ['owner'] } }]);
  const result = migrateDocument('index', input);
  assert.deepEqual(result.value, input);
  assert.ok(Array.isArray(result.value));
  assert.deepEqual(result.applied, []);
  assert.notEqual(result.value, input);
  result.value[0].metadata.notes.push('new note');
  assert.deepEqual(input[0].metadata.notes, ['owner']);
  assert.deepEqual(migrateDocument('index', result.value).value, result.value);
  assert.throws(() => migrateDocument('index', input, 0), /downgrade/);
  assert.throws(() => migrateDocument('index', input, 999), /future/);
  assert.throws(() => migrateDocument('index', { schemaVersion: 999, entries: input }), /future/);
});

test('unsupported future versions, unknown migration routes and invalid documents reject without mutations', () => {
  for (const [kind, current] of Object.entries(DOCUMENT_SCHEMA_VERSIONS)) {
    const future = freeze({ schemaVersion: current + 1, owner: 'unchanged' });
    assert.throws(() => migrateDocument(kind, future), /future/);
    assert.throws(() => migrateDocument(kind, { schemaVersion: current }, current + 1), /future/);
    assert.throws(() => migrateDocument(kind, { schemaVersion: current }, 0), /downgrade/);
    assert.equal(future.owner, 'unchanged');
  }
  assert.throws(() => migrateDocument('missing-kind', {}), /Unknown document kind/);
  for (const input of [null, [], 1, 'config']) assert.throws(() => migrateDocument('config', input), /object/);
  for (const schemaVersion of [null, undefined, -1, 0.5, '1', NaN]) assert.throws(() => migrateDocument('config', { schemaVersion }), /integer/);
  assert.throws(() => migrateDocument('graph', { schemaVersion: 1, nodes: [null] }), /nodes/);
  assert.throws(() => migrateDocument('graph', { schemaVersion: 1, nodes: [{ usedBy: 'web' }] }), /usedBy/);
  assert.throws(() => migrateDocument('graph', { schemaVersion: 1, apps: {} }), /apps/);
});

test('config migration neither adds nor rewrites enforcement.receipts', () => {
  for (const enforcement of [{ agents: 'guide', gate: 'audit' }, { agents: 'guide', gate: 'audit', receipts: 'optional' }, { receipts: 'off' }]) {
    const migrated = migrateDocument('config', freeze({ apps: [], enforcement })).value;
    assert.deepEqual(migrated.enforcement, enforcement);
    assert.equal(Object.hasOwn(migrated.enforcement, 'receipts'), Object.hasOwn(enforcement, 'receipts'));
  }
  assert.equal(Object.hasOwn(migrateDocument('config', { apps: [] }).value, 'enforcement'), false);
});
