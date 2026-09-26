import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateCreateScope, assertCreatePathAbsent } from '../src/create-scope.mjs';
import { validateBlock, validateProposalPatches } from '../src/contracts.mjs';
import { runAgentAdapter } from '../src/agent.mjs';

const graph = (root) => ({ root, fingerprint: 'fingerprint', hashes: { 'src/old.ts': 'old-hash' }, nodes: [{ kind: 'file', path: 'src/old.ts' }], edges: [] });
const manifest = (files) => ({ schemaVersion: 1, id: 'feature', version: 1, name: 'Feature', description: 'Feature description', rationale: 'One boundary', files, dependencies: [], verification: [] });

test('creation scope rejects collisions, ignored and unsafe paths before use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-create-scope-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, '.gitignore'), 'generated/\n');
    await writeFile(join(root, 'src', 'exists.ts'), 'export {}\n');
    await symlink(root, join(root, 'src', 'link'));
    const current = graph(root);
    assert.deepEqual(await validateCreateScope(root, current, ['src/new.ts'], { scope: ['src/old.ts'] }), ['src/new.ts']);
    await assert.rejects(validateCreateScope(root, current, ['src/new.ts', 'src/new.ts']), /Duplicate/);
    await assert.rejects(validateCreateScope(root, current, ['src/old.ts'], { scope: ['src/old.ts'] }), /overlaps/);
    await assert.rejects(validateCreateScope(root, current, ['src/exists.ts']), /already exists/);
    await assert.rejects(validateCreateScope(root, current, ['generated/new.ts']), /ignored/);
    await assert.rejects(validateCreateScope(root, current, ['src/link/new.ts']), /symlink/);
    await assert.rejects(validateCreateScope(root, current, ['../escape.ts']), /Unsafe/);
    await assert.rejects(validateCreateScope(root, current, ['/absolute.ts']), /Unsafe/);
    await writeFile(join(root, 'src', 'new.ts'), 'export {}\n');
    await assert.rejects(assertCreatePathAbsent(root, 'src/new.ts'), /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit create patches require scope, unique paths, valid content and manifest coverage', () => {
  const current = graph('/unused');
  const proposal = { manifest: manifest(['src/new.json']), patches: [{ op: 'create', path: 'src/new.json', content: '{"value":1}\n' }] };
  const options = { scope: ['src/old.ts'], createScope: ['src/new.json'] };
  const good = validateProposalPatches(proposal, current, options);
  assert.equal(good.valid, true);
  assert.equal(validateBlock(proposal.manifest, current, { createdPaths: good.createdPaths }).valid, true);
  assert.equal(validateBlock(proposal.manifest, current).valid, false);
  assert.match(validateProposalPatches({ ...proposal, patches: [] }, current, options).errors[0].message, /requires a create patch/);
  assert.equal(validateProposalPatches({ ...proposal, patches: [proposal.patches[0], proposal.patches[0]] }, current, options).valid, false);
  assert.equal(validateProposalPatches({ ...proposal, patches: [{ ...proposal.patches[0], content: '{broken' }] }, current, options).valid, false);
  assert.equal(validateProposalPatches({ ...proposal, patches: [{ ...proposal.patches[0], path: 'src/elsewhere.json' }] }, current, options).valid, false);
  assert.equal(validateProposalPatches({ ...proposal, patches: [{ path: 'src/old.ts', baseHash: 'stale', content: 'export {}' }] }, current, options).valid, false);
  assert.equal(validateProposalPatches({ manifest: manifest(['src/new.ts']), patches: [{ op: 'create', path: 'src/new.ts', content: 'export function broken( {' }] }, current, { createScope: ['src/new.ts'] }).valid, false);
});

test('agent adapter supports a create-only request without reading a nonexistent source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-create-agent-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const adapter = join(root, 'adapter.mjs');
    await writeFile(adapter, `let input = ''; for await (const chunk of process.stdin) input += chunk; const request = JSON.parse(input); process.stdout.write(JSON.stringify({ protocol: 1, notes: [{ scope: request.scope, createScope: request.createScope, sources: request.sources }], proposals: [{ manifest: { schemaVersion: 1, id: 'feature', version: 1, name: 'Feature', description: 'Feature description', rationale: 'One boundary', files: ['src/new.json'], dependencies: [], verification: [] }, patches: [{ op: 'create', path: 'src/new.json', content: '{"value":1}' }] }] }));`);
    const response = await runAgentAdapter(adapter, { graph: graph(root), createScope: ['src/new.json'] });
    assert.equal(response.proposals[0].check.valid, true);
    assert.deepEqual(response.notes[0], { scope: [], createScope: ['src/new.json'], sources: {} });
  } finally { await rm(root, { recursive: true, force: true }); }
});
