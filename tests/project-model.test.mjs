import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectModel, detectProjectApps } from '../src/project-model.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'beaver-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), typeof text === 'string' ? text : JSON.stringify(text)); }
  return root;
}
test('compiler aliases follow the home app, ownership retains outside files, and detection preserves owner edits', async (t) => {
  const paths = ['src/shared.ts', 'apps/admin/src/main.ts', 'apps/admin/src/local.ts', 'scripts/tool.ts'];
  const root = await fixture(t, {
    'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src/**/*'] },
    'apps/admin/tsconfig.json': { extends: '../../tsconfig.json', compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src/**/*', '../../src/**/*'] },
    ...Object.fromEntries(paths.map((path) => [path, 'export const value = 1;'])),
  });
  const model = await loadProjectModel(root, { paths });
  const admin = model.apps.find((app) => app.root === 'apps/admin');
  assert.equal(model.ownerByFile.get('src/shared.ts'), admin.id);
  assert.equal(model.ownerByFile.get('scripts/tool.ts'), null);
  assert.deepEqual(model.resolveImport('apps/admin/src/main.ts', '@/local'), { path: 'apps/admin/src/local.ts' });
  assert.equal(model.resolveImport('apps/admin/src/main.ts', 'node:fs').external, true);
  const config = JSON.parse(await readFile(join(root, '.blocks/config.json'), 'utf8'));
  config.apps.find((app) => app.root === 'apps/admin').id = 'owner-admin';
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify(config));
  const proposed = await detectProjectApps(root, { paths });
  assert.equal(proposed.config.apps.find((app) => app.id === 'owner-admin').source, 'config');
  assert.equal(JSON.parse(await readFile(join(root, '.blocks/config.json'), 'utf8')).apps.find((app) => app.id === 'owner-admin').source, 'detected');
  await detectProjectApps(root, { paths, write: true });
  assert.equal(JSON.parse(await readFile(join(root, '.blocks/config.json'), 'utf8')).apps.find((app) => app.id === 'owner-admin').source, 'config');
});
test('workspace detection resolves package symlinks and finds package and worker entries', async (t) => {
  const paths = ['apps/web/index.ts', 'packages/ui/index.ts', 'worker/index.ts'];
  const root = await fixture(t, {
    'package.json': { workspaces: ['apps/*', 'packages/*'] },
    'apps/web/package.json': { name: 'web', main: 'index.ts' },
    'packages/ui/package.json': { name: '@repo/ui', exports: './index.ts' },
    'worker/tsconfig.json': { include: ['*.ts'] }, 'worker/wrangler.toml': 'main = "index.ts"\n',
    ...Object.fromEntries(paths.map((path) => [path, 'export const value = 1;'])),
  });
  await mkdir(join(root, 'node_modules/@repo'), { recursive: true });
  await symlink(join(root, 'packages/ui'), join(root, 'node_modules/@repo/ui'));
  const model = await loadProjectModel(root, { paths, writeConfig: false });
  assert.equal(model.apps.length, 3);
  assert.deepEqual(model.resolveImport('apps/web/index.ts', '@repo/ui'), { path: 'packages/ui/index.ts' });
  assert.deepEqual(model.apps.find((app) => app.root === 'worker').entries, ['worker/index.ts']);
  assert.deepEqual(model.apps.find((app) => app.root === 'apps/web').entries, ['apps/web/index.ts']);
});
test('invalid app config fails soft and strict mode fails, config writes reject symlinks', async (t) => {
  const root = await fixture(t, { 'src/index.ts': '', '.blocks/config.json': { schemaVersion: 1, apps: [{ id: 'web', root: '.', tsconfig: 'missing.json', source: 'config' }] } });
  const model = await loadProjectModel(root, { paths: ['src/index.ts'] });
  assert.match(model.diagnostics[0].message, /tsconfig/);
  assert.equal(model.ownerByFile.get('src/index.ts'), 'web');
  await assert.rejects(loadProjectModel(root, { paths: ['src/index.ts'], strict: true }), /missing|does not exist/);
  await rm(join(root, '.blocks'), { recursive: true });
  await symlink(join(root, 'src'), join(root, '.blocks'));
  await assert.rejects(loadProjectModel(root, { paths: ['src/index.ts'] }), /symlink/);
});
test('pnpm and yarn workspace declarations find apps without tsconfig', async (t) => {
  for (const manager of ['pnpm', 'yarn']) {
    const paths = ['apps/web/index.js', 'packages/ui/index.js'];
    const root = await fixture(t, {
      'package.json': manager === 'yarn' ? { workspaces: { packages: ['apps/*', 'packages/*'] } } : {},
      ...(manager === 'pnpm' ? { 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n" } : {}),
      'apps/web/package.json': { main: 'index.js' }, 'packages/ui/package.json': {},
      ...Object.fromEntries(paths.map((path) => [path, 'export const value = 1;'])),
    });
    const model = await loadProjectModel(root, { paths, writeConfig: false });
    assert.deepEqual(model.apps.map((app) => app.root), ['apps/web', 'packages/ui']);
    assert.equal(model.ownerByFile.get('packages/ui/index.js'), 'ui');
  }
});
test('extends chains, reference projects, ignore patterns, and absent apps survive repeat detection', async (t) => {
  const paths = ['apps/web/src/index.ts', 'packages/ui/index.ts', 'scripts/archive/old.ts'];
  const root = await fixture(t, {
    'tsconfig.json': { files: [], references: [{ path: './apps/web' }, { path: './packages/ui' }] },
    'tsconfig.base.json': { compilerOptions: { baseUrl: '.', paths: { 'repo-ui': ['packages/ui/index.ts'] } } },
    'apps/web/tsconfig.json': { extends: '../../tsconfig.base.json', include: ['src/**/*'] },
    'packages/ui/tsconfig.json': { include: ['*.ts'] },
    ...Object.fromEntries(paths.map((path) => [path, 'export const value = 1;'])),
  });
  const model = await loadProjectModel(root, { paths });
  assert.deepEqual(model.resolveImport('apps/web/src/index.ts', 'repo-ui'), { path: 'packages/ui/index.ts' });
  const config = JSON.parse(await readFile(join(root, '.blocks/config.json'), 'utf8'));
  config.ignore = ['scripts/archive/**'];
  config.apps.push({ id: 'gone', root: 'apps/gone', source: 'config' });
  await writeFile(join(root, '.blocks/config.json'), JSON.stringify(config));
  const proposal = await detectProjectApps(root, { paths, write: true });
  assert.equal(proposal.disappeared.some((app) => app.id === 'gone'), true);
  assert.equal(proposal.config.apps.some((app) => app.id === 'gone'), true);
  const again = await loadProjectModel(root, { paths });
  assert.equal(again.isIgnored('scripts/archive/old.ts'), true);
});
test('malformed valid JSON config is diagnosed without mutation or scan failure', async (t) => {
  for (const config of [null, [], 42, { schemaVersion: 1, apps: [null] }, { schemaVersion: 1, apps: 'bad' }]) {
    const text = JSON.stringify(config);
    const root = await fixture(t, { '.blocks/config.json': text, 'index.ts': '' });
    const proposed = await detectProjectApps(root, { paths: ['index.ts'], write: true });
    assert.ok(proposed.diagnostics.length);
    const model = await loadProjectModel(root, { paths: ['index.ts'] });
    assert.ok(model.diagnostics.length);
    assert.equal(await readFile(join(root, '.blocks/config.json'), 'utf8'), text);
    await assert.rejects(loadProjectModel(root, { paths: ['index.ts'], strict: true }), /config|App|apps/);
  }
});
test('NodeNext resolution uses source format and dynamic import or require modes', async (t) => {
  const paths = ['src/main.mts', 'src/main.cts', 'src/main.ts', 'packages/dual/esm.mts', 'packages/dual/cjs.cts'];
  const root = await fixture(t, {
    'package.json': { type: 'module', workspaces: ['packages/*'] },
    'tsconfig.json': { compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['src/**/*'] },
    'packages/dual/package.json': { name: 'dual', exports: { import: './esm.mts', require: './cjs.cts' } },
    ...Object.fromEntries(paths.map((path) => [path, 'export const value = 1;'])),
  });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(join(root, 'packages/dual'), join(root, 'node_modules/dual'));
  const model = await loadProjectModel(root, { paths, writeConfig: false });
  assert.deepEqual(model.resolveImport('src/main.mts', 'dual'), { path: 'packages/dual/esm.mts' });
  assert.deepEqual(model.resolveImport('src/main.cts', 'dual'), { path: 'packages/dual/cjs.cts' });
  assert.deepEqual(model.resolveImport('src/main.ts', 'dual'), { path: 'packages/dual/esm.mts' });
  assert.deepEqual(model.resolveImport('src/main.mts', 'dual', { mode: 'require' }), { path: 'packages/dual/cjs.cts' });
  assert.deepEqual(model.resolveImport('src/main.cts', 'dual', { mode: 'import' }), { path: 'packages/dual/esm.mts' });
});
test('non-object tsconfig JSON fails soft per app and strict mode names the tsconfig', async (t) => {
  for (const config of ['null', '42', '[]']) {
    const root = await fixture(t, { 'tsconfig.json': config, 'index.ts': '' });
    const model = await loadProjectModel(root, { paths: ['index.ts'], writeConfig: false });
    assert.ok(model.diagnostics.some((diagnostic) => diagnostic.field === 'tsconfig' && /object/.test(diagnostic.message)));
    assert.ok(model.ownerByFile.get('index.ts'));
    await assert.rejects(loadProjectModel(root, { paths: ['index.ts'], writeConfig: false, strict: true }), /tsconfig/);
  }
});
test('existing assets are external while missing assets and escaped imports remain diagnosed', async (t) => {
  const root = await fixture(t, { 'src/tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@assets/*': ['*'] } }, include: ['*.ts'] }, 'src/main.ts': '', 'src/style.css': 'body {}', 'src/icon.svg': '<svg/>', 'outside.ts': '' });
  const model = await loadProjectModel(join(root, 'src'), { paths: ['main.ts'], writeConfig: false });
  assert.deepEqual(model.resolveImport('main.ts', './style.css'), { external: true, asset: 'style.css' });
  assert.deepEqual(model.resolveImport('main.ts', './icon.svg'), { external: true, asset: 'icon.svg' });
  assert.deepEqual(model.resolveImport('main.ts', '@assets/icon.svg'), { external: true, asset: 'icon.svg' });
  assert.match(model.resolveImport('main.ts', './missing.css').error, /Cannot resolve/);
  assert.equal(model.resolveImport('main.ts', './missing.css').category, 'asset');
  assert.match(model.resolveImport('main.ts', '../outside').error, /outside the repository/);
});
test('relative and alias asset misses are categorized as asset errors', async (t) => {
  const root = await fixture(t, { 'src/tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@assets/*': ['*'] } }, include: ['*.ts'] }, 'src/main.ts': '' });
  const model = await loadProjectModel(join(root, 'src'), { paths: ['main.ts'], writeConfig: false });
  assert.deepEqual(model.resolveImport('main.ts', './missing.css'), { error: "Cannot resolve asset './missing.css' (missing)", category: 'asset' });
  assert.equal(model.resolveImport('main.ts', '@assets/missing.svg').category, 'asset');
});
test('bare package assets resolve through node_modules and package exports', async (t) => {
  const root = await fixture(t, {
    'src/main.ts': '',
    'node_modules/reactflow/package.json': { name: 'reactflow' },
    'node_modules/reactflow/dist/style.css': 'a {}',
    'node_modules/@fortune-sheet/react/package.json': { name: '@fortune-sheet/react', exports: { '.': './dist/index.js', './dist/index.css': './dist/index.css', './private/*': null } },
    'node_modules/@fortune-sheet/react/dist/index.css': 'a {}',
    'node_modules/@fortune-sheet/react/private/secret.css': 'a {}',
    'node_modules/@fortune-sheet/react/dist/other.css': 'a {}',
    'node_modules/wild/package.json': { name: 'wild', exports: { './*': './*' } },
    'node_modules/wild/theme/dark.css': 'a {}',
    'node_modules/styled/package.json': { name: 'styled', exports: { './theme.css': { style: './dist/theme.css', default: './dist/missing.css' } } },
    'node_modules/styled/dist/theme.css': 'a {}',
    'node_modules/conditional/package.json': { name: 'conditional', exports: { './icon.svg': { node: './node.svg', import: ['./gone.svg', './icon.svg'] } } },
    'node_modules/conditional/icon.svg': '<svg/>',
    'node_modules/gone/package.json': { name: 'gone' },
  });
  const model = await loadProjectModel(root, { paths: ['src/main.ts'], writeConfig: false });
  const resolve = (specifier) => model.resolveImport('src/main.ts', specifier);
  assert.deepEqual(resolve('reactflow/dist/style.css'), { external: true, package: 'reactflow', asset: 'reactflow/dist/style.css' });
  assert.deepEqual(resolve('@fortune-sheet/react/dist/index.css'), { external: true, package: '@fortune-sheet/react', asset: '@fortune-sheet/react/dist/index.css' });
  assert.deepEqual(resolve('wild/theme/dark.css'), { external: true, package: 'wild', asset: 'wild/theme/dark.css' });
  assert.deepEqual(resolve('styled/theme.css'), { external: true, package: 'styled', asset: 'styled/theme.css' });
  assert.deepEqual(resolve('conditional/icon.svg'), { external: true, package: 'conditional', asset: 'conditional/icon.svg' });
  assert.deepEqual(model.apps.find((app) => app.root === '.').packages.sort(), ['@fortune-sheet/react', 'conditional', 'reactflow', 'styled', 'wild']);
  assert.deepEqual(resolve('@fortune-sheet/react/dist/other.css'), { error: "Cannot resolve asset '@fortune-sheet/react/dist/other.css' (not-exported)", category: 'asset' });
  assert.deepEqual(resolve('@fortune-sheet/react/private/secret.css'), { error: "Cannot resolve asset '@fortune-sheet/react/private/secret.css' (not-exported)", category: 'asset' });
  assert.deepEqual(resolve('reactflow/dist/gone.css'), { error: "Cannot resolve asset 'reactflow/dist/gone.css' (missing)", category: 'asset' });
  assert.deepEqual(resolve('wild/theme/light.css'), { error: "Cannot resolve asset 'wild/theme/light.css' (missing)", category: 'asset' });
  assert.deepEqual(resolve('nothere/style.css'), { error: "Cannot resolve asset 'nothere/style.css' (no-package)", category: 'asset' });
  assert.equal(resolve('reactflow/../gone/escape.css').category, 'asset');
  assert.match(resolve('reactflow/dist/../../../outside.css').error, /Cannot resolve asset/);
});
test('manual app roots do not disappear solely because detection does not recognize their files', async (t) => {
  const root = await fixture(t, { 'custom/main.ts': '', '.blocks/config.json': { schemaVersion: 1, apps: [{ id: 'custom', root: 'custom', source: 'config' }, { id: 'gone', root: 'gone', source: 'config' }] } });
  const result = await detectProjectApps(root, { paths: ['custom/main.ts'] });
  assert.deepEqual(result.disappeared.map((app) => app.id), ['gone']);
});
test('tsconfig includes cannot enumerate sibling source outside the repository', async (t) => {
  const root = await fixture(t, { 'repo/tsconfig.json': { include: ['../**/*.ts'] }, 'repo/main.ts': '', 'outside.ts': '' });
  const model = await loadProjectModel(join(root, 'repo'), { paths: ['main.ts'], writeConfig: false });
  assert.ok(model.diagnostics.some((diagnostic) => /include.*outside the repository/.test(diagnostic.message)));
  assert.equal(model.apps[0].fileNames.has('../outside.ts'), false);
  await assert.rejects(loadProjectModel(join(root, 'repo'), { paths: ['main.ts'], writeConfig: false, strict: true }), /outside the repository/);
});
