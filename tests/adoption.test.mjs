import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installProject } from '../src/install.mjs';
import { installationFixture, packageRunner } from './helpers/install-fixture.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = join(packageRoot, 'bin/block-beaver.mjs');
const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test'];

// A hand-built typed block system (nodes, models, tasks) moved onto Block Beaver families.
const none = { kind: 'none' };
const authored = (family, id, fields) => `export const ${id.replace(/-/g, '_')} = ${JSON.stringify({ id, family, version: 1, name: id, description: `The ${id} ${family}`, rationale: `Keeps ${id} cohesive`, ...fields })} as const;\n`;
const nodeFamily = `import { defineFamily, s } from 'block-beaver/kernel';
export default defineFamily({
  id: 'node',
  fields: s.object({ ports: s.array(s.string()), feeds: s.optional(s.array(s.string())) }),
  implementation: ['module', 'none'],
  implementationFields: { module: s.object({ export: s.optional(s.string()), loading: s.optional(s.enum(['eager', 'lazy'])) }) },
  links: [{ field: 'feeds[]', to: 'node', kind: 'feeds' }],
  generators: ['registry', 'index'],
});\n`;
const modelFamily = `import { defineFamily, s } from 'block-beaver/kernel';
export default defineFamily({ id: 'model', fields: s.object({ kinds: s.array(s.string()) }), implementation: ['none'], generators: ['registry', 'index'] });\n`;
const taskFamily = `import { defineFamily, s } from 'block-beaver/kernel';
export default defineFamily({
  id: 'task',
  fields: s.object({ kind: s.string(), node: s.string() }),
  implementation: ['none'],
  links: [{ field: 'node', to: 'node', kind: 'runs-on' }],
  generators: ['registry', 'index'],
});\n`;
const checksModule = `export default (ctx) => ctx.all('task')
  .filter((task) => !ctx.all('model').some((model) => model.kinds.includes(task.kind)))
  .map((task) => ({ block: 'task:' + task.id, field: '$.kind', code: 'task-kind-unserved', message: 'Task ' + task.id + ' has kind ' + task.kind + ' that no model serves' }));\n`;
// Imports the generated model registry: the first pass sees nothing, a later pass settles.
const coverageGenerator = `import { defineGenerator } from 'block-beaver/kernel';
let models = [];
try { models = (await import('../model/registry.out.ts')).models.all.map((model) => model.id); } catch {}
export default defineGenerator({ out: 'src/blocks/coverage.json', inputs: ['src/blocks/task/manifests/*.task.ts', 'src/blocks/model/manifests/*.model.ts'], generate(ctx) {
  return JSON.stringify({ models, tasks: ctx.manifests('task').map((task) => task.id) }, null, 2) + '\\n';
} });\n`;

const config = {
  schemaVersion: 1,
  apps: [{ id: 'host', root: '.', entries: ['src/main.ts'] }],
  families: [
    { id: 'node', contract: 'src/blocks/node/node.family.ts', manifests: 'src/blocks/node/manifests/*.node.ts', registry: { out: 'src/blocks/node/registry.out.ts', exportName: 'nodes', importExtension: '.ts' } },
    { id: 'model', contract: 'src/blocks/model/model.family.ts', manifests: 'src/blocks/model/manifests/*.model.ts', registry: { out: 'src/blocks/model/registry.out.ts', exportName: 'models', importExtension: '.ts' } },
    { id: 'task', contract: 'src/blocks/task/task.family.ts', manifests: 'src/blocks/task/manifests/*.task.ts', exclude: ['src/blocks/task/fixtures/*.task.ts'], registry: { out: 'src/blocks/task/registry.out.ts', exportName: 'tasks', importExtension: '.ts' } },
  ],
  map: { floors: ['task', 'node', 'model'] },
  checks: ['src/blocks/checks.ts'],
  generators: ['src/blocks/generators/coverage.ts'],
};

const files = {
  'package.json': JSON.stringify({ name: 'host', version: '1.0.0', private: true, type: 'module', main: 'src/main.ts' }) + '\n',
  '.blocks/config.json': JSON.stringify(config, null, 2) + '\n',
  'src/main.ts': "import { reader } from './nodes/reader.ts';\nexport const main = reader;\n",
  'src/nodes/reader.ts': 'export const reader = () => "read";\nexport const painter = () => "paint";\n',
  'src/blocks/node/node.family.ts': nodeFamily,
  'src/blocks/model/model.family.ts': modelFamily,
  'src/blocks/task/task.family.ts': taskFamily,
  'src/blocks/node/manifests/reader.node.ts': authored('node', 'reader', { ports: ['in', 'out'], feeds: ['painter'], implementation: { kind: 'module', module: '../../../nodes/reader.ts', export: 'reader', loading: 'eager' } }),
  'src/blocks/node/manifests/painter.node.ts': authored('node', 'painter', { ports: ['in'], implementation: { kind: 'module', module: '../../../nodes/reader.ts', export: 'painter', loading: 'lazy' } }),
  'src/blocks/model/manifests/text.model.ts': authored('model', 'text', { kinds: ['text'], implementation: none }),
  'src/blocks/model/manifests/vision.model.ts': authored('model', 'vision', { kinds: ['image', 'text'], implementation: none }),
  'src/blocks/task/manifests/summarize.task.ts': authored('task', 'summarize', { kind: 'text', node: 'reader', implementation: none }),
  'src/blocks/task/manifests/draw.task.ts': authored('task', 'draw', { kind: 'image', node: 'painter', implementation: none }),
  // Fixtures share the manifest suffix but belong to no family.
  'src/blocks/task/fixtures/sample.task.ts': authored('task', 'sample', { kind: 'nothing', node: 'nowhere', implementation: none }),
  'src/blocks/checks.ts': checksModule,
  'src/blocks/generators/coverage.ts': coverageGenerator,
};

// What the old hand-built codegen wrote: manifests as authored, ordered by family (config order) then ID.
const expectedIndex = `[
  {
    "id": "painter",
    "family": "node",
    "version": 1,
    "name": "painter",
    "description": "The painter node",
    "rationale": "Keeps painter cohesive",
    "ports": [
      "in"
    ],
    "implementation": {
      "kind": "module",
      "module": "../../../nodes/reader.ts",
      "export": "painter",
      "loading": "lazy"
    }
  },
  {
    "id": "reader",
    "family": "node",
    "version": 1,
    "name": "reader",
    "description": "The reader node",
    "rationale": "Keeps reader cohesive",
    "ports": [
      "in",
      "out"
    ],
    "feeds": [
      "painter"
    ],
    "implementation": {
      "kind": "module",
      "module": "../../../nodes/reader.ts",
      "export": "reader",
      "loading": "eager"
    }
  },
  {
    "id": "text",
    "family": "model",
    "version": 1,
    "name": "text",
    "description": "The text model",
    "rationale": "Keeps text cohesive",
    "kinds": [
      "text"
    ],
    "implementation": {
      "kind": "none"
    }
  },
  {
    "id": "vision",
    "family": "model",
    "version": 1,
    "name": "vision",
    "description": "The vision model",
    "rationale": "Keeps vision cohesive",
    "kinds": [
      "image",
      "text"
    ],
    "implementation": {
      "kind": "none"
    }
  },
  {
    "id": "draw",
    "family": "task",
    "version": 1,
    "name": "draw",
    "description": "The draw task",
    "rationale": "Keeps draw cohesive",
    "kind": "image",
    "node": "painter",
    "implementation": {
      "kind": "none"
    }
  },
  {
    "id": "summarize",
    "family": "task",
    "version": 1,
    "name": "summarize",
    "description": "The summarize task",
    "rationale": "Keeps summarize cohesive",
    "kind": "text",
    "node": "reader",
    "implementation": {
      "kind": "none"
    }
  }
]
`;
// The custom generator imports the generated model registry, so it must see both models after `gen`.
const expectedCoverage = `{
  "models": [
    "text",
    "vision"
  ],
  "tasks": [
    "draw",
    "summarize"
  ]
}
`;

async function adoptedProject(t, overrides = {}) {
  const root = await installationFixture(t);
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(packageRoot, join(root, 'node_modules/block-beaver'), 'dir');
  for (const [path, content] of Object.entries({ ...files, ...overrides })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const run = (root, args) => {
  const result = spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16e6 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
};
const json = (root, args) => JSON.parse(run(root, args).stdout);
const read = (root, path) => readFile(join(root, path), 'utf8');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const commitAll = (root, message) => { git(root, 'add', '-A'); git(root, ...identity, 'commit', '-q', '--no-verify', '-m', message); };

const registryImporting = authored('task', 'draw', { kind: 'image', node: 'painter', implementation: none })
  .replace('export const draw = ', "import { nodes } from '../../node/registry.out.ts';\nexport const draw = ").replace('"node":"painter"', '"node":nodes.get(\'painter\').id');

async function installedProject(t) {
  const root = await adoptedProject(t);
  const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const installed = await installProject(root, { version, agents: [], runner: packageRunner(root) });
  assert.equal(installed.complete, true, JSON.stringify(installed.conflicts));
  return root;
}

test('a hand-built typed block system adopts families with byte-identical JSON, stable generation and a clean strict audit', async (t) => {
  const root = await installedProject(t);
  const installedConfig = JSON.parse(await read(root, '.blocks/config.json'));
  assert.deepEqual(installedConfig.families, config.families, 'install keeps the adopter families');
  assert.deepEqual([installedConfig.map, installedConfig.checks, installedConfig.generators], [config.map, config.checks, config.generators]);

  // One gen settles every output, including the generator that imports a generated registry.
  const generated = json(root, ['gen']);
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.deepEqual(generated.diagnostics, []);
  assert.ok(generated.passes >= 2 && generated.passes <= 3, `passes ${generated.passes}`);
  for (const path of ['.blocks/index.json', 'src/blocks/coverage.json', 'src/blocks/node/registry.out.ts', 'src/blocks/model/registry.out.ts', 'src/blocks/task/registry.out.ts']) assert.ok(generated.written.includes(path), path);
  const checked = run(root, ['gen', '--check']);
  assert.equal(checked.status, 0, checked.stdout);
  assert.deepEqual(JSON.parse(checked.stdout).pending, []);
  assert.deepEqual(json(root, ['gen']).written, [], 'a second gen writes nothing');

  // Hand-built output bytes: the index follows families order and leaves the fixture out.
  assert.equal(await read(root, '.blocks/index.json'), expectedIndex);
  assert.equal(await read(root, 'src/blocks/coverage.json'), expectedCoverage);
  assert.deepEqual(JSON.parse(await read(root, '.blocks/index.json')).map((item) => item.family), ['node', 'node', 'model', 'model', 'task', 'task']);

  // The generated registries load, and the extended module arm survives.
  const script = "const { nodes } = await import('./src/blocks/node/registry.out.ts'); const { tasks } = await import('./src/blocks/task/registry.out.ts'); console.log(JSON.stringify({ nodes: nodes.all.map((n) => [n.id, n.implementation.loading]), tasks: tasks.all.map((n) => n.id) }));";
  const runtime = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' }));
  assert.deepEqual(runtime, { nodes: [['painter', 'lazy'], ['reader', 'eager']], tasks: ['draw', 'summarize'] });

  // A manifest may import a registry that gen writes; output stays stable and byte-identical.
  await writeFile(join(root, 'src/blocks/task/manifests/draw.task.ts'), registryImporting);
  const again = json(root, ['gen']);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.diagnostics, []);
  assert.equal(run(root, ['gen', '--check']).status, 0);
  assert.equal(await read(root, '.blocks/index.json'), expectedIndex);
  assert.equal(await read(root, 'src/blocks/coverage.json'), expectedCoverage);

  // map.floors orders the map and graph; index and registries keep families order.
  json(root, ['update']);
  const graph = JSON.parse(await read(root, '.blocks/view/graph.json'));
  assert.deepEqual(graph.families.map((item) => [item.id, item.floor]), [['task', 0], ['node', 1], ['model', 2]]);
  const blocks = graph.nodes.filter((node) => node.kind === 'block').sort((a, b) => a.floor - b.floor);
  assert.deepEqual([...new Set(blocks.map((node) => node.family))], ['task', 'node', 'model']);
  const html = await read(root, '.blocks/view/index.html');
  assert.deepEqual([...html.matchAll(/class="floor-title" x="\d+" y="\d+">([^<]+)</g)].map((match) => match[1]), ['task', 'node', 'model', 'Ordinary code']);
  assert.deepEqual(graph.familyDiagnostics, [], 'the excluded fixture is not family-unclaimed');
  assert.equal(graph.nodes.some((node) => node.id === 'block:task:sample'), false);

  // The cross-family check passes in the main fixture, and strict audit is clean.
  commitAll(root, 'adopt families');
  const audit = run(root, ['audit', '--strict']);
  assert.equal(audit.status, 0, audit.stdout + audit.stderr);
  const report = JSON.parse(audit.stdout);
  assert.equal(report.pass, true);
  for (const id of ['config-valid', 'manifest-valid', 'family-valid', 'family-drift', 'view-fresh']) {
    const rule = report.rules.find((item) => item.id === id);
    assert.deepEqual([id, rule.pass, rule.skipped !== true, rule.findings], [id, true, true, []]);
  }
  assert.equal(git(root, 'status', '--short'), '');
});

test('a cross-family check failure names its files in audit and gen --check and blocks writes', async (t) => {
  const root = await installedProject(t);
  assert.equal(json(root, ['gen']).ok, true);
  json(root, ['update']);
  commitAll(root, 'adopt families');
  const clean = run(root, ['audit', '--strict']);
  assert.equal(clean.status, 0, clean.stdout);

  // Kind "audio" is served by no model.
  await writeFile(join(root, 'src/blocks/task/manifests/draw.task.ts'), authored('task', 'draw', { kind: 'audio', node: 'painter', implementation: none }));
  const failing = run(root, ['gen', '--check']);
  assert.equal(failing.status, 2, failing.stdout);
  const diagnostic = JSON.parse(failing.stdout).diagnostics.find((item) => item.rule === 'family-valid');
  assert.deepEqual([diagnostic.code, diagnostic.checkCode, diagnostic.file, diagnostic.block, diagnostic.family], ['family-check-all-failed', 'task-kind-unserved', 'src/blocks/task/manifests/draw.task.ts', 'task:draw', 'task']);
  assert.match(diagnostic.message, /no model serves/);
  const before = await read(root, '.blocks/index.json');
  const blocked = json(root, ['gen']);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.written, []);
  assert.equal(await read(root, '.blocks/index.json'), before);

  const audit = run(root, ['audit', '--strict']);
  assert.equal(audit.status, 2, audit.stdout);
  const failed = JSON.parse(audit.stdout).rules.find((rule) => rule.id === 'family-valid');
  assert.equal(failed.pass, false);
  assert.ok(failed.findings.some((finding) => finding.path === 'src/blocks/task/manifests/draw.task.ts' && /no model serves/.test(finding.message)), JSON.stringify(failed.findings));

  // A model that serves the kind repairs the set.
  await writeFile(join(root, 'src/blocks/model/manifests/audio.model.ts'), authored('model', 'audio', { kinds: ['audio'], implementation: none }));
  assert.equal(json(root, ['gen']).ok, true);
  assert.equal(run(root, ['gen', '--check']).status, 0);
  json(root, ['update']);
  commitAll(root, 'serve audio');
  const repaired = run(root, ['audit', '--strict']);
  assert.equal(repaired.status, 0, repaired.stdout);
});

