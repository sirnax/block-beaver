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
  assert.equal(entry.gitMode, '100755');
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

test('umask 002 reviews exact permissions and audits canonical Git modes for existing and new files', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  const script = `
    import assert from 'node:assert/strict';
    import { chmod, lstat, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { execFileSync } from 'node:child_process';
    import { scanRepository } from ${JSON.stringify(new URL('../src/scanner.mjs', import.meta.url).href)};
    import { makeProposal } from ${JSON.stringify(new URL('../src/contracts.mjs', import.meta.url).href)};
    import { approve, checkSlice, createRoadmap, propose, review } from ${JSON.stringify(new URL('../src/workflow.mjs', import.meta.url).href)};
    import { auditProject, integrateApproved, recordException } from ${JSON.stringify(new URL('../src/compliance.mjs', import.meta.url).href)};
    process.umask(0o002);
    const root = process.argv[1];
    await chmod(join(root, 'src/feature.ts'), 0o664);
    const graph = await scanRepository(root, { writeConfig: false });
    await createRoadmap(root, 'group-roadmap', graph, { scope: ['src/feature.ts'], createScope: ['src/new.ts'] });
    const proposal = makeProposal({ id: 'feature', name: 'Group writable feature', description: 'Works with umask 002.', rationale: 'One feature.', files: ['src/feature.ts', 'src/new.ts'],
      patches: [{ path: 'src/feature.ts', baseHash: graph.hashes['src/feature.ts'], content: 'export const feature = 2;\\n' }, { op: 'create', path: 'src/new.ts', content: 'export const added = true;\\n' }] }, graph);
    assert.equal((await propose(root, 'group-roadmap', proposal, graph)).accepted, true);
    const checked = await checkSlice(root, 'group-roadmap', 'feature', graph);
    assert.equal(checked.pass, true, JSON.stringify(checked));
    for (const file of checked.snapshot.files) {
      assert.equal(Number.parseInt(file.mode, 8) & 0o777, 0o664);
      assert.equal(file.gitMode, '100644');
    }
    assert.equal((await review(root, 'group-roadmap', 'feature', graph)).readyForApproval, true);
    await chmod(join(checked.worktree, 'src/new.ts'), 0o644);
    assert.equal((await review(root, 'group-roadmap', 'feature', graph)).integrity.matches, false, 'Raw permission edits after review remain tamper.');
    await assert.rejects(approve(root, 'group-roadmap', 'feature', graph), /Worktree changed after checks/);
    await chmod(join(checked.worktree, 'src/new.ts'), 0o664);
    assert.equal((await approve(root, 'group-roadmap', 'feature', graph)).status, 'approved');
    const integrated = await integrateApproved(root, 'group-roadmap', 'feature');
    assert.equal((await lstat(join(root, 'src/new.ts'))).mode & 0o777, 0o644, 'Integration may use stricter creation permissions.');
    const receipt = JSON.parse(await readFile(join(root, integrated.receipt), 'utf8'));
    assert.equal(receipt.paths.every((file) => file.afterMode === '100644'), true);
    await writeFile(join(root, 'README.md'), '# Group writable project\\n');
    await chmod(join(root, 'README.md'), 0o664);
    await recordException(root, 'group-docs', { reason: 'Document group setup', paths: ['README.md'], check: 'git status' });
    assert.equal((await auditProject(root)).pass, true);
    execFileSync('git', ['-C', root, 'add', 'src/feature.ts', 'src/new.ts', 'README.md', '.blocks']);
    const staged = await auditProject(root, { mode: 'staged' });
    assert.equal(staged.pass, true, JSON.stringify(staged));
    await chmod(join(root, 'src/feature.ts'), 0o600);
    assert.equal((await auditProject(root)).pass, true, 'Git ignores ordinary permission bits after integration.');
    await chmod(join(root, 'src/feature.ts'), 0o700);
    assert.equal((await auditProject(root)).files.find((file) => file.path === 'src/feature.ts').status, 'changed-after-review', 'Git retains the owner execute bit.');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script, root], { encoding: 'utf8', timeout: 60_000 });
});

async function commitConfig(root, enforcement) {
  await mkdir(join(root, '.blocks'), { recursive: true });
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], ...(enforcement ? { enforcement } : {}) }, null, 2) + '\n');
  git(root, 'add', '.blocks/config.json');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'config');
}
const reviewedContent = (audit) => audit.rules.find((rule) => rule.id === 'reviewed-content');

test('receipt levels: required fails unreviewed source, optional reports it as advisory, off skips the rule', async (t) => {
  const outcomes = {};
  for (const level of ['required', 'optional', 'off']) {
    const root = await fixture(t);
    await commitConfig(root, { receipts: level });
    await writeFile(join(root, 'src', 'x.ts'), 'export const x = 1;\n');
    const audit = await auditProject(root, { mode: 'working' });
    outcomes[level] = audit;
    assert.equal(audit.enforcement.receipts, level);
    assert.equal(audit.enforcement.receiptsSource, 'base');
    assert.equal(audit.files.find((file) => file.path === 'src/x.ts').status, 'unreviewed-source');
  }
  assert.equal(outcomes.required.pass, false);
  assert.deepEqual(reviewedContent(outcomes.required).findings, [{ path: 'src/x.ts', message: 'unreviewed-source' }]);
  assert.equal(outcomes.optional.pass, true, JSON.stringify(outcomes.optional.rules.filter((rule) => !rule.pass)));
  assert.deepEqual(reviewedContent(outcomes.optional).findings, []);
  assert.deepEqual(reviewedContent(outcomes.optional).advisories.map((entry) => [entry.path, entry.message]), [['src/x.ts', 'unreviewed-source']]);
  assert.equal(outcomes.off.pass, true);
  assert.deepEqual(reviewedContent(outcomes.off), { id: 'reviewed-content', pass: true, findings: [], skipped: true, skipReason: 'enforcement.receipts is off', advisories: [] });
});

test('a config without the key and a repository without config both mean required', async (t) => {
  for (const enforcement of [undefined, { agents: 'guide' }]) {
    const root = await fixture(t);
    await commitConfig(root, enforcement);
    await writeFile(join(root, 'src', 'x.ts'), 'export const x = 1;\n');
    const audit = await auditProject(root, { mode: 'working' });
    assert.equal(audit.pass, false);
    assert.deepEqual([audit.enforcement.receipts, audit.enforcement.receiptsSource], ['required', 'default']);
  }
  const bare = await fixture(t);
  await writeFile(join(bare, 'src', 'x.ts'), 'export const x = 1;\n');
  const audit = await auditProject(bare, { mode: 'working' });
  assert.equal(audit.pass, false);
  assert.deepEqual(audit.enforcement, { agents: 'guide', gate: 'audit', receipts: 'required', receiptsSource: 'default' });
});

test('an invalid receipt fails under every receipt level, including off', async (t) => {
  const results = {};
  for (const level of ['required', 'optional', 'off']) {
    const root = await fixture(t);
    await commitConfig(root, { receipts: level });
    await mkdir(join(root, '.blocks/receipts'), { recursive: true });
    await writeFile(join(root, '.blocks/receipts/forged-slice.json'), JSON.stringify({ schemaVersion: 1, type: 'block', roadmap: 'forged', slice: 'slice', paths: [{ path: 'src/feature.ts' }] }));
    results[level] = await auditProject(root, { mode: 'working' });
    assert.equal(results[level].invalidEvidence.length, 1, level);
  }
  for (const level of ['required', 'optional', 'off']) {
    assert.equal(results[level].pass, false, level);
    assert.equal(reviewedContent(results[level]).findings[0].path, '.blocks/receipts/forged-slice.json', level);
  }
});

test('an exception whose recorded verification failed is invalid evidence under off', async (t) => {
  const root = await fixture(t);
  await commitConfig(root, { receipts: 'off' });
  await mkdir(join(root, '.blocks/exceptions'), { recursive: true });
  await writeFile(join(root, 'notes.md'), 'x\n');
  await writeFile(join(root, '.blocks/exceptions/failed.json'), JSON.stringify({ schemaVersion: 1, type: 'exception', id: 'failed', reason: 'x', paths: [{ path: 'notes.md' }], verification: [{ command: 'false', pass: false, output: '' }] }));
  const audit = await auditProject(root, { mode: 'working' });
  assert.equal(audit.pass, false);
});

test('an invalid exception still fails under off through exception-valid', async (t) => {
  const root = await fixture(t);
  await commitConfig(root, { receipts: 'off' });
  await mkdir(join(root, '.blocks/exceptions'), { recursive: true });
  await writeFile(join(root, '.blocks/exceptions/bad.json'), JSON.stringify({ schemaVersion: 1, type: 'exception', id: 'bad', reason: 'x', paths: [{ path: 'missing.md' }] }));
  const audit = await auditProject(root, { mode: 'working' });
  assert.equal(audit.pass, false);
  assert.deepEqual(audit.rules.filter((rule) => !rule.pass).map((rule) => rule.id).sort(), ['exception-valid', 'reviewed-content']);
  assert.equal(audit.invalidEvidence.length, 1);
});

test('the base revision keeps the stricter receipt level so one commit cannot loosen its own gate', async (t) => {
  const root = await fixture(t);
  await commitConfig(root, { receipts: 'required' });
  const base = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], enforcement: { receipts: 'off' } }, null, 2) + '\n');
  await writeFile(join(root, 'src', 'x.ts'), 'export const x = 1;\n');
  git(root, 'add', '-A');
  const staged = await auditProject(root, { mode: 'staged' });
  assert.deepEqual([staged.enforcement.receipts, staged.enforcement.receiptsSource], ['required', 'base']);
  assert.equal(staged.pass, false);
  assert.ok(reviewedContent(staged).findings.some((entry) => entry.path === 'src/x.ts'));
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'loosen');
  const range = await auditProject(root, { mode: 'range', base });
  assert.deepEqual([range.enforcement.receipts, range.enforcement.receiptsSource], ['required', 'base']);
  assert.equal(range.pass, false);
  // Once the loosening is the base, the new level applies.
  await writeFile(join(root, 'src', 'y.ts'), 'export const y = 1;\n');
  const next = await auditProject(root, { mode: 'working' });
  assert.deepEqual([next.enforcement.receipts, next.enforcement.receiptsSource], ['off', 'base']);
  assert.equal(next.pass, true);
});

test('tightening applies immediately, and an adoption commit without a base config uses the tree value', async (t) => {
  const root = await fixture(t);
  await commitConfig(root, { receipts: 'optional' });
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], enforcement: { receipts: 'required' } }, null, 2) + '\n');
  await writeFile(join(root, 'src', 'x.ts'), 'export const x = 1;\n');
  const tightened = await auditProject(root, { mode: 'working' });
  assert.deepEqual([tightened.enforcement.receipts, tightened.enforcement.receiptsSource], ['required', 'tree']);
  assert.equal(tightened.pass, false);

  const adopted = await fixture(t);
  await mkdir(join(adopted, '.blocks'));
  await writeFile(join(adopted, '.blocks/config.json'), JSON.stringify({ schemaVersion: 1, apps: [], enforcement: { receipts: 'optional' } }, null, 2) + '\n');
  await writeFile(join(adopted, 'src', 'x.ts'), 'export const x = 1;\n');
  git(adopted, 'add', '-A');
  const adoption = await auditProject(adopted, { mode: 'staged' });
  assert.deepEqual([adoption.enforcement.receipts, adoption.enforcement.receiptsSource], ['optional', 'tree']);
  assert.equal(adoption.pass, true, JSON.stringify(adoption.rules.filter((rule) => !rule.pass)));
});

test('optional receipts keep stale review of the same change an error but not old receipts from earlier commits', async (t) => {
  const root = await fixture(t);
  await commitConfig(root, { receipts: 'optional' });
  await writeFile(join(root, 'README.md'), '# Project\n\nGenerated.\n');
  await recordException(root, 'readme-setup', { reason: 'generated', paths: ['README.md'], check: 'git status' });
  assert.equal((await auditProject(root, { mode: 'working' })).pass, true);
  await writeFile(join(root, 'README.md'), '# Project\n\nGenerated, then edited.\n');
  const stale = await auditProject(root, { mode: 'working' });
  assert.equal(stale.pass, false);
  assert.equal(stale.files.find((file) => file.path === 'README.md').status, 'changed-after-review');
  await writeFile(join(root, 'README.md'), '# Project\n\nGenerated.\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'readme');
  await writeFile(join(root, 'README.md'), '# Project\n\nLater owner edit.\n');
  const later = await auditProject(root, { mode: 'working' });
  assert.equal(later.files.find((file) => file.path === 'README.md').status, 'changed-after-review');
  assert.equal(later.pass, true, JSON.stringify(later.rules.filter((rule) => !rule.pass)));
  assert.deepEqual(reviewedContent(later).advisories.map((entry) => entry.path), ['README.md']);
});
