import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planHostSetup } from '../src/install-host.mjs';
import { installCompliance } from '../src/compliance-setup.mjs';

// Keep the developer's own Git configuration out of the disposable fixtures.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

// The pinned majors in this repository's own workflow, read from the "# vN.x.y" comments that
// Dependabot keeps current. The managed CI templates must stay on the same majors.
async function repositoryMajors() {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const majors = {};
  for (const action of ['actions/checkout', 'actions/setup-node']) {
    const found = new Set([...workflow.matchAll(new RegExp(`uses: ${action}@[0-9a-f]{40} # v(\\d+)\\.\\d+\\.\\d+`, 'g'))].map((match) => match[1]));
    assert.equal(found.size, 1, `${action} must be pinned to one major with a # vN.x.y comment in .github/workflows/ci.yml.`);
    majors[action] = [...found][0];
  }
  return majors;
}

const used = (text, action) => [...text.matchAll(new RegExp(`uses: ${action}@(\\S+)`, 'g'))].map((match) => match[1]);

test('managed CI templates use the same action majors as this repository workflows', async (t) => {
  const majors = await repositoryMajors();
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);

  const host = await planHostSetup(root, { version: '0.5.0', config: {}, agents: [] });
  const hosted = host.files.find((entry) => entry.path === '.github/workflows/block-beaver.yml').content;
  for (const [action, major] of Object.entries(majors)) assert.deepEqual(used(hosted, action), [`v${major}`], `install template: ${action}`);

  await writeFile(join(root, 'package.json'), '{}\n');
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
  const init = await installCompliance(root);
  assert.equal(init.ci.github?.status, 'installed', JSON.stringify(init.ci));
  const initialized = await readFile(join(root, '.github/workflows/block-beaver.yml'), 'utf8');
  for (const [action, major] of Object.entries(majors)) assert.deepEqual(used(initialized, action), [`v${major}`], `init template: ${action}`);
});
