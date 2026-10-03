import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, chmod, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installProject } from '../src/install.mjs';
import { renderAgentInstructions } from '../src/install-templates.mjs';
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
const checksModule = `export default (manifests, ctx) => ctx.all('task')
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

async function installedProject(t, overrides = {}) {
  const root = await adoptedProject(t, overrides);
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

// ---- 0.7.0: the same system adopts the next layer (headerless outputs, join links, groups, regions, labels, map-only view, quiet audit) ----

const toolFamily = `import { defineFamily, s } from 'block-beaver/kernel';
export default defineFamily({
  id: 'tool',
  fields: s.object({ modes: s.array(s.string()), lane: s.string() }),
  implementation: ['none'],
  map: { group: { field: 'modes[]', join: ' + ', empty: 'no modes' } },
  generators: ['registry', 'index'],
});\n`;
// The contract imports a generated tokens file, so the file has to exist before the first load.
const jobFamily = `import { defineFamily, s } from 'block-beaver/kernel';
import { lanes } from '../generated/tokens.ts';
export default defineFamily({
  id: 'job',
  fields: s.object({ tools: s.string(), lane: s.enum(lanes) }),
  implementation: ['none'],
  links: [{ field: 'tools', to: 'tool', match: 'modes[]', kind: 'can-use' }],
  map: { group: { field: 'lane' } },
  generators: ['registry', 'index'],
});\n`;
// The contract imports the generated tool registry.
const releaseFamily = `import { defineFamily, s } from 'block-beaver/kernel';
import { tools } from '../tool/registry.out.ts';
export default defineFamily({
  id: 'release',
  fields: s.object({ owner: s.enum(tools.all.map((tool) => tool.id)), meta: s.optional(s.object({ area: s.nullable(s.string()) })) }),
  implementation: ['none'],
  map: { group: { field: 'meta.area', empty: 'unassigned', format: 'Area: {value}' } },
  generators: ['registry', 'index', 'history'],
});\n`;
const tokensGenerator = `import { defineGenerator } from 'block-beaver/kernel';
export default defineGenerator({ out: 'src/blocks/generated/tokens.ts', inputs: ['src/blocks/tool/manifests/*.tool.ts'], generate(ctx) {
  const lanes = [...new Set(ctx.manifests('tool').map((tool) => tool.lane))].sort();
  return 'export const lanes = [' + lanes.map((lane) => "'" + lane + "'").join(', ') + '] as const;\\n';
} });\n`;
const importsGenerator = `import { posix } from 'node:path';
import { defineGenerator } from 'block-beaver/kernel';
const out = 'src/blocks/generated/imports.ts';
export default defineGenerator({ out, inputs: ['src/blocks/*/manifests/*.ts'], generate(ctx) {
  return ctx.entries().map((entry) => "import { " + entry.exportName + " } from '" + posix.relative(posix.dirname(out), entry.path) + "';").join('\\n') + '\\n';
} });\n`;
const badgeGenerator = `import { readFileSync } from 'node:fs';
import { defineGenerator } from 'block-beaver/kernel';
export default defineGenerator({ out: 'README.md', region: 'badge', inputs: ['docs/roadmap.md'], generate(ctx) {
  return '[' + readFileSync('docs/roadmap.md', 'utf8').split('\\n')[0] + '](./docs/roadmap.md) - ' + ctx.blocks().length + ' blocks';
} });\n`;
const labelModule = `import { readFileSync } from 'node:fs';
export default (ctx) => 'roadmap: ' + readFileSync('docs/roadmap.md', 'utf8').split('\\n')[0] + ' / ' + ctx.blocks().length + ' blocks';
export const inputs = ['docs/roadmap.md'];\n`;

const config070 = {
  ...config,
  families: [...config.families,
    { id: 'tool', contract: 'src/blocks/tool/tool.family.ts', manifests: 'src/blocks/tool/manifests/*.tool.ts', registry: { out: 'src/blocks/tool/registry.out.ts', exportName: 'tools', importExtension: '.ts' } },
    { id: 'job', contract: 'src/blocks/job/job.family.ts', manifests: 'src/blocks/job/manifests/*.job.ts', registry: { out: 'src/blocks/job/registry.out.ts', exportName: 'jobs', importExtension: '.ts' } },
    { id: 'release', contract: 'src/blocks/release/release.family.ts', manifests: 'src/blocks/release/manifests/*.release.ts', registry: { out: 'src/blocks/release/registry.out.ts', exportName: 'releases', importExtension: '.ts' } }],
  map: { floors: ['task', 'node', 'model', 'job', 'tool', 'release'] },
  generators: [...config.generators, 'src/blocks/generators/tokens.ts', 'src/blocks/generators/imports.ts', 'src/blocks/generators/badge.ts'],
  history: { label: { module: '.blocks/history-label.mjs' } },
};
// What a hand-built generator wrote before adoption: the same bodies Block Beaver now generates, without its header.
const preexistingTokens = "export const lanes = ['fast', 'slow'] as const;\n";
const preexistingToolRegistry = `import { createRegistry } from 'block-beaver/kernel';
import { archive as m0 } from './manifests/archive.tool.ts';
import { create_note as m1 } from './manifests/create-note.tool.ts';
import { idle as m2 } from './manifests/idle.tool.ts';
import { search as m3 } from './manifests/search.tool.ts';

export const tools = createRegistry('tool', [m0, m1, m2, m3] as const);
export type ToolManifest = (typeof tools)['all'][number];
export type ToolId = ToolManifest['id'];
`;
const readme070 = '# Host\n\nHand-written intro.\n\n<!-- block-beaver:region badge -->\nbadge pending\n<!-- /block-beaver:region badge -->\n\nHand-written footer.\n';
const files070 = {
  '.blocks/config.json': JSON.stringify(config070, null, 2) + '\n',
  'README.md': readme070,
  'docs/roadmap.md': 'Milestone one\n',
  '.blocks/history-label.mjs': labelModule,
  'src/blocks/tool/tool.family.ts': toolFamily,
  'src/blocks/job/job.family.ts': jobFamily,
  'src/blocks/release/release.family.ts': releaseFamily,
  'src/blocks/tool/manifests/search.tool.ts': authored('tool', 'search', { modes: ['chat'], lane: 'fast', implementation: none }),
  'src/blocks/tool/manifests/create-note.tool.ts': authored('tool', 'create-note', { modes: ['assistant', 'chat'], lane: 'slow', implementation: none }),
  'src/blocks/tool/manifests/archive.tool.ts': authored('tool', 'archive', { modes: ['assistant'], lane: 'slow', implementation: none }),
  'src/blocks/tool/manifests/idle.tool.ts': authored('tool', 'idle', { modes: [], lane: 'fast', implementation: none }),
  'src/blocks/job/manifests/summarise.job.ts': authored('job', 'summarise', { tools: 'assistant', lane: 'fast', implementation: none }),
  'src/blocks/job/manifests/draft.job.ts': authored('job', 'draft', { tools: 'chat', lane: 'fast', implementation: none }),
  'src/blocks/job/manifests/plain.job.ts': authored('job', 'plain', { tools: 'none', lane: 'slow', implementation: none }),
  'src/blocks/release/manifests/v1.release.ts': authored('release', 'v1', { owner: 'search', meta: { area: 'core' }, implementation: none }),
  'src/blocks/release/manifests/v2.release.ts': authored('release', 'v2', { owner: 'archive', meta: { area: null }, implementation: none }),
  'src/blocks/release/manifests/v3.release.ts': authored('release', 'v3', { owner: 'idle', implementation: none }),
  'src/blocks/generators/tokens.ts': tokensGenerator,
  'src/blocks/generators/imports.ts': importsGenerator,
  'src/blocks/generators/badge.ts': badgeGenerator,
  // Both files predate Block Beaver: no header, and the contracts above import them at load time.
  'src/blocks/generated/tokens.ts': preexistingTokens,
  'src/blocks/tool/registry.out.ts': preexistingToolRegistry,
};
const oldFamilies = ['node', 'model', 'task'];
const oldOutputs = ['src/blocks/node/registry.out.ts', 'src/blocks/model/registry.out.ts', 'src/blocks/task/registry.out.ts', 'src/blocks/coverage.json'];

// An installed 0.7.0-style system whose pre-existing outputs have been taken over by one `gen --adopt`.
async function settled070(t, overrides = {}) {
  const root = await installedProject(t, { ...files070, ...overrides });
  const adopted = json(root, ['gen', '--adopt']);
  assert.equal(adopted.ok, true, JSON.stringify(adopted.diagnostics));
  assert.equal(run(root, ['gen', '--check']).status, 0);
  return root;
}
const stripHeader = (text) => text.replace(/^\/\/ generated by block-beaver[^\n]*\n/, '');

test('0.7.0: gen --adopt takes over headerless outputs that contracts import, and a deleted import names its importer', async (t) => {
  const root = await installedProject(t, files070);
  const tokensPath = 'src/blocks/generated/tokens.ts', registryPath = 'src/blocks/tool/registry.out.ts';

  // Without --adopt both are output-conflicts and nothing at all is written.
  const refused = run(root, ['gen']);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  const refusal = JSON.parse(refused.stdout);
  assert.equal(refusal.ok, false);
  assert.deepEqual(refusal.diagnostics.filter((item) => item.code === 'output-conflict').map((item) => item.file).sort(), [tokensPath, registryPath]);
  assert.deepEqual(refusal.written, []);
  assert.equal(await read(root, tokensPath), preexistingTokens);
  assert.equal(await read(root, registryPath), preexistingToolRegistry);
  assert.equal(await read(root, 'README.md'), readme070);
  for (const path of ['.blocks/index.json', 'src/blocks/node/registry.out.ts']) await assert.rejects(read(root, path), { code: 'ENOENT' }, path);
  assert.equal(run(root, ['gen', '--adopt', '--check']).status, 1, '--check never adopts');

  // A dry run reports what would be adopted and writes nothing.
  const dry = json(root, ['gen', '--adopt', '--dry-run']);
  assert.equal(dry.ok, true, JSON.stringify(dry.diagnostics));
  assert.deepEqual(dry.written, []);
  const adoptedOutputs = dry.outputs.filter((output) => output.status === 'adopted');
  assert.deepEqual(adoptedOutputs.map((output) => [output.out, output.bodyIdentical]).sort(), [[tokensPath, true], [registryPath, true]]);
  assert.equal(await read(root, tokensPath), preexistingTokens);
  assert.equal(await read(root, registryPath), preexistingToolRegistry);
  await assert.rejects(read(root, '.blocks/index.json'), { code: 'ENOENT' });

  // The real adoption keeps the bodies, adds only the header, and settles everything else in the same run.
  const adopted = json(root, ['gen', '--adopt']);
  assert.equal(adopted.ok, true, JSON.stringify(adopted.diagnostics));
  assert.deepEqual(adopted.diagnostics, []);
  for (const path of [tokensPath, registryPath, '.blocks/index.json', 'src/blocks/job/registry.out.ts', 'src/blocks/generated/imports.ts', 'README.md', ...oldOutputs]) assert.ok(adopted.written.includes(path), path);
  assert.equal(await read(root, tokensPath), `// generated by block-beaver from src/blocks/tool/manifests/*.tool.ts; do not edit\n${preexistingTokens}`);
  assert.equal(await read(root, registryPath), `// generated by block-beaver from src/blocks/tool/manifests/*.tool.ts; do not edit\n${preexistingToolRegistry}`);
  const checked = run(root, ['gen', '--check']);
  assert.equal(checked.status, 0, checked.stdout);
  assert.deepEqual(JSON.parse(checked.stdout).pending, []);
  assert.deepEqual(json(root, ['gen']).written, [], 'a second gen writes nothing');
  assert.deepEqual(json(root, ['gen', '--adopt']).written, [], 'adopting again is a no-op');

  // #41: ctx.entries gives every manifest's path and export name in manifest order.
  const index = JSON.parse(await read(root, '.blocks/index.json'));
  assert.deepEqual([...new Set(index.map((item) => item.family))], ['node', 'model', 'task', 'tool', 'job', 'release']);
  const expectedImports = index.map((item) => `import { ${item.id.replace(/-/g, '_')} } from '../${item.family}/manifests/${item.id}.${item.family}.ts';`);
  assert.equal(expectedImports.length, 16);
  assert.equal(await read(root, 'src/blocks/generated/imports.ts'), `// generated by block-beaver from src/blocks/*/manifests/*.ts; do not edit\n${expectedImports.join('\n')}\n`);
  assert.deepEqual(expectedImports.slice(0, 2), ["import { painter } from '../node/manifests/painter.node.ts';", "import { reader } from '../node/manifests/reader.node.ts';"], 'families keep config order, then id order');

  // Deleting an output that a contract imports names the output and the importer; gen cannot recreate it.
  const saved = await read(root, tokensPath);
  await rm(join(root, tokensPath));
  const lost = run(root, ['gen']);
  assert.equal(lost.status, 2, lost.stdout);
  const missing = JSON.parse(lost.stdout).diagnostics.find((item) => item.code === 'output-required-for-load');
  assert.ok(missing, lost.stdout);
  assert.deepEqual([missing.severity, missing.file, missing.output], ['error', 'src/blocks/job/job.family.ts', tokensPath]);
  assert.match(missing.message, /src\/blocks\/job\/job\.family\.ts/);
  assert.match(missing.message, new RegExp(`gen --adopt ${tokensPath.replaceAll('.', '\\.')}`));
  assert.equal(JSON.parse(lost.stdout).diagnostics.some((item) => item.code === 'unresolved-import'), false);
  await assert.rejects(read(root, tokensPath), { code: 'ENOENT' });
  await writeFile(join(root, tokensPath), saved);
  const savedRegistry = await read(root, registryPath);
  await rm(join(root, registryPath));
  const lostRegistry = JSON.parse(run(root, ['gen', '--check']).stdout).diagnostics.find((item) => item.code === 'output-required-for-load');
  assert.deepEqual([lostRegistry.file, lostRegistry.output], ['src/blocks/release/release.family.ts', registryPath]);
  await writeFile(join(root, registryPath), savedRegistry);
  assert.equal(run(root, ['gen', '--check']).status, 0, 'restoring both files settles the system again');
});

test('0.7.0: join links and per-family groups reach graph.json and the map, and families without new keys keep their bytes', async (t) => {
  const root = await settled070(t);
  json(root, ['update']);
  const graph = JSON.parse(await read(root, '.blocks/view/graph.json'));
  const blockNodes = graph.nodes.filter((node) => node.kind === 'block');
  const nodeOf = (id) => blockNodes.find((node) => node.id === id);

  // #36: task.tools (a scalar mode) joins to every tool whose modes[] holds it; no match, no edge.
  const edges = graph.edges.filter((edge) => edge.link && edge.kind === 'can-use').map((edge) => [edge.from, edge.to, edge.fields]);
  assert.deepEqual(edges, [
    ['block:job:draft', 'block:tool:create-note', ['$.tools']], ['block:job:draft', 'block:tool:search', ['$.tools']],
    ['block:job:summarise', 'block:tool:archive', ['$.tools']], ['block:job:summarise', 'block:tool:create-note', ['$.tools']],
  ]);
  assert.deepEqual(nodeOf('block:job:plain').dependencies, [], 'a value no tool serves links nothing');
  assert.deepEqual(nodeOf('block:job:summarise').dependencies, ['block:tool:archive', 'block:tool:create-note']);
  assert.deepEqual(graph.familyDiagnostics, []);
  assert.deepEqual(graph.families.find((item) => item.id === 'job').linkKinds, ['can-use']);

  // #37: each family groups its own floor: array-joined with an empty fallback, a scalar, and nested-nullable with empty and format.
  const groups = (family) => Object.fromEntries(blockNodes.filter((node) => node.family === family).map((node) => [node.id.split(':')[2], node.group]));
  assert.deepEqual(groups('tool'), { archive: 'assistant', 'create-note': 'assistant + chat', idle: 'no modes', search: 'chat' });
  assert.deepEqual(groups('job'), { draft: 'fast', plain: 'slow', summarise: 'fast' });
  assert.deepEqual(groups('release'), { v1: 'Area: core', v2: 'Area: unassigned', v3: 'Area: unassigned' });
  assert.deepEqual(graph.families.find((item) => item.id === 'release').group, { field: 'meta.area', empty: 'unassigned', format: 'Area: {value}' });
  const html = await read(root, '.blocks/view/index.html');
  const labels = [...html.matchAll(/<text class="group-label"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  for (const label of ['fast · 2', 'slow · 1', 'assistant · 1', 'assistant + chat · 1', 'no modes · 1', 'chat · 1', 'Area: core · 1', 'Area: unassigned · 2']) assert.ok(labels.includes(label), `${label} in ${JSON.stringify(labels)}`);
  assert.deepEqual([...html.matchAll(/class="floor-title" x="\d+" y="\d+">([^<]+)</g)].map((match) => match[1]), ['task', 'node', 'model', 'job', 'tool', 'release', 'Ordinary code']);

  // Compatibility: the families that use none of the new keys keep the bytes the 0.6.0 part asserts.
  for (const family of oldFamilies) assert.ok(blockNodes.filter((node) => node.family === family).every((node) => !Object.hasOwn(node, 'group')), `${family} gets no group key`);
  for (const family of graph.families.filter((item) => oldFamilies.includes(item.id))) assert.equal(Object.hasOwn(family, 'group'), false);
  const oldIndex = JSON.parse(await read(root, '.blocks/index.json')).filter((item) => oldFamilies.includes(item.family));
  assert.equal(JSON.stringify(oldIndex, null, 2) + '\n', expectedIndex);
  assert.equal(await read(root, 'src/blocks/coverage.json'), expectedCoverage);
  const baseline = await adoptedProject(t);
  assert.equal(json(baseline, ['gen']).ok, true);
  json(baseline, ['update']);
  for (const path of oldOutputs.slice(0, 3)) assert.equal(await read(root, path), await read(baseline, path), path);
  const baseGraph = JSON.parse(await read(baseline, '.blocks/view/graph.json'));
  const oldBlocks = (g) => g.nodes.filter((node) => node.kind === 'block' && oldFamilies.includes(node.family));
  assert.deepEqual(oldBlocks(graph), oldBlocks(baseGraph));
  const oldEdges = (g) => g.edges.filter((edge) => oldFamilies.some((family) => edge.from.startsWith(`block:${family}:`)));
  assert.deepEqual(oldEdges(graph), oldEdges(baseGraph));

  // The whole system settles and passes a strict audit.
  commitAll(root, 'adopt 0.7.0 families');
  const audit = run(root, ['audit', '--strict']);
  assert.equal(audit.status, 0, audit.stdout + audit.stderr);
  const report = JSON.parse(audit.stdout);
  assert.equal(report.pass, true);
  for (const id of ['config-valid', 'manifest-valid', 'family-valid', 'family-drift', 'view-fresh']) {
    const rule = report.rules.find((item) => item.id === id);
    assert.deepEqual([id, rule.pass, rule.skipped !== true, rule.findings], [id, true, true, []]);
  }
  assert.equal(run(root, ['gen', '--check']).status, 0);
  assert.equal(git(root, 'status', '--short'), '');

  // The failing side: a join path or group field that the schema does not have is rejected, naming the contract.
  const original = await read(root, 'src/blocks/job/job.family.ts');
  for (const [broken, field] of [[original.replace("match: 'modes[]'", "match: 'nope[]'"), /links\[0\]\.match/], [original.replace("group: { field: 'lane' }", "group: { field: 'nope' }"), /map\.group\.field/]]) {
    await writeFile(join(root, 'src/blocks/job/job.family.ts'), broken);
    const rejected = run(root, ['gen', '--check']);
    assert.equal(rejected.status, 2, rejected.stdout);
    const found = JSON.parse(rejected.stdout).diagnostics.filter((item) => item.file === 'src/blocks/job/job.family.ts');
    assert.ok(found.length >= 1 && found.some((item) => field.test(item.field)), rejected.stdout);
  }
  await writeFile(join(root, 'src/blocks/job/job.family.ts'), original);
  assert.equal(run(root, ['gen', '--check']).status, 0);
});

test('0.7.0: a README region and a derived history label follow the roadmap file without touching hand-written text', async (t) => {
  const root = await settled070(t);
  const badge = (milestone, blocks = 16) => `[${milestone}](./docs/roadmap.md) - ${blocks} blocks`;
  const readmeWith = (text, before = '# Host\n\nHand-written intro.\n\n', after = '\n\nHand-written footer.\n') => `${before}<!-- block-beaver:region badge -->\n${text}\n<!-- /block-beaver:region badge -->${after}`;
  const history = async () => JSON.parse(await read(root, '.blocks/history.json'));

  // #39: gen filled only the region; the hand text and the markers kept their bytes and the file has no header.
  assert.equal(await read(root, 'README.md'), readmeWith(badge('Milestone one')));
  assert.deepEqual((await history()).entries.map((entry) => [entry.label, entry.source]), [['roadmap: Milestone one / 16 blocks', 'gen']], '#40: the first entry carries the derived label');

  // Hand edits outside the region never drift.
  const edited = readmeWith(badge('Milestone one'), '# Host, renamed\n\nA longer hand-written intro.\n\nWith another paragraph.\n\n', '\n\nChanged footer.\n');
  await writeFile(join(root, 'README.md'), edited);
  const quiet = run(root, ['gen', '--check']);
  assert.equal(quiet.status, 0, quiet.stdout);
  assert.deepEqual(JSON.parse(quiet.stdout).pending, []);
  assert.deepEqual(json(root, ['gen']).written, []);
  assert.equal(await read(root, 'README.md'), edited);

  // A roadmap change drifts only the region, and gen rewrites only the region.
  await writeFile(join(root, 'docs/roadmap.md'), 'Milestone two\n');
  const drift = run(root, ['gen', '--check']);
  assert.equal(drift.status, 2, drift.stdout);
  assert.deepEqual(JSON.parse(drift.stdout).diagnostics.map((item) => [item.code, item.file, item.region]), [['output-stale', 'README.md', 'badge']]);
  assert.equal(await read(root, 'README.md'), edited, 'check never writes');
  const historyBytes = await read(root, '.blocks/history.json');
  const written = json(root, ['gen']);
  assert.equal(written.ok, true, JSON.stringify(written.diagnostics));
  assert.deepEqual(written.written, ['README.md']);
  assert.equal(await read(root, 'README.md'), readmeWith(badge('Milestone two'), '# Host, renamed\n\nA longer hand-written intro.\n\nWith another paragraph.\n\n', '\n\nChanged footer.\n'));
  assert.equal(await read(root, '.blocks/history.json'), historyBytes, '#40: an unchanged block set appends nothing and keeps identical bytes');
  assert.equal(run(root, ['gen', '--check']).status, 0);

  // #40: a changed manifest appends one entry labelled from the roadmap as it is now.
  await writeFile(join(root, 'src/blocks/job/manifests/plain.job.ts'), authored('job', 'plain', { tools: 'none', lane: 'slow', implementation: none, name: 'plain, renamed' }));
  const changed = json(root, ['gen']);
  assert.equal(changed.ok, true, JSON.stringify(changed.diagnostics));
  assert.ok(changed.written.includes('.blocks/history.json') && changed.written.includes('.blocks/index.json'));
  assert.deepEqual((await history()).entries.map((entry) => entry.label), ['roadmap: Milestone one / 16 blocks', 'roadmap: Milestone two / 16 blocks']);
  const settledHistory = await read(root, '.blocks/history.json');
  assert.deepEqual(json(root, ['gen']).written, []);
  assert.equal(await read(root, '.blocks/history.json'), settledHistory, 'an unchanged set keeps exact bytes');
  assert.equal(run(root, ['gen', '--check']).status, 0);
  json(root, ['update']);
  assert.deepEqual(JSON.parse(await read(root, '.blocks/view/graph.json')).history.map((entry) => entry.label), ['roadmap: Milestone one / 16 blocks', 'roadmap: Milestone two / 16 blocks']);

  // Broken markers write nothing at all, not even the other outputs that would change.
  const broken = (await read(root, 'README.md')).replace('<!-- /block-beaver:region badge -->', 'oops');
  await writeFile(join(root, 'README.md'), broken);
  await writeFile(join(root, 'docs/roadmap.md'), 'Milestone three\n');
  const refused = run(root, ['gen']);
  assert.equal(refused.status, 2, refused.stdout);
  assert.deepEqual(JSON.parse(refused.stdout).diagnostics.map((item) => [item.code, item.file]), [['region-missing', 'README.md']]);
  assert.equal(JSON.parse(refused.stdout).written.length, 0);
  assert.equal(await read(root, 'README.md'), broken);
  assert.equal(await read(root, '.blocks/history.json'), settledHistory);
});

test('0.7.0: a map-detail view export is far smaller than the full one, drops files and evidence, and fails under a too-small budget', async (t) => {
  // Ordinary code behind the entry gives the full graph file-level nodes and evidence to carry.
  const library = Object.fromEntries(Array.from({ length: 480 }, (_, index) => [`src/lib/m${index}.ts`, `${index ? `import { v${index - 1} } from './m${index - 1}.ts';\n` : ''}export const v${index} = ${index ? `v${index - 1} + 1` : 0};\n`]));
  const root = await settled070(t, { ...library, 'src/main.ts': "import { reader } from './nodes/reader.ts';\nimport { v479 } from './lib/m479.ts';\nexport const main = [reader, v479];\n" });
  const payload = async (path) => (await import(pathToFileURL(join(root, path)).href + `?${Math.random()}`)).BLOCK_BEAVER_VIEW;
  const full = json(root, ['view', '--format', 'module', '--out', 'src/view-full.mjs']);
  assert.equal(full.detail, 'full');
  const fullView = await payload('src/view-full.mjs');
  const limit = Math.floor(full.bytes / 4);
  const map = json(root, ['view', '--format', 'module', '--out', 'src/view-map.mjs', '--detail', 'map', '--max-bytes', String(limit)]);
  assert.equal(map.detail, 'map', JSON.stringify(map) + ' full ' + full.bytes);
  assert.ok(map.bytes <= limit && map.bytes * 4 <= full.bytes, `map ${map.bytes} bytes against full ${full.bytes}`);
  const mapView = await payload('src/view-map.mjs');
  const embedded = (html) => JSON.parse(html.match(/<script type="application\/json" id="family-map-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const [fullData, mapData] = [embedded(fullView), embedded(mapView)];
  assert.ok(fullData.nodes.some((node) => node.kind === 'file') && fullData.edges.some((edge) => edge.evidence?.text), 'the full export carries file nodes and evidence text');
  assert.equal(mapData.nodes.some((node) => node.kind === 'file'), false, 'no file-level nodes in the map payload');
  assert.equal(mapData.edges.some((edge) => edge.evidence?.text !== undefined), false, 'no evidence text in the map payload');
  assert.ok(mapData.edges.length > 0 && mapData.edges.every((edge) => typeof edge.evidence?.file === 'string'), 'links keep their evidence file and line');
  assert.deepEqual(mapData.nodes.filter((node) => node.kind === 'block').map((node) => [node.id, node.group]), fullData.nodes.filter((node) => node.kind === 'block').map((node) => [node.id, node.group]), 'the same blocks and groups');
  assert.deepEqual(mapData.edges.map((edge) => [edge.from, edge.to, edge.kind]), fullData.edges.filter((edge) => edge.from.startsWith('block:') && edge.to.startsWith('block:')).map((edge) => [edge.from, edge.to, edge.kind]), 'the same links');
  assert.deepEqual(JSON.parse(await read(root, '.blocks/view-exports.json')), [{ path: 'src/view-full.mjs', format: 'module' }, { path: 'src/view-map.mjs', format: 'module', detail: 'map' }]);

  // What the map draws is the same: floors, bricks, group labels and links.
  const floors = (html) => [...html.matchAll(/class="floor-title" x="\d+" y="\d+">([^<]+)</g)].map((match) => match[1]);
  const bricks = (html) => [...html.matchAll(/data-map-id="(block:[^"]+)"/g)].map((match) => match[1]);
  const groupLabels = (html) => [...html.matchAll(/<text class="group-label"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  const links = (html) => [...html.matchAll(/class="family-link[^"]*"[^>]*>/g)].length;
  assert.deepEqual(floors(mapView), ['task', 'node', 'model', 'job', 'tool', 'release', 'Ordinary code']);
  assert.deepEqual(floors(mapView), floors(fullView));
  assert.equal(bricks(mapView).length, 16);
  assert.deepEqual(bricks(mapView), bricks(fullView));
  assert.deepEqual(groupLabels(mapView), groupLabels(fullView));
  assert.ok(groupLabels(mapView).includes('Area: unassigned · 2'));
  assert.equal(links(mapView), links(fullView));
  assert.ok(links(mapView) >= 4, 'the join links are drawn');
  for (const id of ['search', 'app-filter', 'cross-app-links']) assert.ok(mapView.includes(`id="${id}"`), id);

  // A budget below the map's size fails deterministically and writes neither the module nor its registry entry.
  const registry = await read(root, '.blocks/view-exports.json');
  const tight = run(root, ['view', '--format', 'module', '--out', 'src/view-tiny.mjs', '--detail', 'map', '--max-bytes', String(map.bytes - 1)]);
  assert.equal(tight.status, 2, tight.stdout + tight.stderr);
  const failure = JSON.parse(tight.stdout);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'view-too-large');
  assert.deepEqual(failure.error.details, { output: 'src/view-tiny.mjs', bytes: map.bytes, limit: map.bytes - 1, detail: 'map' });
  await assert.rejects(read(root, 'src/view-tiny.mjs'), { code: 'ENOENT' });
  assert.equal(await read(root, '.blocks/view-exports.json'), registry);
  assert.equal(run(root, ['view', '--format', 'module', '--out', 'src/view-tiny.mjs', '--detail', 'map', '--max-bytes', String(map.bytes - 1)]).stdout, tight.stdout, 'the same failure every time');

  // gen keeps both registered modules at their recorded detail.
  assert.equal(run(root, ['gen', '--check']).status, 0);
  const again = json(root, ['view', '--format', 'module', '--out', 'src/view-map.mjs']);
  assert.deepEqual([again.detail, again.bytes, again.changed], ['map', map.bytes, []]);
});

async function hookEnv(root) {
  const bin = join(root, '..', 'shim-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'npx'), `#!/bin/sh\nshift 2\nexec "${process.execPath}" "${cli}" "$@"\n`);
  await chmod(join(bin, 'npx'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}
const hookCommit = (root, env, message) => {
  const result = spawnSync('git', ['-C', root, ...identity, 'commit', '-q', '-m', message], { env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, lines: `${result.stdout}${result.stderr}`.split('\n').filter((line) => line.trim() !== '') };
};

test('0.7.0: the managed pre-commit prints one line when a staged audit passes and each error once, with its rule id, when it fails', { skip: process.platform === 'win32' }, async (t) => {
  const root = await settled070(t);
  json(root, ['update']);
  // A real host ignores node_modules; the staged snapshot only holds tracked files.
  await writeFile(join(root, '.gitignore'), `${await read(root, '.gitignore').catch(() => '')}node_modules/\n`);
  commitAll(root, 'adopt 0.7.0 families');
  const env = await hookEnv(root);
  assert.match(await read(root, '.git/hooks/pre-commit'), /audit --staged --format summary --root \./);

  // A passing staged audit: the commit prints one line and nothing else.
  await writeFile(join(root, 'notes.md'), 'one\n');
  git(root, 'add', 'notes.md');
  const passed = hookCommit(root, env, 'add notes');
  assert.equal(passed.status, 0, passed.lines.join('\n'));
  assert.equal(passed.lines.length, 1, passed.lines.join('\n'));
  assert.match(passed.lines[0], /^block-beaver audit: pass \(\d+ files?, 0 errors(?:, 1 warning - run block-beaver audit for the full report)?\)$/);
  assert.equal(git(root, 'log', '--format=%s', '-1').trim(), 'add notes');

  // A failing one: kind "audio" is served by no model, so the cross-family check fails in the staged snapshot.
  await writeFile(join(root, 'src/blocks/task/manifests/draw.task.ts'), authored('task', 'draw', { kind: 'audio', node: 'painter', implementation: none }));
  git(root, 'add', 'src/blocks/task/manifests/draw.task.ts');
  const failed = hookCommit(root, env, 'break draw');
  assert.notEqual(failed.status, 0, 'a failing audit blocks the commit');
  assert.equal(git(root, 'log', '--format=%s', '-1').trim(), 'add notes');
  assert.match(failed.lines[0], /^block-beaver audit: fail \(\d+ files?, (\d+) errors?\)$/);
  const errors = failed.lines.slice(1).filter((line) => !line.startsWith('warning · '));
  assert.equal(errors.length, Number(failed.lines[0].match(/, (\d+) error/)[1]), 'one line per error');
  assert.equal(new Set(failed.lines).size, failed.lines.length, `every line appears once: ${failed.lines.join('\n')}`);
  assert.ok(errors.every((line) => /^[a-z][a-z-]* · /.test(line)), `each error starts with its rule id: ${errors.join('\n')}`);
  const family = errors.filter((line) => line.startsWith('family-valid · '));
  assert.equal(family.length, 1, errors.join('\n'));
  assert.match(family[0], /src\/blocks\/task\/manifests\/draw\.task\.ts/);
  assert.match(family[0], /no model serves/);
  assert.equal(failed.lines.some((line) => /^\s*[{[]|"rules"/.test(line)), false, 'no JSON report in hook output');
});

// ---- 0.8.0: map reach, argKey bindings, gitignored builds, view-export imports, quiet gen, computed scaffolds, narrowing --agents ----

const configFile = (patch) => ({ '.blocks/config.json': JSON.stringify({ ...config, ...patch }, null, 2) + '\n' });
const withMap = (family, map) => family.replace("implementation: ['none'],", `implementation: ['none'],\n  map: ${JSON.stringify(map)},`);
const graphOf = async (root) => JSON.parse(await read(root, '.blocks/view/graph.json'));
const ruleOf = (report, id) => report.rules.find((item) => item.id === id);

test('0.8.0: map.reach registry counts an ordinary importer of the registry output as reach, and map.unused false exempts a family', async (t) => {
  const root = await installedProject(t, {
    'src/blocks/model/model.family.ts': withMap(modelFamily, { reach: 'registry' }),
    'src/blocks/task/task.family.ts': withMap(taskFamily, { unused: false }),
    'src/main.ts': "import { reader } from './nodes/reader.ts';\nimport { models } from './blocks/model/registry.out.ts';\nexport const main = [reader, models];\n",
  });
  assert.equal(json(root, ['gen']).ok, true);
  json(root, ['update']);
  const graph = await graphOf(root);
  assert.deepEqual(graph.unused, [], 'registry reach and map.unused false leave nothing unused');
  const registry = graph.codeReach.filter((entry) => entry.via === 'registry');
  assert.deepEqual(registry.map((entry) => [entry.block, entry.folder, entry.files]), [['block:model:text', 'src', ['src/main.ts']], ['block:model:vision', 'src', ['src/main.ts']]]);
  for (const entry of registry) {
    assert.equal(entry.evidence.length, 1);
    assert.deepEqual([entry.evidence[0].file, entry.evidence[0].line], ['src/main.ts', 2]);
    assert.match(entry.evidence[0].text, /registry\.out\.ts/);
  }
  assert.equal(graph.codeReach.some((entry) => entry.via === 'registry' && entry.block.startsWith('block:task:')), false);
  assert.equal(graph.codeReach.some((entry) => entry.block.startsWith('block:task:')), false, 'task blocks are exempt, not reached');

  // Without either key the same project reports the model and task blocks unused (the importer alone is not reach).
  const plain = await installedProject(t, { 'src/main.ts': "import { reader } from './nodes/reader.ts';\nimport { models } from './blocks/model/registry.out.ts';\nexport const main = [reader, models];\n" });
  assert.equal(json(plain, ['gen']).ok, true);
  json(plain, ['update']);
  assert.deepEqual((await graphOf(plain)).unused, ['block:model:text', 'block:model:vision', 'block:task:draw', 'block:task:summarize']);
});

test('0.8.0: an argKey map binding reaches the block named by a string-literal call argument, and a variable adds nothing', async (t) => {
  const root = await installedProject(t, {
    ...configFile({ map: { ...config.map, bindings: [{ family: 'task', call: 'runTask', argKey: 'key' }] } }),
    'src/main.ts': "import { reader } from './nodes/reader.ts';\nconst runTask = (options: { key: string }) => options.key;\nconst dynamic = 'summarize';\nexport const main = [reader, runTask({ key: 'draw' }), runTask({ key: dynamic })];\n",
  });
  assert.equal(json(root, ['gen']).ok, true);
  json(root, ['update']);
  const graph = await graphOf(root);
  assert.deepEqual(graph.codeReach.filter((entry) => entry.via === 'binding').map((entry) => [entry.block, entry.folder, entry.files]), [['block:task:draw', 'src', ['src/main.ts']]]);
  assert.equal(graph.unused.includes('block:task:draw'), false);
  assert.ok(graph.unused.includes('block:task:summarize'), 'a variable argument reaches nothing');
});

test('0.8.0: a gitignored build file that imports source is left out of the scan and does not make a staged audit call the view stale', { skip: process.platform === 'win32' }, async (t) => {
  const root = await installedProject(t, {
    '.gitignore': 'node_modules/\nout/\n',
    'out/bundle.ts': "import { painter } from '../src/nodes/reader.ts';\nexport const built = painter;\n",
  });
  // Git lists the work tree only once something is tracked (a fresh repo falls back to the plain walk).
  commitAll(root, 'seed');
  assert.equal(json(root, ['gen']).ok, true);
  json(root, ['update']);
  const graph = await graphOf(root);
  assert.equal(graph.nodes.some((node) => node.path?.startsWith('out/')), false, 'working-tree scan excludes the ignored folder');
  assert.equal(graph.edges.some((edge) => `${edge.from} ${edge.to}`.includes('out/')), false);
  assert.equal(JSON.stringify(graph).includes('out/bundle.ts'), false);

  commitAll(root, 'adopt families');
  assert.equal(git(root, 'ls-files', 'out'), '', 'the build file is never tracked');
  // Stage a source change, regenerate in the working tree, then audit the staged snapshot.
  await writeFile(join(root, 'src/nodes/reader.ts'), 'export const reader = () => "read";\nexport const painter = () => "paint it";\n');
  git(root, 'add', 'src/nodes/reader.ts');
  json(root, ['gen']);
  json(root, ['update']);
  const staged = run(root, ['audit', '--staged']);
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const report = JSON.parse(staged.stdout);
  assert.equal(report.pass, true);
  const fresh = ruleOf(report, 'view-fresh');
  assert.deepEqual([fresh.pass, fresh.findings], [true, []]);
});

test('0.8.0: a source file importing a registered view export module passes audit --strict without raising the resolution ratchet', async (t) => {
  const root = await installedProject(t);
  assert.equal(json(root, ['gen']).ok, true);
  const exported = json(root, ['view', '--format', 'module', '--out', 'src/view.mjs']);
  assert.ok(exported.bytes > 0, JSON.stringify(exported));
  assert.deepEqual(JSON.parse(await read(root, '.blocks/view-exports.json')), [{ path: 'src/view.mjs', format: 'module' }]);
  await writeFile(join(root, 'src/main.ts'), "import { reader } from './nodes/reader.ts';\nimport { BLOCK_BEAVER_VIEW } from './view.mjs';\nexport const main = [reader, BLOCK_BEAVER_VIEW];\n");
  json(root, ['view', '--format', 'module', '--out', 'src/view.mjs']);
  json(root, ['update']);
  const graph = await graphOf(root);
  assert.equal(graph.unresolved?.length ?? graph.resolution?.unresolved ?? 0, 0, 'the export import is known, not unresolved');
  commitAll(root, 'import the view export');
  const audit = run(root, ['audit', '--strict']);
  assert.equal(audit.status, 0, audit.stdout + audit.stderr);
  const report = JSON.parse(audit.stdout);
  assert.equal(report.pass, true);
  for (const id of ['resolution-ratchet', 'view-fresh', 'undeclared-link']) {
    const rule = ruleOf(report, id);
    assert.deepEqual([id, rule.pass, rule.findings], [id, true, []]);
  }
  assert.equal(run(root, ['gen', '--check']).status, 0);
});

test('0.8.0: gen --check --format summary prints exactly one line on a clean tree and exits 0', async (t) => {
  const root = await installedProject(t);
  assert.equal(json(root, ['gen']).ok, true);
  const quiet = run(root, ['gen', '--check', '--format', 'summary']);
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.equal(quiet.stderr, '');
  assert.match(quiet.stdout, /^block-beaver gen: \d+ outputs? current\n$/);
  assert.equal(quiet.stdout.trimEnd().split('\n').length, 1);

  // A drifted output fails with one line per failing output and no JSON.
  await writeFile(join(root, 'src/blocks/coverage.json'), '{}\n');
  const drift = run(root, ['gen', '--check', '--format', 'summary']);
  assert.equal(drift.status, 2, drift.stdout);
  assert.match(drift.stdout, /src\/blocks\/coverage\.json · /);
  assert.equal(/^\s*[{[]/m.test(drift.stdout), false);
});

const planTaskFamily = taskFamily.replace("import { defineFamily, s } from 'block-beaver/kernel';", "import { createHash } from 'node:crypto';\nimport { defineFamily, s } from 'block-beaver/kernel';").replace("  generators: ['registry', 'index'],", `  generators: ['registry', 'index'],
  scaffold: {
    async plan(input, { all, readFile, id }) {
      const list = await readFile('docs/task-list.json');
      const next = JSON.stringify({ tasks: [...JSON.parse(list).tasks, id] }, null, 2) + '\\n';
      const node = input.node ?? all.find((item) => item.family === 'node')?.id ?? 'reader';
      return {
        files: [{ path: 'src/blocks/task/manifests/' + id + '.task.ts', content: 'export const ' + id.replace(/-/g, '_') + ' = ' + JSON.stringify({ id, family: 'task', version: 1, name: id, description: 'The ' + id + ' task', rationale: 'Keeps ' + id + ' cohesive', kind: input.kind, node, implementation: { kind: 'none' } }) + ' as const;\\n' }],
        updates: [{ path: 'docs/task-list.json', content: next, before: 'sha256:' + createHash('sha256').update(list).digest('hex') }],
        manualSteps: ['Announce ' + id],
      };
    },
  },`);
const taskList = '{\n  "tasks": [\n    "draw",\n    "summarize"\n  ]\n}\n';

test('0.8.0: a computed scaffold creates the manifest and updates an existing file, with a dry-run diff, then applies and runs gen', async (t) => {
  const root = await installedProject(t, { 'src/blocks/task/task.family.ts': planTaskFamily, 'docs/task-list.json': taskList });
  assert.equal(json(root, ['gen']).ok, true);
  const kit = (...args) => JSON.parse(run(root, ['kit', 'create', 'task', 'translate', '--input', '{"kind":"text"}', ...args]).stdout);
  const manifest = 'src/blocks/task/manifests/translate.task.ts';

  const dry = run(root, ['kit', 'create', 'task', 'translate', '--input', '{"kind":"text"}', '--dry-run']);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  const preview = JSON.parse(dry.stdout).result;
  assert.ok(preview.written.some((file) => file.path === manifest), JSON.stringify(preview.written));
  assert.deepEqual(preview.updated.map((file) => file.path), ['docs/task-list.json']);
  assert.match(preview.updated[0].diff, /^--- a\/docs\/task-list\.json/);
  assert.match(preview.updated[0].diff, /^\+    "translate"/m);
  assert.deepEqual(preview.manualSteps, ['Announce translate']);
  assert.equal(await read(root, 'docs/task-list.json'), taskList, 'a dry run writes nothing');
  await assert.rejects(read(root, manifest), { code: 'ENOENT' });
  assert.equal(await read(root, 'src/blocks/task/registry.out.ts').then((text) => text.includes('translate')), false);

  const applied = run(root, ['kit', 'create', 'task', 'translate', '--input', '{"kind":"text"}']);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).result.updated.map((file) => file.path), ['docs/task-list.json']);
  assert.match(await read(root, manifest), /"kind":"text"/);
  assert.deepEqual(JSON.parse(await read(root, 'docs/task-list.json')).tasks, ['draw', 'summarize', 'translate']);
  assert.match(await read(root, 'src/blocks/task/registry.out.ts'), /translate/, 'gen ran after the write');
  assert.ok(JSON.parse(await read(root, '.blocks/index.json')).some((item) => item.id === 'translate'));
  assert.equal(run(root, ['gen', '--check']).status, 0);
  assert.ok(kit().ok === false, 'the manifest now exists, so a second create is refused');
});

async function twoAgentProject(t) {
  const root = await installationFixture(t);
  const runner = packageRunner(root);
  await installProject(root, { agents: ['claude', 'codex'], runner });
  return { root, runner };
}
const exists = (root, path) => readFile(join(root, path)).then(() => true, () => false);

test('0.8.0: install --agents claude removes the codex-managed files and install --agents claude --check then exits 0', async (t) => {
  const { root } = await twoAgentProject(t);
  for (const path of ['.codex/hooks.json', '.agents/skills/block-beaver/SKILL.md']) assert.equal(await exists(root, path), true, path);
  const install = (...args) => spawnSync(process.execPath, [cli, 'install', '--root', root, '--agents', 'claude', ...args], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(install('--check').status, 2, 'the narrowing is pending until applied');
  const dry = install('--dry-run');
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.equal(await exists(root, '.codex/hooks.json'), true, 'a dry run removes nothing');
  const narrowed = install();
  assert.equal(narrowed.status, 0, narrowed.stdout + narrowed.stderr);
  for (const path of ['.codex/hooks.json', '.codex/config.toml', '.agents/skills/block-beaver/SKILL.md']) assert.equal(await exists(root, path), false, path);
  assert.equal(await exists(root, '.claude/skills/block-beaver/SKILL.md'), true);
  assert.deepEqual(JSON.parse(await read(root, '.blocks/install.json')).agents, ['claude']);
  const settled = install('--check');
  assert.equal(settled.status, 0, settled.stdout + settled.stderr);
});

// The pre-0.8.0 managed guidance, byte for byte, for a config without families.
const guidance070 = `## Block Beaver\n\nRead and follow .blocks/WORKFLOW.md before changing code.\n- Install this project’s locked dependencies with its package manager and use the pinned local Block Beaver command (for npm, \`npx --no-install block-beaver\`).\n- Inspect the owning block, its files, dependencies, and dependents using a fresh source graph and the authoritative registry.\n- Record purpose, rationale, file boundaries, interfaces, and verification before implementing a feature. Stay inside the agreed block; declare new connections and propose new blocks through plan/propose/check/review.\n- Review .blocks/config.json application ownership and health. Preserve owner-controlled entries; resolve imports using the owning app's tsconfig.\n- Require review JSON \`readyForApproval: true\` before approval. After authorized approval, run \`block-beaver integrate ROADMAP BLOCK --root .\` to apply the reviewed changes and create their receipt. Stage the receipt and matching workflow evidence with the implementation.\n- Run \`block-beaver audit --root .\` before finishing and \`block-beaver audit --staged --root .\` before committing. Record justified exceptions with the CLI.\n- After source or manifest changes, run \`block-beaver update --root .\` to regenerate the graph and view. Never hand-edit generated outputs.\n- Run \`block-beaver start --root .\` for live updates. Report affected blocks and verification at completion.\n`;

test('0.8.0 compatibility: a project that uses none of the new keys keeps its graph, generated bytes and guidance', async (t) => {
  const root = await installedProject(t);
  assert.equal(json(root, ['gen']).ok, true);
  json(root, ['update']);
  const outputs = ['.blocks/index.json', 'src/blocks/coverage.json', 'src/blocks/node/registry.out.ts', 'src/blocks/model/registry.out.ts', 'src/blocks/task/registry.out.ts'];
  const before = Object.fromEntries(await Promise.all(outputs.map(async (path) => [path, await read(root, path)])));
  const graphText = await read(root, '.blocks/view/graph.json');
  const normalize = (text) => JSON.stringify({ ...JSON.parse(text), scannedAt: 0 });

  // Generated bytes equal what the 0.6.0/0.7.0 parts assert, and a second gen/update changes nothing.
  assert.equal(before['.blocks/index.json'], expectedIndex);
  assert.equal(before['src/blocks/coverage.json'], expectedCoverage);
  assert.deepEqual(json(root, ['gen']).written, []);
  json(root, ['update']);
  for (const path of outputs) assert.equal(await read(root, path), before[path], path);
  assert.equal(normalize(await read(root, '.blocks/view/graph.json')), normalize(graphText), 'graph.json is stable apart from scannedAt');

  // None of the 0.8.0 fields appear in graph.json, and the schema stays at 2.
  const graph = JSON.parse(graphText);
  assert.equal(graph.schemaVersion, 2);
  const compact = graphText.replace(/\s+/g, '');
  for (const key of ['excludedKnown', 'packageImports', 'railLimit']) assert.equal(compact.includes(`"${key}"`), false, key);
  for (const via of ['registry', 'binding']) assert.equal(compact.includes(`"via":"${via}"`), false, via);
  assert.equal(Object.hasOwn(graph, 'view'), false);
  assert.equal(Object.hasOwn(graph.mapStyle ?? {}, 'railLimit'), false);
  assert.ok(graph.codeReach.every((entry) => !Object.hasOwn(entry, 'evidence')), 'code reach entries carry no evidence');
  assert.ok(graph.codeReach.every((entry) => entry.via === 'import'));

  // Guidance without families is the pre-0.8.0 text, and an install writes exactly that between the markers.
  assert.equal(renderAgentInstructions(), guidance070);
  assert.equal(renderAgentInstructions({}), guidance070);
  assert.equal(renderAgentInstructions({ schemaVersion: 1, apps: [] }), guidance070);
  const plain = await installationFixture(t);
  const installed = await installProject(plain, { agents: ['claude'], runner: packageRunner(plain) });
  assert.equal(installed.complete, true, JSON.stringify(installed.conflicts));
  const claude = (await read(plain, 'CLAUDE.md')).replaceAll('\r\n', '\n');
  const section = claude.match(/<!-- block-beaver:start -->\n<!-- block-beaver:hash [a-f0-9]{64} -->\n([\s\S]*?)<!-- block-beaver:end -->/);
  assert.ok(section, claude);
  assert.equal(section[1].replace(/^<!-- block-beaver:version [^\n]* -->\n/, ''), guidance070, 'the version comment is the only addition');
});
