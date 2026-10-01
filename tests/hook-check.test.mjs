import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { hookCheck, formatHookOutput } from '../src/hook-check.mjs';

async function fixture(t, agents = 'guide') {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.blocks/view'), { recursive: true });
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, enforcement: { agents } }));
  const graph = {
    schemaVersion: 2,
    nodes: [
      { id: 'file:src/api.ts', path: 'src/api.ts', kind: 'file', usedBy: ['web', 'admin'] },
      { id: 'file:src/unowned.ts', path: 'src/unowned.ts', kind: 'file', usedBy: [] },
      { id: 'block:local:api', kind: 'block', manifest: { files: ['src/api.ts', 'src/new.ts'], dependencies: ['block:local:storage'] } },
      { id: 'block:local:storage', kind: 'block', manifest: { files: [] } },
      { id: 'block:local:web', kind: 'block', manifest: { files: [] } },
    ],
    edges: [
      { from: 'block:local:api', to: 'file:src/api.ts', kind: 'implemented-by' },
      { from: 'block:local:api', to: 'block:local:storage', kind: 'depends-on' },
      { from: 'block:local:web', to: 'block:local:api', kind: 'depends-on' },
    ],
  };
  await writeFile(join(root, '.blocks/view/graph.json'), JSON.stringify(graph));
  return { root, graph };
}

const event = (tool_name, tool_input, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra });

test('native reads and edits receive cached ownership, dependency, dependent and app context', async (t) => {
  const { root } = await fixture(t);
  for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit']) {
    const result = await hookCheck(event(tool, { file_path: join(root, 'src/api.ts') }), { root });
    assert.equal(result.decision, 'allow');
    assert.match(result.context, /belongs to block:local:api/);
    assert.match(result.context, /Dependencies: block:local:storage/);
    assert.match(result.context, /Dependents: block:local:web/);
    assert.match(result.context, /used by apps: web, admin/);
  }
});

test('guide mode reminds on new unowned files and leaves unrelated reads silent', async (t) => {
  const { root } = await fixture(t);
  const result = await hookCheck(event('Write', { file_path: 'src/outside.ts' }), { root });
  assert.equal(result.decision, 'allow');
  assert.match(result.context, /outside every block.*Place it in a block/s);
  assert.deepEqual(await hookCheck(event('Read', { file_path: 'src/unowned.ts' }), { root }), { decision: 'allow' });
});

test('block mode denies unowned or outside-repository writes, allows owned creations and reads', async (t) => {
  const { root } = await fixture(t, 'block');
  for (const path of ['src/unowned.ts', 'src/undeclared.ts', '../elsewhere.ts']) {
    const result = await hookCheck(event('Edit', { file_path: path }), { root });
    assert.equal(result.decision, 'deny');
    assert.match(result.reason, /block-beaver exception <id> --rule coverage-ratchet --allowance 1/);
  }
  assert.equal((await hookCheck(event('Write', { file_path: 'src/new.ts' }), { root })).decision, 'allow');
  assert.equal((await hookCheck(event('Read', { file_path: 'src/unowned.ts' }), { root })).decision, 'allow');
  assert.equal((await hookCheck(event('Read', { file_path: '../elsewhere.ts' }), { root })).decision, 'allow');
});

test('native Codex apply_patch covers every edited, added, deleted and moved path', async (t) => {
  const { root } = await fixture(t, 'block');
  const patch = '*** Begin Patch\n*** Update File: src/api.ts\n@@\n-a\n+b\n*** Add File: src/new.ts\n+ok\n*** End Patch';
  assert.equal((await hookCheck(event('apply_patch', { command: patch }), { root })).decision, 'allow');
  for (const heading of ['Add File', 'Update File', 'Delete File', 'Move to']) {
    const result = await hookCheck(event('apply_patch', { command: `*** Begin Patch\n*** Update File: src/api.ts\n*** ${heading}: src/outside.ts\n*** End Patch` }), { root });
    assert.equal(result.decision, 'deny');
    assert.match(result.reason, /src\/outside.ts/);
  }
});

test('relative native paths use event cwd and absolute paths retain root ownership', async (t) => {
  const { root } = await fixture(t, 'block');
  const result = await hookCheck(event('Edit', { file_path: 'api.ts' }, { cwd: join(root, 'src') }), { root });
  assert.equal(result.decision, 'allow');
  assert.match(result.context, /src\/api.ts belongs/);
});

test('native commit events remind about staged audit without invoking git', async (t) => {
  const { root } = await fixture(t);
  for (const command of ['git commit -m change', 'git -C /tmp/project commit', 'npm test && git commit -m change']) {
    assert.match((await hookCheck(event('Bash', { command }), { root })).context, /audit --staged/);
  }
  assert.deepEqual(await hookCheck(event('Bash', { command: 'git status' }), { root }), { decision: 'allow' });
  assert.deepEqual(await hookCheck(event('Bash', { command: 'echo git commit' }), { root }), { decision: 'allow' });
});

test('unknown and malformed envelopes fail open silently', async (t) => {
  const { root } = await fixture(t, 'block');
  for (const input of [null, {}, event('Unknown', { file_path: 'src/outside.ts' }), event('Edit', null),
    event('Edit', { file_path: 123 }), event('Edit', { file_path: 'bad\0path' }),
    event('apply_patch', { command: 'not a native patch' }),
    { tool_name: 'Edit', tool_input: { file_path: 'src/outside.ts' } },
    event('Edit', { file_path: 'src/outside.ts' }, { hook_event_name: 'PostToolUse' })]) {
    assert.deepEqual(await hookCheck(input, { root }), { decision: 'allow' });
  }
});

test('missing, corrupt, invalid and unsafe cache state fails open silently', async (t) => {
  const { root } = await fixture(t, 'block');
  const edit = event('Edit', { file_path: 'src/unowned.ts' });
  const cache = join(root, '.blocks/view/graph.json');
  for (const content of ['{', 'null', '{}', '{"schemaVersion":2,"nodes":[null],"edges":[]}']) {
    await writeFile(cache, content);
    assert.deepEqual(await hookCheck(edit, { root }), { decision: 'allow' });
  }
  await rm(cache);
  assert.deepEqual(await hookCheck(edit, { root }), { decision: 'allow' });
  await symlink(join(root, '.blocks/config.json'), cache);
  assert.deepEqual(await hookCheck(edit, { root }), { decision: 'allow' });
  await writeFile(join(root, '.blocks/config.json'), 'null');
  assert.deepEqual(await hookCheck(edit, { root }), { decision: 'allow' });
});

test('deadline expires silently and a requested larger budget is capped at 500 ms', async (t) => {
  const { root } = await fixture(t, 'block');
  const start = performance.now();
  assert.deepEqual(await hookCheck(event('Edit', { file_path: 'src/unowned.ts' }), { root, deadlineMs: 0 }), { decision: 'allow' });
  assert.ok(performance.now() - start < 500);
  assert.deepEqual(await hookCheck(event('Edit', { file_path: 'src/unowned.ts' }), { root, deadlineMs: 0.001 }), { decision: 'allow' });
  assert.equal((await hookCheck(event('Edit', { file_path: 'src/unowned.ts' }), { root, deadlineMs: 5000 })).decision, 'deny');
});

test('cached parents cannot redirect guidance outside the target repository', async (t) => {
  const { root } = await fixture(t, 'block');
  await mkdir(join(root, 'elsewhere'));
  await writeFile(join(root, 'elsewhere/graph.json'), JSON.stringify({ schemaVersion: 2, nodes: [], edges: [] }));
  await rm(join(root, '.blocks/view'), { recursive: true });
  await symlink(join(root, 'elsewhere'), join(root, '.blocks/view'));
  assert.deepEqual(await hookCheck(event('Edit', { file_path: 'src/unowned.ts' }), { root }), { decision: 'allow' });
});

test('unowned files shared across apps still receive usage context', async (t) => {
  const { root, graph } = await fixture(t);
  graph.nodes.find((node) => node.path === 'src/unowned.ts').usedBy = ['web', 'worker'];
  await writeFile(join(root, '.blocks/view/graph.json'), JSON.stringify(graph));
  assert.match((await hookCheck(event('Read', { file_path: 'src/unowned.ts' }), { root })).context, /used by apps: web, worker/);
});

test('ratchet and arbitrary exceptions never authorize unowned edits', async (t) => {
  const { root } = await fixture(t, 'block');
  await mkdir(join(root, '.blocks/exceptions'));
  await writeFile(join(root, '.blocks/exceptions/coverage.json'), JSON.stringify({ schemaVersion: 1, type: 'ratchet', id: 'coverage', reason: 'baseline', paths: ['src/unowned.ts'], rule: 'coverage-ratchet', allowance: 1 }));
  assert.equal((await hookCheck(event('Edit', { file_path: 'src/unowned.ts' }), { root })).decision, 'deny');
});

test('typed manifest metadata receives associated block context without implementation coverage', async (t) => {
  const { root, graph } = await fixture(t, 'block');
  graph.nodes.push(
    { id: 'file:blocks/widgets/detail.ts', path: 'blocks/widgets/detail.ts', kind: 'file', familyRole: 'manifest', owningBlock: 'block:widgets:detail', usedBy: [] },
    { id: 'file:src/detail.ts', path: 'src/detail.ts', kind: 'file', usedBy: ['web', 'admin'] },
    { id: 'block:widgets:detail', kind: 'block', family: 'widgets', usedBy: ['web', 'admin'], dependencies: ['block:local:storage'], manifest: { implementation: { kind: 'module', module: '../../src/detail.ts' } } },
    { id: 'block:widgets:list', kind: 'block', family: 'widgets', manifest: {} },
  );
  graph.edges.push(
    { from: 'block:widgets:detail', to: 'file:src/detail.ts', kind: 'implemented-by' },
    { from: 'block:widgets:detail', to: 'block:local:storage', kind: 'reads-from', link: true },
    { from: 'block:widgets:list', to: 'block:widgets:detail', kind: 'renders', link: true },
  );
  const cached = JSON.stringify(graph);
  await writeFile(join(root, '.blocks/view/graph.json'), cached);
  for (const tool of ['Read', 'Edit', 'Write']) {
    const result = await hookCheck(event(tool, { file_path: 'blocks/widgets/detail.ts' }), { root });
    assert.equal(result.decision, 'allow');
    assert.match(result.context, /typed manifest for block:widgets:detail/);
    assert.match(result.context, /Dependencies: block:local:storage/);
    assert.match(result.context, /Dependents: block:widgets:list/);
    assert.match(result.context, /used by apps: web, admin/);
    assert.match(result.context, /Manifest metadata is separate from implementation coverage/);
    assert.match(result.context, /block-beaver gen --check/);
  }
  assert.equal(await readFile(join(root, '.blocks/view/graph.json'), 'utf8'), cached);
  assert.equal(graph.edges.filter((edge) => edge.kind === 'implemented-by' && edge.to === 'file:blocks/widgets/detail.ts').length, 0);
  const implementation = await hookCheck(event('Edit', { file_path: 'src/detail.ts' }), { root });
  assert.equal(implementation.decision, 'allow');
  assert.match(implementation.context, /belongs to block:widgets:detail/);
  assert.match(implementation.context, /Dependents: block:widgets:list/);
});

test('family roles alone do not invent block edit authority', async (t) => {
  const { root, graph } = await fixture(t, 'block');
  for (const familyRole of ['contract', 'generator', 'manifest']) {
    graph.nodes.push({ id: `file:definitions/${familyRole}.ts`, path: `definitions/${familyRole}.ts`, kind: 'file', familyRole,
      ...(familyRole === 'manifest' ? {} : { owningBlock: 'block:local:api' }) });
  }
  await writeFile(join(root, '.blocks/view/graph.json'), JSON.stringify(graph));
  for (const familyRole of ['contract', 'generator', 'manifest']) {
    assert.equal((await hookCheck(event('Edit', { file_path: `definitions/${familyRole}.ts` }), { root })).decision, 'deny');
  }
});

test('typed block dependencies in cached node metadata provide context without edges', async (t) => {
  const { root, graph } = await fixture(t);
  graph.nodes.push(
    { id: 'file:blocks/widgets/detail.ts', path: 'blocks/widgets/detail.ts', kind: 'file', familyRole: 'manifest', owningBlock: 'block:widgets:detail' },
    { id: 'block:widgets:detail', kind: 'block', family: 'widgets', dependencies: ['block:local:storage'], manifest: {} },
  );
  await writeFile(join(root, '.blocks/view/graph.json'), JSON.stringify(graph));
  assert.match((await hookCheck(event('Read', { file_path: 'blocks/widgets/detail.ts' }), { root })).context, /Dependencies: block:local:storage/);
});

test('native output adds context without granting agent permissions and encodes explicit denial', () => {
  for (const agent of ['claude', 'codex']) {
    assert.equal(formatHookOutput({ decision: 'allow' }, { agent }), null);
    assert.deepEqual(formatHookOutput({ decision: 'allow', context: 'owner' }, { agent }), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'owner' } });
    assert.deepEqual(formatHookOutput({ decision: 'deny', reason: 'boundary' }, { agent }), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'boundary' } });
  }
  assert.equal(formatHookOutput({ decision: 'deny', reason: 'boundary' }, { agent: 'unknown' }), null);
});
