import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { installProject, uninstallProject } from '../src/install.mjs';
import { installationFixture, packageRunner, snapshot } from './helpers/install-fixture.mjs';

test('uninstall previews removals, preserves owner prose and data, and is safe to repeat', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await writeFile(join(root, 'AGENTS.md'), '# Owner policy\n');
  await installProject(root, { agents: ['codex'], version: '0.3.0', runner });
  const before = await snapshot(root);
  const preview = await uninstallProject(root, { dryRun: true });
  assert.ok(preview.diff.some((file) => file.content === null));
  assert.deepEqual(await snapshot(root), before);
  const removed = await uninstallProject(root, { runner });
  assert.equal(removed.complete, true);
  assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /Owner policy/);
  assert.doesNotMatch(await readFile(join(root, 'AGENTS.md'), 'utf8'), /block-beaver:start/);
  const ownerConfig = JSON.parse(before['.blocks/config.json']);
  delete ownerConfig.blockBeaver;
  assert.deepEqual(JSON.parse(await readFile(join(root, '.blocks/config.json'), 'utf8')), ownerConfig);
  assert.equal(await readFile(join(root, '.blocks/baseline.json'), 'utf8'), before['.blocks/baseline.json']);
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).devDependencies?.['block-beaver'], undefined);
  const after = await snapshot(root);
  const repeated = await uninstallProject(root, { runner });
  assert.deepEqual(repeated.changed, []);
  assert.deepEqual(repeated.commands, []);
  assert.deepEqual(await snapshot(root), after);
});

test('explicit data removal removes only .blocks and keeps source and owner policy', async (t) => {
  const root = await installationFixture(t), runner = packageRunner(root);
  await writeFile(join(root, 'AGENTS.md'), '# Owner policy\n');
  await installProject(root, { agents: ['codex'], version: '0.3.0', runner });
  await mkdir(join(root, '.blocks/empty/nested'), { recursive: true });
  await uninstallProject(root, { removeData: true, runner });
  await assert.rejects(readFile(join(root, '.blocks/config.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, '.blocks')), { code: 'ENOENT' });
  assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /Owner policy/);
  assert.match(await readFile(join(root, 'src/index.ts'), 'utf8'), /ready/);
});
