import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanRepository } from '../src/scanner.mjs';
import { makeProposal } from '../src/contracts.mjs';
import { createRoadmap, propose, repair, checkSlice, review, approve, reject, resume } from '../src/workflow.mjs';

test('roadmap replays approvals and rejects stale source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'block-studio-flow-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, '.gitignore'), '.blocks/\n');
    await writeFile(join(root, 'src', 'feature.ts'), 'export function feature() { return true }\n');
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial']);
    const graph = await scanRepository(root);
    await createRoadmap(root, 'first-feature', graph, { scope: ['src/feature.ts'] });
    const candidate = makeProposal({ id: 'feature', name: 'Feature', description: 'A test feature.', rationale: 'One cohesive feature.', files: ['src/feature.ts'], patches: [{ path: 'src/feature.ts', baseHash: graph.hashes['src/feature.ts'], content: 'export function feature() { return 42 }\n' }] }, graph);
    assert.equal((await propose(root, 'first-feature', candidate, graph)).accepted, true);
    assert.equal((await checkSlice(root, 'first-feature', 'feature', graph)).pass, true);
    assert.equal((await review(root, 'first-feature', 'feature', graph)).target, '.blocks/manifests/feature.json');
    const applied = await approve(root, 'first-feature', 'feature', graph);
    assert.equal(applied.status, 'approved');
    assert.equal(await readFile(join(applied.worktree, 'src', 'feature.ts'), 'utf8'), 'export function feature() { return 42 }\n');
    assert.equal((await resume(root, 'first-feature')).slices.feature.status, 'approved');

    await createRoadmap(root, 'changed-feature', graph, { scope: ['src/feature.ts'] });
    const second = makeProposal({ id: 'changed', name: 'Changed', description: 'Another test.', rationale: 'A separate cohesive feature.', files: ['src/feature.ts'] }, graph);
    await propose(root, 'changed-feature', second, graph);
    await writeFile(join(root, 'src', 'feature.ts'), 'export function feature() { return false }\n');
    const changedGraph = await scanRepository(root);
    assert.equal((await checkSlice(root, 'changed-feature', 'changed', changedGraph)).drift, true);
    await assert.rejects(approve(root, 'changed-feature', 'changed', changedGraph));
    await reject(root, 'changed-feature', 'changed', 'Source changed');
    assert.equal((await resume(root, 'changed-feature')).slices.changed.status, 'rejected');

    await createRoadmap(root, 'failing-feature', changedGraph, { scope: ['src/feature.ts'] });
    const failing = makeProposal({ id: 'failing', name: 'Failing', description: 'A failing check.', rationale: 'Exercise failed verification.', files: ['src/feature.ts'], verification: ['false'] }, changedGraph);
    await propose(root, 'failing-feature', failing, changedGraph);
    const failedCheck = await checkSlice(root, 'failing-feature', 'failing', changedGraph);
    assert.equal(failedCheck.pass, false);
    assert.equal(failedCheck.verification[0].pass, false);
    assert.equal((await resume(root, 'failing-feature')).slices.failing.status, 'failed');
    await assert.rejects(approve(root, 'failing-feature', 'failing', changedGraph));
    const fixed = makeProposal({ id: 'failing', name: 'Failing', description: 'A fixed check.', rationale: 'Exercise a bounded repair.', files: ['src/feature.ts'], verification: [] }, changedGraph);
    assert.equal((await repair(root, 'failing-feature', 'failing', fixed, changedGraph)).accepted, true);
    assert.equal((await resume(root, 'failing-feature')).slices.failing.status, 'proposed');
    assert.equal((await checkSlice(root, 'failing-feature', 'failing', changedGraph)).pass, true);
    assert.equal((await approve(root, 'failing-feature', 'failing', changedGraph)).status, 'approved');
  } finally { await rm(root, { recursive: true, force: true }); }
});
