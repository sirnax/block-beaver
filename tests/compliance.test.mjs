import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanRepository } from '../src/scanner.mjs';
import { makeProposal } from '../src/contracts.mjs';
import { approve, checkSlice, createRoadmap, propose, review } from '../src/workflow.mjs';
import { auditProject, integrateApproved, recordException } from '../src/compliance.mjs';

function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }
const cli = fileURLToPath(new URL('../bin/block-beaver.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-compliance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'feature.ts'), 'export const feature = 1;\n');
  await writeFile(join(root, 'README.md'), '# Project\n');
  await writeFile(join(root, '.gitignore'), '.blocks/worktrees/\n.blocks/view/\n');
  execFileSync('git', ['init', '-q', root]);
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
  return root;
}

test('direct source edits fail; reviewed integration passes staged and CI audits', async (t) => {
  const root = await fixture(t);
  const base = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'src', 'feature.ts'), 'export const feature = 99;\n');
  git(root, 'add', 'src/feature.ts');
  assert.equal((await auditProject(root, { mode: 'staged' })).files[0].status, 'unreviewed-source');
  assert.throws(() => execFileSync(process.execPath, [cli, 'audit', '--root', root, '--staged', '--format', 'json'], { stdio: 'pipe' }), (error) => error.status === 2);
  await assert.rejects(recordException(root, 'source-shortcut', { reason: 'shortcut', paths: ['src/feature.ts'], check: 'git status' }), /cannot cover source/);
  git(root, 'restore', '--staged', 'src/feature.ts');
  git(root, 'restore', 'src/feature.ts');

  const graph = await scanRepository(root, { writeConfig: false });
  await createRoadmap(root, 'feature-roadmap', graph, { scope: ['src/feature.ts'] });
  const proposal = makeProposal({ id: 'feature', name: 'Feature', description: 'Reviewed feature.', rationale: 'One feature.', files: ['src/feature.ts'],
    patches: [{ path: 'src/feature.ts', baseHash: graph.hashes['src/feature.ts'], content: 'export const feature = 2;\n' }] }, graph);
  assert.equal((await propose(root, 'feature-roadmap', proposal, graph)).accepted, true);
  assert.equal((await checkSlice(root, 'feature-roadmap', 'feature', graph)).pass, true);
  const reviewed = await review(root, 'feature-roadmap', 'feature', graph);
  assert.equal(reviewed.integrity.matches, true);
  assert.equal(reviewed.readyForApproval, true);
  assert.equal(reviewed.lastVerification.pass, true);
  assert.equal((await approve(root, 'feature-roadmap', 'feature', graph)).status, 'approved');
  const integration = await integrateApproved(root, 'feature-roadmap', 'feature');
  assert.equal(integration.integrated, true);
  git(root, 'add', 'src/feature.ts');
  assert.equal((await auditProject(root, { mode: 'staged' })).pass, false, 'Evidence must be staged with the source change.');
  git(root, 'add', 'src/feature.ts', '.blocks');
  const staged = await auditProject(root, { mode: 'staged' });
  assert.equal(staged.pass, true, JSON.stringify(staged));
  assert.deepEqual(staged.files.map((file) => file.status), ['approved-block', 'approved-block']);
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'reviewed feature');
  assert.equal((await auditProject(root, { mode: 'range', base })).pass, true);
  await writeFile(join(root, 'src', 'feature.ts'), 'export const feature = 3;\n');
  git(root, 'add', 'src/feature.ts');
  assert.equal((await auditProject(root, { mode: 'staged' })).files.find((file) => file.path === 'src/feature.ts').status, 'changed-after-review');
});

test('new source, deletion, symlink, and stale CI base fail closed', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src', 'new.ts'), 'export const added = true;\n');
  assert.equal((await auditProject(root)).files.find((file) => file.path === 'src/new.ts').status, 'unreviewed-source');
  git(root, 'add', 'src/new.ts');
  assert.equal((await auditProject(root, { mode: 'staged' })).pass, false);
  git(root, 'restore', '--staged', 'src/new.ts');
  await rm(join(root, 'src', 'new.ts'));
  git(root, 'rm', 'src/feature.ts');
  assert.equal((await auditProject(root, { mode: 'staged' })).files[0].status, 'unsupported-deletion');
  await symlink('README.md', join(root, 'LINK.md'));
  assert.equal((await auditProject(root)).files.find((file) => file.path === 'LINK.md').status, 'unsupported-file-type');
  await assert.rejects(recordException(root, 'linked', { reason: 'link', paths: ['LINK.md'], check: 'git status' }), /not a regular file/);
  await assert.rejects(auditProject(root, { mode: 'range', base: '0'.repeat(40) }), /not an ancestor/);
});

test('reviewed executable files retain Git mode and reject index or exact-byte changes after review', async (t) => {
  const root = await fixture(t);
  if (process.platform !== 'win32') await chmod(join(root, 'src/feature.ts'), 0o755);
  git(root, 'update-index', '--chmod=+x', 'src/feature.ts');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'executable base');
  git(root, 'config', 'core.filemode', 'false');
  const graph = await scanRepository(root, { writeConfig: false });
  await createRoadmap(root, 'executable-roadmap', graph, { scope: ['src/feature.ts'] });
  const proposal = makeProposal({ id: 'feature', name: 'Executable feature', description: 'Retain executable metadata.', rationale: 'One feature.', files: ['src/feature.ts'],
    patches: [{ path: 'src/feature.ts', baseHash: graph.hashes['src/feature.ts'], content: 'export const feature = 2;\n' }] }, graph);
  assert.equal((await propose(root, 'executable-roadmap', proposal, graph)).accepted, true);
  const checked = await checkSlice(root, 'executable-roadmap', 'feature', graph);
  assert.equal(checked.pass, true);
  const entry = checked.snapshot.files.find((file) => file.path === 'src/feature.ts');
  assert.equal(entry.mode, (await lstat(join(checked.worktree, entry.path))).mode.toString(8), 'Review still records exact native permissions.');
  assert.equal(entry.indexMode, '100755');
  if (process.platform === 'win32') assert.equal(entry.gitMode, '100755');
  assert.equal((await review(root, 'executable-roadmap', 'feature', graph)).readyForApproval, true);

  git(checked.worktree, 'update-index', '--chmod=-x', 'src/feature.ts');
  assert.equal((await review(root, 'executable-roadmap', 'feature', graph)).integrity.matches, false);
  await assert.rejects(approve(root, 'executable-roadmap', 'feature', graph), /Worktree changed after checks/);
  git(checked.worktree, 'update-index', '--chmod=+x', 'src/feature.ts');
  assert.equal((await approve(root, 'executable-roadmap', 'feature', graph)).status, 'approved');
  const ledgerPath = join(root, '.blocks/roadmaps/executable-roadmap/events.jsonl');
  const originalLedger = await readFile(ledgerPath, 'utf8');
  const legacyEvents = originalLedger.trim().split('\n').map((line) => JSON.parse(line));
  const legacySnapshot = legacyEvents.findLast((event) => event.type === 'checks-passed').result.snapshot;
  legacySnapshot.files = legacySnapshot.files.map(({ indexMode, gitMode, ...file }) => file);
  legacySnapshot.digest = createHash('sha256').update(JSON.stringify({ baseCommit: legacySnapshot.baseCommit, files: legacySnapshot.files })).digest('hex');
  await writeFile(ledgerPath, legacyEvents.map((event) => JSON.stringify(event)).join('\n') + '\n');
  if (process.platform === 'win32') {
    await assert.rejects(integrateApproved(root, 'executable-roadmap', 'feature'), /lacks Windows Git mode evidence/);
    assert.equal(await readFile(join(root, 'src/feature.ts'), 'utf8'), 'export const feature = 1;\n', 'Legacy Windows evidence fails before integration writes.');
    await writeFile(ledgerPath, originalLedger);
  }
  const integrated = await integrateApproved(root, 'executable-roadmap', 'feature');
  const receipt = JSON.parse(await readFile(join(root, integrated.receipt), 'utf8'));
  assert.equal(receipt.paths.find((file) => file.path === 'src/feature.ts').afterMode, '100755');
  assert.equal((await auditProject(root)).pass, true);
  git(root, 'add', 'src/feature.ts', '.blocks');
  const staged = await auditProject(root, { mode: 'staged' });
  assert.equal(staged.pass, true, JSON.stringify(staged));

  git(root, 'update-index', '--chmod=-x', 'src/feature.ts');
  assert.equal((await auditProject(root, { mode: 'staged' })).files.find((file) => file.path === 'src/feature.ts').status, 'changed-after-review');
  git(root, 'update-index', '--chmod=+x', 'src/feature.ts');
  await writeFile(join(root, 'src/feature.ts'), 'export const feature = 2;\r\n');
  assert.equal((await auditProject(root)).files.find((file) => file.path === 'src/feature.ts').status, 'changed-after-review');
  git(root, 'add', 'src/feature.ts');
  assert.equal((await auditProject(root, { mode: 'staged' })).files.find((file) => file.path === 'src/feature.ts').status, 'changed-after-review');
});

test('non-source exceptions bind verification to exact changed content', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'README.md'), '# Updated\n');
  assert.equal((await auditProject(root)).files[0].status, 'missing-exception');
  await recordException(root, 'docs-update', { reason: 'Clarify usage', paths: ['README.md'], check: 'git status' });
  git(root, 'add', 'README.md', '.blocks/exceptions');
  assert.equal((await auditProject(root, { mode: 'staged' })).pass, true);
  await writeFile(join(root, 'README.md'), '# Changed again\n');
  git(root, 'add', 'README.md');
  assert.equal((await auditProject(root, { mode: 'staged' })).files[0].status, 'changed-after-review');
  const exception = JSON.parse(await readFile(join(root, '.blocks/exceptions/docs-update.json'), 'utf8'));
  exception.verification[0].pass = false;
  await writeFile(join(root, '.blocks/exceptions/docs-update.json'), JSON.stringify(exception));
  git(root, 'add', '.blocks/exceptions');
  assert.equal((await auditProject(root, { mode: 'staged' })).pass, false);
});
