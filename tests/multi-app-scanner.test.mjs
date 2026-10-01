import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scanRepository } from '../src/scanner.mjs';

async function fixture(files, run) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-multi-'));
  await promisify(execFile)('git', ['init', '-q'], { cwd: root });
  const put = async (path, text) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), typeof text === 'string' ? text : JSON.stringify(text)); };
  try { for (const [path, text] of Object.entries(files)) await put(path, text); await run(root, put); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const node = (graph, path) => graph.nodes.find((item) => item.id === `file:${path}`);
const imports = (graph, path) => graph.edges.filter((edge) => edge.from === `file:${path}` && ['imports', 'reexports'].includes(edge.kind));

test('home compiler options govern aliases, dynamic imports, reexports, require and app reachability', async () => {
  await fixture({
    '.blocks/config.json': { schemaVersion: 1, apps: [
      { id: 'web', root: '.', tsconfig: 'tsconfig.json', entries: ['src/main.ts'], source: 'config' },
      { id: 'admin', root: 'apps/admin', tsconfig: 'apps/admin/tsconfig.json', entries: ['apps/admin/main.ts'], source: 'config' },
      { id: 'worker', root: 'worker', tsconfig: 'worker/tsconfig.json', entries: ['worker/main.ts'], source: 'config' },
    ], ignore: ['archive/**'] },
    'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['src/*'], '@local/*': ['src/*'] } }, include: ['src/**/*.ts', 'apps/**/*.ts'] },
    'apps/admin/tsconfig.json': { extends: '../../tsconfig.json', compilerOptions: { baseUrl: '../..', paths: { '@shared/*': ['src/*'], '@local/*': ['apps/admin/*'] } }, include: ['*.ts', '../../src/**/*.ts'] },
    'worker/tsconfig.json': { compilerOptions: { baseUrl: '..', paths: { '@shared/*': ['src/*'] } }, include: ['*.ts'] },
    'src/main.ts': 'export { value } from "./shared";\n',
    'src/shared.ts': 'export const value = 1;',
    'src/local.ts': 'export const value = 2;',
    'apps/admin/main.ts': 'import "@local/local";\nimport("@shared/shared");\nrequire("./required");\nimport "./missing";',
    'apps/admin/local.ts': 'export const value = 3;',
    'apps/admin/required.ts': 'export const value = 4;',
    'worker/main.ts': 'import "@shared/shared";',
    'worker/unreachable.ts': 'export const unused = true;',
    'scripts/tool.ts': 'export const script = true;',
    'archive/old.ts': 'export const old = true;',
  }, async (root) => {
    const graph = await scanRepository(root, { writeConfig: false });
    assert.equal(graph.schemaVersion, 2);
    assert.equal(node(graph, 'apps/admin/main.ts').app, 'admin');
    // The deepest including tsconfig owns shared files, even beyond its root.
    assert.equal(node(graph, 'src/shared.ts').app, 'admin');
    assert.equal(node(graph, 'scripts/tool.ts').app, null);
    assert.equal(node(graph, 'archive/old.ts'), undefined);
    assert.deepEqual(imports(graph, 'apps/admin/main.ts').map((edge) => edge.to), ['file:apps/admin/local.ts', 'file:src/shared.ts', 'file:apps/admin/required.ts']);
    assert.equal(imports(graph, 'src/main.ts')[0].kind, 'reexports');
    assert.equal(imports(graph, 'worker/main.ts')[0].crossApp, true);
    assert.deepEqual(node(graph, 'src/shared.ts').usedBy, ['admin', 'web', 'worker']);
    assert.ok(graph.unreachableFiles.includes('worker/unreachable.ts'));
    assert.deepEqual(graph.resolutionReport.map(({ app, file, line, specifier }) => ({ app, file, line, specifier })), [{ app: 'admin', file: 'apps/admin/main.ts', line: 4, specifier: './missing' }]);
    assert.equal(graph.apps.find((app) => app.id === 'admin').health.unresolvedImports, 1);
    await assert.rejects(scanRepository(root, { writeConfig: false, strict: true }), /admin apps\/admin\/main.ts:4/);
  });
});

test('repeated scans refresh changed dependencies, source inventories and compiler options', async () => {
  await fixture({
    '.blocks/config.json': { schemaVersion: 1, apps: [{ id: 'app', root: '.', tsconfig: 'tsconfig.json', entries: ['src/main.ts'] }] },
    'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@target': ['src/a.ts'] } }, include: ['src/*.ts'] },
    'src/main.ts': 'import { a } from "@target"; export function run(){ a() }',
    'src/a.ts': 'export function a(){}',
    'src/b.ts': 'export function b(){}',
  }, async (root, put) => {
    const first = await scanRepository(root, { writeConfig: false });
    const repeat = await scanRepository(root, { writeConfig: false });
    assert.deepEqual(repeat.nodes, first.nodes);
    assert.deepEqual(repeat.edges, first.edges);
    await put('src/a.ts', 'export function renamed(){}');
    const renamed = await scanRepository(root, { writeConfig: false });
    assert.ok(!renamed.edges.some((edge) => edge.kind === 'calls'));
    await put('tsconfig.json', { compilerOptions: { baseUrl: '.', paths: { '@target': ['src/b.ts'] } }, include: ['src/*.ts'] });
    const redirected = await scanRepository(root, { writeConfig: false });
    assert.equal(imports(redirected, 'src/main.ts')[0].to, 'file:src/b.ts');
    await put('src/new.ts', 'import "./main";');
    const added = await scanRepository(root, { writeConfig: false });
    assert.equal(imports(added, 'src/new.ts')[0].to, 'file:src/main.ts');
  });
});

test('workspace symlink package exports resolve to source and external packages stay out of the graph', async () => {
  await fixture({
    'package.json': { workspaces: ['packages/*'] },
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    'src/main.ts': 'import "@repo/ui"; import "node:fs";',
    'packages/ui/package.json': { name: '@repo/ui', exports: './src/index.ts' },
    'packages/ui/src/index.ts': 'export const Button = 1;',
  }, async (root) => {
    await mkdir(join(root, 'node_modules/@repo'), { recursive: true });
    await symlink(join(root, 'packages/ui'), join(root, 'node_modules/@repo/ui'), 'dir');
    const graph = await scanRepository(root, { writeConfig: false });
    assert.equal(imports(graph, 'src/main.ts')[0].to, 'file:packages/ui/src/index.ts');
    assert.equal(imports(graph, 'src/main.ts')[0].crossApp, true);
    assert.equal(graph.resolutionReport.length, 0);
    assert.ok(graph.apps.find((app) => app.root === '.').packages.includes('node:fs'));
  });
});

test('invalid app configuration is reported without losing source and strict scan rejects it', async () => {
  await fixture({
    '.blocks/config.json': { schemaVersion: 1, apps: [{ id: 'broken', root: 'worker', tsconfig: 'worker/missing.json', entries: ['worker/main.ts'] }] },
    'worker/main.ts': 'export const main = 1;',
  }, async (root) => {
    const graph = await scanRepository(root, { writeConfig: false });
    assert.equal(graph.summary.files, 1);
    assert.equal(graph.apps[0].health.status, 'error');
    assert.ok(graph.diagnostics.some((item) => item.app === 'broken' && item.field === 'tsconfig'));
    await assert.rejects(scanRepository(root, { writeConfig: false, strict: true }), /broken tsconfig/);
  });
});

test('1300-file three-app scan stays in the same performance order as a single app', async (t) => {
  const files = { '.blocks/config.json': { schemaVersion: 1, apps: ['web', 'admin', 'worker'].map((id) => ({ id, root: id, entries: [`${id}/0.ts`] })) } };
  for (let index = 0; index < 1300; index++) {
    const app = ['web', 'admin', 'worker'][index % 3];
    const number = Math.floor(index / 3);
    files[`${app}/${number}.ts`] = number ? `import "./${number - 1}"; export function piece${number}() { return ${number}; }` : 'export function start() { return 0; }';
  }
  await fixture(files, async (root, put) => {
    const started = performance.now();
    const multi = await scanRepository(root, { writeConfig: false });
    const multiMs = performance.now() - started;
    const warmStarted = performance.now();
    const warm = await scanRepository(root, { writeConfig: false });
    const warmMs = performance.now() - warmStarted;
    assert.equal(multi.summary.files, 1300);
    assert.deepEqual(warm.edges, multi.edges);
    await put('.blocks/config.json', { schemaVersion: 1, apps: [{ id: 'root', root: '.' }] });
    const singleStarted = performance.now();
    const single = await scanRepository(root, { writeConfig: false });
    const singleMs = performance.now() - singleStarted;
    assert.equal(single.summary.files, 1300);
    t.diagnostic(`1300 source files: three apps ${multiMs.toFixed(1)}ms, repeated ${warmMs.toFixed(1)}ms, single app ${singleMs.toFixed(1)}ms`);
    assert.ok(multiMs < Math.max(1500, singleMs * 10), `Multi-app scan ${multiMs}ms exceeded same-order budget relative to ${singleMs}ms`);
  });
});

test('registered view exports are excluded while generated implementation source remains visible', async () => {
  await fixture({
    '.blocks/view-exports.json': [{ path: 'snapshot.mjs', format: 'module' }],
    'snapshot.mjs': '// generated by block-beaver\nexport const BLOCK_BEAVER_VIEW = "page";',
    'src/generated.ts': '// generated by block-beaver from manifests, do not edit\nexport const entries = [];',
  }, async (root, put) => {
    const graph = await scanRepository(root, { writeConfig: false });
    assert.equal(node(graph, 'snapshot.mjs'), undefined);
    assert.equal(node(graph, 'src/generated.ts').generated, true);
    await put('.blocks/view-exports.json', [{ path: '../outside.mjs', format: 'module' }]);
    await assert.rejects(scanRepository(root, { writeConfig: false }), /exports.json.*inside the repository/);
  });
});

test('NodeNext scans follow conditional exports for import, require and implied module format', async () => {
  await fixture({
    'package.json': { type: 'module' },
    'tsconfig.json': { compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['src/**/*'] },
    'src/main.mts': 'import "@repo/conditional";\nrequire("@repo/conditional");\nimport("@repo/conditional");',
    'src/module.ts': 'import "@repo/conditional";',
    'src/common/package.json': { type: 'commonjs' },
    'src/common/main.ts': 'import "@repo/conditional";',
    'src/legacy.cts': 'import dependency = require("@repo/conditional");\nimport "@repo/conditional";',
    'packages/conditional/package.json': { name: '@repo/conditional', type: 'module', exports: { import: './esm.mts', require: './cjs.cts' } },
    'packages/conditional/esm.mts': 'export const kind = "esm";',
    'packages/conditional/cjs.cts': 'export const kind = "cjs";',
  }, async (root) => {
    await mkdir(join(root, 'node_modules/@repo'), { recursive: true });
    await symlink(join(root, 'packages/conditional'), join(root, 'node_modules/@repo/conditional'), 'dir');
    const graph = await scanRepository(root, { writeConfig: false });
    assert.deepEqual(imports(graph, 'src/main.mts').map((edge) => [edge.evidence.line, edge.to]), [
      [1, 'file:packages/conditional/esm.mts'],
      [2, 'file:packages/conditional/cjs.cts'],
      [3, 'file:packages/conditional/esm.mts'],
    ]);
    assert.deepEqual(imports(graph, 'src/legacy.cts').map((edge) => edge.to), ['file:packages/conditional/cjs.cts', 'file:packages/conditional/cjs.cts']);
    assert.equal(imports(graph, 'src/module.ts')[0].to, 'file:packages/conditional/esm.mts');
    assert.equal(imports(graph, 'src/common/main.ts')[0].to, 'file:packages/conditional/cjs.cts');
    assert.equal(graph.resolutionReport.length, 0);
    const repeated = await scanRepository(root, { writeConfig: false });
    assert.deepEqual(repeated.edges, graph.edges);
  });
});

test('package asset imports resolve under strict scans while a missing package asset stays a categorized failure', async () => {
  await fixture({
    'package.json': { name: 'site' },
    'src/main.ts': 'import "reactflow/dist/style.css";\nimport "@scope/ui/theme.css";\nimport "./local.css";',
    'src/local.css': 'a {}',
    'node_modules/reactflow/package.json': { name: 'reactflow' },
    'node_modules/reactflow/dist/style.css': 'a {}',
    'node_modules/@scope/ui/package.json': { name: '@scope/ui', exports: { './theme.css': { style: './dist/theme.css' } } },
    'node_modules/@scope/ui/dist/theme.css': 'a {}',
  }, async (root, put) => {
    const graph = await scanRepository(root, { writeConfig: false, strict: true });
    assert.equal(graph.resolutionReport.length, 0);
    assert.equal(graph.summary.unresolvedImports, 0);
    assert.equal(graph.summary.missingAssets, 0);
    assert.deepEqual(graph.apps.find((app) => app.root === '.').packages, ['@scope/ui', 'reactflow']);
    await put('src/broken.ts', 'import "reactflow/dist/missing.css";\nimport "./nope";');
    await assert.rejects(scanRepository(root, { writeConfig: false, strict: true }), /Strict scan failed \(2 problems\)[\s\S]*src\/broken\.ts:1: Cannot resolve asset 'reactflow\/dist\/missing\.css' \(missing\)/);
    const loose = await scanRepository(root, { writeConfig: false });
    assert.deepEqual(loose.resolutionReport.map((entry) => [entry.specifier, entry.category]), [['reactflow/dist/missing.css', 'asset'], ['./nope', 'module']]);
    assert.equal(loose.summary.unresolvedImports, 2);
    assert.equal(loose.summary.missingAssets, 1);
    const health = loose.apps.find((app) => app.root === '.').health;
    assert.equal(health.unresolvedImports, 2);
    assert.equal(health.missingAssets, 1);
    await put('src/other.ts', 'export const value = 1;');
    const rescanned = await scanRepository(root, { writeConfig: false });
    assert.deepEqual(rescanned.resolutionReport.map((entry) => entry.category).sort(), ['asset', 'module']);
    assert.equal(rescanned.summary.missingAssets, 1);
  });
});
