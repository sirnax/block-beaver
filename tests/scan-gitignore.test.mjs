import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanRepository } from '../src/scanner.mjs';
import { attachProjectRegistry } from '../src/adapter.mjs';
import { discoverFiles } from '../src/families/glob.mjs';

async function fixture(t, files, { git = true, track = true } = {}) {
  const container = await mkdtemp(join(tmpdir(), 'block-beaver-gitscan-'));
  t.after(() => rm(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repo = join(container, 'repo');
  await mkdir(repo);
  if (git) execFileSync('git', ['init', '-q', repo]);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  // Stage everything not ignored, except files a test wants left untracked.
  if (git && track) execFileSync('git', ['-C', repo, 'add', '-A', '--', '.', ':!src/untracked.ts']);
  return repo;
}
const base = {
  '.gitignore': 'public/sw.js\n',
  'package.json': '{"name":"x","private":true}\n',
  'src/main.ts': 'export const main = 1;\n',
  'public/sw.js': 'self.addEventListener("fetch", () => {});\n',
};
const quiet = { writeConfig: false };
const files = (graph) => graph.nodes.filter((node) => node.kind === 'file').map((node) => node.path).sort();

test('git work tree scans skip gitignored files, plain trees and subdirectory roots behave', async (t) => {
  const repo = await fixture(t, { ...base, 'src/untracked.ts': 'export const u = 1;\n' });
  assert.deepEqual(files(await scanRepository(repo, quiet)), ['src/main.ts', 'src/untracked.ts'], 'untracked non-ignored files are scanned');
  assert.ok(!(await discoverFiles(repo)).includes('public/sw.js'));
  assert.ok((await discoverFiles(repo)).includes('src/untracked.ts'));
  const plain = await fixture(t, base, { git: false });
  assert.deepEqual(files(await scanRepository(plain, quiet)), ['public/sw.js', 'src/main.ts'], 'outside git the plain walk is used');
  assert.ok((await discoverFiles(plain)).includes('public/sw.js'));
  const nested = await fixture(t, { '.gitignore': 'app/gen.ts\n', 'app/a.ts': 'export const a = 1;\n', 'app/gen.ts': 'export const g = 1;\n', 'README.md': 'x\n' }, {});
  assert.deepEqual(files(await scanRepository(join(nested, 'app'), quiet)), ['a.ts'], 'a subdirectory scan root maps paths relative to itself');
});

test('a fresh git init with nothing tracked falls back to the plain walk (staged snapshot shape)', async (t) => {
  const repo = await fixture(t, base, { track: false });
  assert.deepEqual(files(await scanRepository(repo, quiet)), ['public/sw.js', 'src/main.ts']);
});

test('config ignore still applies on top of the git listing', async (t) => {
  const repo = await fixture(t, { ...base, '.blocks/config.json': JSON.stringify({ schemaVersion: 1, apps: [], ignore: ['src/skipped.ts'] }), 'src/skipped.ts': 'export const s = 1;\n' });
  assert.deepEqual(files(await scanRepository(repo, quiet)), ['src/main.ts']);
});

test('imports of gitignored files and registered view exports are not unresolved; ignored files still are', async (t) => {
  const repo = await fixture(t, {
    ...base,
    '.blocks/config.json': JSON.stringify({ schemaVersion: 1, apps: [], ignore: ['src/skipped.ts'] }),
    '.blocks/view-exports.json': JSON.stringify([{ format: 'module', path: 'src/view.generated.ts' }]),
    'src/view.generated.ts': 'export const VIEW = 1;\n',
    'src/skipped.ts': 'export const s = 1;\n',
    'src/main.ts': 'import "../public/sw.js";\nimport { VIEW } from "./view.generated";\nimport { s } from "./skipped";\nexport const main = [VIEW, s];\n',
  });
  const graph = await scanRepository(repo, quiet);
  assert.deepEqual(graph.resolutionReport.map((entry) => entry.specifier), ['./skipped']);
  assert.ok(!graph.edges.some((edge) => edge.to === 'file:public/sw.js' || edge.to === 'file:src/view.generated.ts'));
  assert.ok(graph.excludedKnown.has('public/sw.js') && graph.excludedKnown.has('src/view.generated.ts') && !graph.excludedKnown.has('src/skipped.ts'));
  assert.ok(!Object.keys(graph).includes('excludedKnown') && !JSON.stringify(graph).includes('excludedKnown'));
});

test('packageImports records packages, subpaths and type-only imports without changing graph JSON', async (t) => {
  const repo = await fixture(t, {
    'package.json': '{"name":"x","private":true}\n',
    'src/a.ts': [
      'import react from "react";',
      'import type { Foo } from "pkg-a";',
      'import { type Bar, type Baz } from "pkg-b/sub/path";',
      'import { type Qux, value } from "@scope/pkg/deep";',
      'import fs from "node:fs";',
      'export type { T } from "pkg-c";',
      'export { type U } from "pkg-d";',
      'import "./b";',
      'export const a = [react, value, fs];',
    ].join('\n') + '\n',
    'src/b.ts': 'export const b = 1;\n',
  });
  const graph = await scanRepository(repo, quiet);
  assert.deepEqual(graph.packageImports, [
    { file: 'src/a.ts', package: 'react', specifier: 'react', line: 1, typeOnly: false },
    { file: 'src/a.ts', package: 'pkg-a', specifier: 'pkg-a', line: 2, typeOnly: true },
    { file: 'src/a.ts', package: 'pkg-b', specifier: 'pkg-b/sub/path', line: 3, typeOnly: true },
    { file: 'src/a.ts', package: '@scope/pkg', specifier: '@scope/pkg/deep', line: 4, typeOnly: false },
    { file: 'src/a.ts', package: 'pkg-c', specifier: 'pkg-c', line: 6, typeOnly: true },
    { file: 'src/a.ts', package: 'pkg-d', specifier: 'pkg-d', line: 7, typeOnly: true },
  ]);
  assert.ok(!JSON.stringify(graph).includes('packageImports'));
  await attachProjectRegistry(graph, { config: { schemaVersion: 1, map: {} } });
  assert.equal(graph.packageImports.length, 6, 'survives attachProjectRegistry');
  const again = await scanRepository(repo, quiet);
  assert.deepEqual(again.packageImports, graph.packageImports, 'a cached rescan keeps the records');
  const normalize = (value) => JSON.stringify({ ...value, scannedAt: 0 });
  const plain = await fixture(t, { 'package.json': '{"name":"x","private":true}\n', 'src/b.ts': 'export const b = 1;\n' }, { git: false });
  const withGit = await fixture(t, { 'package.json': '{"name":"x","private":true}\n', 'src/b.ts': 'export const b = 1;\n' });
  const strip = (value) => normalize({ ...value, root: '' });
  assert.equal(strip(await scanRepository(plain, quiet)), strip(await scanRepository(withGit, quiet)), 'git and plain scans of an unchanged tree serialize identically');
});

test('one operation scope lists ignored files once, and a file created later in it is still scanned', async (t) => {
  const { gitScope, gitFileSet } = await import('../src/git-file-set.mjs');
  const repo = await fixture(t, base);
  await gitScope.run(new Map(), async () => {
    assert.equal(gitFileSet(repo), gitFileSet(repo), 'the scope reuses one listing');
    assert.deepEqual(files(await scanRepository(repo, quiet)), ['src/main.ts']);
    // A generated output written mid-command is not in the cached listing, yet must not be dropped.
    await writeFile(join(repo, 'src/generated.ts'), 'export const g = 1;\n');
    assert.deepEqual(files(await scanRepository(repo, quiet)), ['src/generated.ts', 'src/main.ts']);
    assert.ok((await discoverFiles(repo)).includes('src/generated.ts'));
  });
  assert.notEqual(gitFileSet(repo), gitFileSet(repo), 'outside a scope every call lists afresh');
});
