import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('bundled templates produce LF output even from a CRLF source checkout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-crlf-templates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  for (const name of ['install-templates.mjs', 'package-manager.mjs', 'project-files.mjs']) {
    await copyFile(new URL(`../src/${name}`, import.meta.url), join(root, 'src', name));
  }
  for (const name of ['block-workflow.md', 'agent-skill/SKILL.md', 'agent-skill/references/workflow.md', 'agent-skill/references/apps.md', 'legacy/0.1.1-workflow.md', 'legacy/0.2.0-workflow.md']) {
    const target = join(root, 'templates', name);
    await mkdir(dirname(target), { recursive: true });
    const source = await readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');
    await writeFile(target, source.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
  }
  const { readInstallTemplates } = await import(pathToFileURL(join(root, 'src/install-templates.mjs')).href);
  const templates = await readInstallTemplates();
  assert.ok(templates.skill.startsWith('---\nname: block-beaver\n'));
  for (const text of [templates.workflow, templates.skill, ...templates.legacyWorkflows, ...Object.values(templates.references)]) {
    assert.ok(text.includes('\n'));
    assert.ok(!text.includes('\r'));
  }
});
