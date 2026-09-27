import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { initializeProject } from '../src/project-integration.mjs';
import { updateProject } from '../src/block-map.mjs';
import { watchProject } from '../src/project-watch.mjs';

const cli = fileURLToPath(new URL('../bin/block-beaver.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'feature.ts'), 'export const feature = 1;\n');
  return root;
}
const read = (root, path) => readFile(join(root, path), 'utf8');
const block = (id, extra = {}) => ({ schemaVersion: 1, id, version: 1, name: id, description: 'A feature', rationale: 'One feature boundary', files: ['src/feature.ts'], dependencies: [], verification: [], ...extra });

test('CLI setup installs portable guidance in an unrelated project and preserves instructions on repeat', async (t) => {
  const root = await fixture(t);
  const original = '# Project rules\r\n\r\nKeep our formatting.\r\n';
  await writeFile(join(root, 'AGENTS.md'), original);
  await writeFile(join(root, 'CLAUDE.md'), 'Use the team conventions.');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' }));
  const result = run('init');
  assert.equal(result.initialized, true);
  const agents = await read(root, 'AGENTS.md');
  assert.ok(agents.startsWith(original));
  assert.match(agents, /\.blocks\/WORKFLOW.md/);
  assert.ok((await read(root, 'CLAUDE.md')).startsWith('Use the team conventions.'));
  assert.match(await read(root, '.cursor/rules/block-beaver.mdc'), /^---\n[\s\S]*alwaysApply: true\n---/);
  assert.match(await read(root, '.github/copilot-instructions.md'), /block-beaver update --root \./);
  const guide = await read(root, '.blocks/WORKFLOW.md');
  assert.match(guide, /plan ROADMAP/);
  assert.ok(!guide.includes(root));
  assert.ok(!guide.includes(fileURLToPath(new URL('..', import.meta.url))));
  assert.match(await read(root, '.blocks/.gitignore'), /\/view\//);
  const graph = JSON.parse(await read(root, '.blocks/view/graph.json'));
  assert.equal(graph.root, '.');
  assert.equal(graph.summary.files, 1);
  const beforeTime = (await stat(join(root, '.blocks/view/index.html'))).mtimeMs;
  assert.deepEqual(run('init').changed, []);
  assert.equal((await stat(join(root, '.blocks/view/index.html'))).mtimeMs, beforeTime);
  assert.equal(await read(root, 'AGENTS.md'), agents);
  const baseline = run('update');
  await writeFile(join(root, 'src/feature.ts'), 'export function changed() { return 2; }\n');
  const update = run('update');
  assert.notEqual(update.revision, baseline.revision);
  assert.ok(update.changed.includes('.blocks/view/graph.json'));
});

test('setup can target one editor and refuses ambiguous or conflicting content before installing rules', async (t) => {
  const root = await fixture(t);
  await initializeProject(root, { editor: 'claude' });
  await assert.rejects(read(root, 'AGENTS.md'), { code: 'ENOENT' });
  const before = '<!-- block-beaver:start -->\nkeep my unfinished section';
  await writeFile(join(root, 'AGENTS.md'), before);
  await assert.rejects(initializeProject(root), /Ambiguous/);
  assert.equal(await read(root, 'AGENTS.md'), before);
  await assert.rejects(read(root, '.cursor/rules/block-beaver.mdc'), { code: 'ENOENT' });
  await assert.rejects(initializeProject(root, { editor: 'unknown' }), /Editor must/);
});

test('setup refuses symlink and shared-file outputs without changing their targets', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(outside, 'instructions.md'), 'Private project instructions');
  await symlink(join(outside, 'instructions.md'), join(root, 'AGENTS.md'));
  await assert.rejects(initializeProject(root), /symlink/);
  assert.equal(await read(outside, 'instructions.md'), 'Private project instructions');
  await rm(join(root, 'AGENTS.md'));
  await link(join(outside, 'instructions.md'), join(root, 'AGENTS.md'));
  await assert.rejects(initializeProject(root), /independent regular file/);
  await rm(join(root, 'AGENTS.md'));
  await symlink(outside, join(root, '.blocks'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(initializeProject(root), /symlink/);
  await assert.rejects(read(outside, 'WORKFLOW.md'), { code: 'ENOENT' });
});

test('map regeneration reflects block dependencies and safely renders repository text', async (t) => {
  const root = await fixture(t);
  await initializeProject(root, { editor: 'agents' });
  await mkdir(join(root, '.blocks/manifests'));
  await writeFile(join(root, '.blocks/manifests/feature.json'), JSON.stringify(block('feature', { name: '</script><img src=x onerror=alert(1)>', dependencies: ['block:local:helper'] })));
  await writeFile(join(root, '.blocks/manifests/helper.json'), JSON.stringify(block('helper')));
  const result = await updateProject(root);
  const html = await read(root, result.html);
  assert.match(html, /&lt;\/script&gt;&lt;img/);
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /depends-on → helper/);
  assert.equal(result.graph.summary.blocks, 2);
  assert.match(html, /src\/feature.ts/);
  assert.deepEqual((await updateProject(root)).changed, []);
  await writeFile(join(root, '.blocks/manifests/helper.json'), JSON.stringify(block('helper', { description: 'A changed contract' })));
  assert.notEqual((await updateProject(root)).revision, result.revision);
});

test('live map refreshes after edits and serves only the selected project view', async (t) => {
  const root = await fixture(t);
  await initializeProject(root, { editor: 'agents' });
  const session = await watchProject(root, { port: 0, interval: 100 });
  t.after(() => session.close());
  const initial = await fetch(`${session.url}/_revision`).then((r) => r.json());
  const html = await fetch(session.url).then((r) => r.text());
  assert.match(html, /Live updates enabled/);
  assert.match(html, /fetch\('\/_revision'/);
  assert.equal((await fetch(`${session.url}/AGENTS.md`)).status, 404);
  assert.equal((await fetch(session.url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(session.url, { headers: { origin: 'https://example.com' } })).status, 403);
  await writeFile(join(root, 'src/new.ts'), 'export const added = true;\n');
  let current = initial;
  const deadline = Date.now() + 5000;
  while (current.revision === initial.revision && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await fetch(`${session.url}/_revision`).then((r) => r.json());
  }
  assert.notEqual(current.revision, initial.revision);
  assert.match(await fetch(session.url).then((r) => r.text()), /src\/new.ts/);
  assert.match(await read(root, '.blocks/view/index.html'), /src\/new.ts/);
});
