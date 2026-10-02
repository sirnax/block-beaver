import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { planHostSetup } from '../src/install-host.mjs';
import { writeProjectFiles } from '../src/project-files.mjs';

// Keep the developer's own Git configuration out of the disposable fixtures.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const version = '0.3.0';
const shell = '# block-beaver:start\n# block-beaver:hash 6102b56f70608dbe9204d8b6c38c92726eb3100d6d1c47068ddf37499f61e34d\nnpx --no-install block-beaver audit --staged --format summary --root . || exit $?\n# block-beaver:end\n';
const lefthookCommand = '      run: npx --no-install block-beaver audit --staged --format summary --root .\n';
const withoutHashes = (text) => text.replace(/^[ \t]*# block-beaver:hash [a-f0-9]{64}\n/gm, '');

async function repo(t, files = {}, { remote } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  if (remote) execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
const plan = (root, options = {}) => planHostSetup(root, { version, config: {}, agents: [], ...options });
const text = (root, path) => readFile(join(root, path), 'utf8');
const file = (result, path) => result.files.find((entry) => entry.path === path);
const hook = (result) => result.hooks.find((entry) => entry.path === '.git/hooks/pre-commit');
const codes = (list) => list.map((entry) => entry.code);

async function apply(root, result) {
  await writeProjectFiles(root, result.files.filter((entry) => entry.content !== null));
  for (const entry of result.files) {
    if (entry.content === null) await rm(join(root, entry.path));
    else if (entry.mode) await chmod(join(root, entry.path), entry.mode);
  }
  for (const entry of result.hooks) {
    if (entry.content === null) { await rm(entry.absolutePath); continue; }
    await mkdir(dirname(entry.absolutePath), { recursive: true });
    await writeFile(entry.absolutePath, entry.content);
    await chmod(entry.absolutePath, entry.mode);
  }
}
function ignored(root, path) {
  try { execFileSync('git', ['-C', root, 'check-ignore', '-q', path], { stdio: 'pipe' }); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}

test('bare git hook chains behind existing commands, is idempotent, and uninstalls exactly', async (t) => {
  const original = '#!/bin/sh\necho owner-check\n';
  const root = await repo(t);
  const fresh = await plan(root);
  assert.deepEqual(fresh.conflicts, []);
  assert.equal(hook(fresh).content, `#!/bin/sh\n${shell}`);
  assert.equal(hook(fresh).before, null);
  assert.equal(hook(fresh).mode, 0o755);
  assert.equal(hook(fresh).kind, 'hook');
  assert.equal(fresh.files.length, 0, 'The planner returns hooks separately from project files.');
  await assert.rejects(readFile(join(root, '.git/hooks/pre-commit')), { code: 'ENOENT' }, 'Planning never writes.');

  await mkdir(join(root, '.git/hooks'), { recursive: true });
  await writeFile(join(root, '.git/hooks/pre-commit'), original);
  const chained = await plan(root);
  assert.equal(hook(chained).content, `#!/bin/sh\n${shell}echo owner-check\n`);
  await apply(root, chained);
  const again = await plan(root);
  assert.deepEqual(again.hooks, []);
  assert.deepEqual(again.files, []);

  const removal = await plan(root, { operation: 'uninstall' });
  assert.equal(hook(removal).content, original, 'Only the managed step is removed.');
  await apply(root, removal);
  assert.equal(await text(root, '.git/hooks/pre-commit'), original);
  assert.deepEqual((await plan(root, { operation: 'uninstall' })).hooks, []);
});

test('uninstall deletes a bare hook that only held the managed step', async (t) => {
  const root = await repo(t);
  await apply(root, await plan(root));
  const removal = await plan(root, { operation: 'uninstall' });
  assert.equal(hook(removal).content, null);
  assert.equal(hook(removal).before, `#!/bin/sh\n${shell}`);
});

test('non-shell, symlinked, and ambiguous bare hooks report conflicts and are never replaced', async (t) => {
  const node = await repo(t, { '.git/hooks/pre-commit': '#!/usr/bin/env node\nconsole.log("owner");\n' });
  const nodePlan = await plan(node);
  assert.deepEqual(nodePlan.hooks, []);
  assert.deepEqual(codes(nodePlan.conflicts), ['unsupported-hook']);
  assert.equal(nodePlan.conflicts[0].path, '.git/hooks/pre-commit');

  const linked = await repo(t, { 'owner-hook': '#!/bin/sh\ntrue\n' });
  await mkdir(join(linked, '.git/hooks'), { recursive: true });
  await symlink(join(linked, 'owner-hook'), join(linked, '.git/hooks/pre-commit'));
  const linkedPlan = await plan(linked);
  assert.deepEqual(linkedPlan.hooks, []);
  assert.deepEqual(codes(linkedPlan.conflicts), ['unsupported-hook']);

  const twice = await repo(t, { '.git/hooks/pre-commit': `#!/bin/sh\n${shell}${shell}` });
  const twicePlan = await plan(twice);
  assert.deepEqual(twicePlan.hooks, []);
  assert.deepEqual(codes(twicePlan.conflicts), ['ambiguous-markers']);
});

test('bare hook accepts env shells and an in-repository hooks path is planned as a project file', async (t) => {
  const env = await repo(t, { '.git/hooks/pre-commit': '#!/usr/bin/env bash\nset -e\nmake lint\n' });
  assert.equal(hook(await plan(env)).content, `#!/usr/bin/env bash\n${shell}set -e\nmake lint\n`);

  const custom = await repo(t, { '.githooks/pre-commit': '#!/bin/sh\nmake lint\n' });
  execFileSync('git', ['-C', custom, 'config', 'core.hooksPath', '.githooks']);
  const result = await plan(custom);
  assert.deepEqual(result.hooks, []);
  assert.equal(file(result, '.githooks/pre-commit').content, `#!/bin/sh\n${shell}make lint\n`);
  assert.equal(file(result, '.githooks/pre-commit').kind, 'hook');

  const outside = await repo(t);
  execFileSync('git', ['-C', outside, 'config', 'core.hooksPath', '/opt/owner-hooks']);
  const outsidePlan = await plan(outside);
  assert.deepEqual(outsidePlan.hooks, []);
  assert.deepEqual(codes(outsidePlan.conflicts), ['unsupported-hook']);
});

test('husky pre-commit keeps owner commands, headers, and mode, and removes only the managed step', async (t) => {
  const v9 = await repo(t, { '.husky/pre-commit': 'npm test\n' });
  const v9Plan = await plan(v9);
  assert.deepEqual(v9Plan.hooks, [], 'Husky repositories never get a direct Git hook.');
  assert.equal(file(v9Plan, '.husky/pre-commit').content, `${shell}npm test\n`);
  await apply(v9, v9Plan);
  assert.deepEqual((await plan(v9)).files, []);
  const removal = await plan(v9, { operation: 'uninstall' });
  assert.equal(file(removal, '.husky/pre-commit').content, 'npm test\n');

  const header = '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n';
  const v8 = await repo(t, { '.husky/pre-commit': `${header}\nnpx lint-staged\n` });
  const v8Plan = await plan(v8);
  assert.equal(file(v8Plan, '.husky/pre-commit').content, `${header}${shell}\nnpx lint-staged\n`);
  await apply(v8, v8Plan);
  assert.equal(file(await plan(v8, { operation: 'uninstall' }), '.husky/pre-commit').content, `${header}\nnpx lint-staged\n`);

  const empty = await repo(t, { '.husky/commit-msg': 'npx commitlint\n' });
  const created = file(await plan(empty), '.husky/pre-commit');
  assert.equal(created.before, null);
  assert.equal(created.content, shell);
  assert.equal(created.mode, 0o755);
  await apply(empty, await plan(empty));
  assert.equal(file(await plan(empty, { operation: 'uninstall' }), '.husky/pre-commit').content, null);
});

test('husky hooks that are not shell scripts, or use legacy package configuration, are reported', async (t) => {
  const node = await repo(t, { '.husky/pre-commit': '#!/usr/bin/env node\nconsole.log(1);\n' });
  const nodePlan = await plan(node);
  assert.deepEqual(nodePlan.files, []);
  assert.deepEqual(codes(nodePlan.conflicts), ['unsupported-hook']);
  assert.equal(nodePlan.conflicts[0].path, '.husky/pre-commit');

  const legacy = await repo(t, { 'package.json': JSON.stringify({ husky: { hooks: { 'pre-commit': 'lint' } } }) });
  const legacyPlan = await plan(legacy);
  assert.deepEqual(legacyPlan.hooks, []);
  assert.deepEqual(codes(legacyPlan.conflicts), ['unsupported-hook']);

  const linked = await repo(t, { 'owner-hook': 'true\n' });
  await mkdir(join(linked, '.husky'));
  await symlink(join(linked, 'owner-hook'), join(linked, '.husky/pre-commit'));
  const linkedPlan = await plan(linked);
  assert.deepEqual(linkedPlan.files, []);
  assert.deepEqual(codes(linkedPlan.conflicts), ['unsafe-path']);
});

test('lefthook command is added without disturbing other commands and round-trips on uninstall', async (t) => {
  const original = 'pre-commit:\n  commands:\n    lint:\n      run: npm run lint\n';
  const root = await repo(t, { 'lefthook.yml': original });
  const result = await plan(root);
  assert.deepEqual(result.hooks, []);
  assert.deepEqual(result.conflicts, []);
  assert.equal(withoutHashes(file(result, 'lefthook.yml').content),
    `pre-commit:\n  commands:\n    # block-beaver:start\n    block-beaver:\n${lefthookCommand}    # block-beaver:end\n    lint:\n      run: npm run lint\n`);
  await apply(root, result);
  assert.deepEqual((await plan(root)).files, []);
  assert.equal(file(await plan(root, { operation: 'uninstall' }), 'lefthook.yml').content, original);
});

test('lefthook uses the owner indentation, adds missing sections, and keeps unrelated hooks', async (t) => {
  const wide = await repo(t, { 'lefthook.yml': 'pre-commit:\n    parallel: true\n    commands:\n        lint:\n            run: x\npre-push:\n  commands:\n    test:\n      run: y\n' });
  const widePlan = file(await plan(wide), 'lefthook.yml').content;
  assert.match(withoutHashes(widePlan), /commands:\n        # block-beaver:start\n        block-beaver:\n/);
  assert.match(widePlan, /pre-push:\n {2}commands:\n {4}test:\n {6}run: y\n$/);

  const noCommands = await repo(t, { 'lefthook.yml': 'pre-commit:\n  parallel: true\n' });
  assert.equal(withoutHashes(file(await plan(noCommands), 'lefthook.yml').content),
    `pre-commit:\n  # block-beaver:start\n  commands:\n    block-beaver:\n${lefthookCommand}  # block-beaver:end\n  parallel: true\n`);

  const onlyPush = await repo(t, { 'lefthook.yml': 'pre-push:\n  commands:\n    test:\n      run: y\n' });
  const created = file(await plan(onlyPush), 'lefthook.yml').content;
  assert.equal(withoutHashes(created), `pre-push:\n  commands:\n    test:\n      run: y\n# block-beaver:start\npre-commit:\n  commands:\n    block-beaver:\n${lefthookCommand}# block-beaver:end\n`);
  await apply(onlyPush, await plan(onlyPush));
  assert.equal(file(await plan(onlyPush, { operation: 'uninstall' }), 'lefthook.yml').content, 'pre-push:\n  commands:\n    test:\n      run: y\n');

  const bare = await repo(t, { 'package.json': JSON.stringify({ devDependencies: { lefthook: '^1.0.0' } }) });
  const fresh = await plan(bare);
  assert.equal(file(fresh, 'lefthook.yml').before, null);
  assert.deepEqual(fresh.hooks, []);
  await apply(bare, fresh);
  assert.equal(file(await plan(bare, { operation: 'uninstall' }), 'lefthook.yml').content, null);
});

test('unsupported lefthook forms and manager collisions are conflicts, not rewrites', async (t) => {
  const forms = {
    jobs: 'pre-commit:\n  jobs:\n    - run: x\n',
    flow: 'pre-commit: { commands: { lint: { run: x } } }\n',
    collision: 'pre-commit:\n  commands:\n    block-beaver:\n      run: other\n',
    tabs: 'pre-commit:\n\tcommands:\n\t\tlint:\n\t\t\trun: x\n',
  };
  for (const [name, content] of Object.entries(forms)) {
    const root = await repo(t, { 'lefthook.yml': content });
    const result = await plan(root);
    assert.deepEqual(result.files, [], name);
    assert.deepEqual(result.hooks, [], name);
    assert.equal(result.conflicts.length, 1, name);
    assert.equal(result.conflicts[0].path, 'lefthook.yml', name);
  }
  const json = await repo(t, { 'lefthook.json': '{}' });
  assert.deepEqual(codes((await plan(json)).conflicts), ['unsupported-hook']);

  const both = await repo(t, { 'lefthook.yml': 'pre-commit:\n  commands: {}\n', '.husky/pre-commit': 'npm test\n' });
  const bothPlan = await plan(both);
  assert.deepEqual(codes(bothPlan.conflicts), ['ambiguous-hook-manager']);
  assert.deepEqual(bothPlan.hooks, []);
  assert.deepEqual(bothPlan.files, []);

  const pythonManager = await repo(t, { '.pre-commit-config.yaml': 'repos: []\n' });
  assert.deepEqual(codes((await plan(pythonManager)).conflicts), ['unsupported-hook']);
});

test('GitHub gets a dedicated managed workflow that leaves other workflows untouched', async (t) => {
  const root = await repo(t, { '.github/workflows/ci.yml': 'name: CI\non: push\njobs: {}\n', 'package-lock.json': '{}' });
  const result = await plan(root);
  assert.equal(file(result, '.github/workflows/ci.yml'), undefined);
  const workflow = file(result, '.github/workflows/block-beaver.yml');
  assert.equal(workflow.kind, 'ci');
  assert.equal(workflow.before, null);
  assert.ok(withoutHashes(workflow.content).startsWith('# block-beaver:managed-ci\n# block-beaver:start\n# block-beaver:version 0.3.0\n'));
  assert.match(workflow.content, /pull_request/);
  assert.match(workflow.content, /fetch-depth: 0/);
  assert.match(workflow.content, /run: npm ci\n/);
  assert.match(workflow.content, /run: npx --no-install block-beaver audit --base merge-base --strict --format summary\n/);
  assert.match(workflow.content, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.ok(!workflow.content.split('\n').some((line) => /run:/.test(line) && line.includes('${{')), 'Branch names reach scripts through the environment, never by interpolation.');
  await apply(root, result);
  assert.deepEqual((await plan(root)).files, []);
  assert.equal((await plan(root, { version: '0.4.0' })).files[0].content.includes('# block-beaver:version 0.4.0'), true);
  const removal = await plan(root, { operation: 'uninstall' });
  assert.equal(file(removal, '.github/workflows/block-beaver.yml').content, null);
  assert.equal(removal.files.length, 1);
});

test('GitHub workflow install command follows the lockfile and a colliding owner file is a conflict', async (t) => {
  const pnpm = await repo(t, { '.github/workflows/ci.yml': 'on: push\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
  assert.match(file(await plan(pnpm), '.github/workflows/block-beaver.yml').content, /pnpm install --frozen-lockfile/);
  const bun = await repo(t, { '.github/workflows/ci.yml': 'on: push\n', 'bun.lock': '{}' });
  const bunContent = file(await plan(bun), '.github/workflows/block-beaver.yml').content;
  assert.match(bunContent, /oven-sh\/setup-bun/);
  assert.match(bunContent, /bun install --frozen-lockfile/);
  const ambiguous = await repo(t, { '.github/workflows/ci.yml': 'on: push\n', 'pnpm-lock.yaml': '', 'yarn.lock': '' });
  const ambiguousPlan = await plan(ambiguous);
  assert.equal(file(ambiguousPlan, '.github/workflows/block-beaver.yml'), undefined);
  assert.deepEqual(codes(ambiguousPlan.conflicts), ['ambiguous-package-manager']);

  const owner = await repo(t, { '.github/workflows/block-beaver.yml': 'name: mine\non: push\n' });
  const ownerPlan = await plan(owner);
  assert.deepEqual(ownerPlan.files, []);
  assert.deepEqual(codes(ownerPlan.conflicts), ['ci-collision']);
  assert.match(ownerPlan.conflicts[0].remediation, /audit --base merge-base --strict/);
  assert.deepEqual((await plan(owner, { operation: 'uninstall' })).files, [], 'Owner workflows are never removed.');
});

test('GitLab gets a managed job file and a marked include that preserve the owner configuration', async (t) => {
  const original = 'stages:\n  - test\n\nunit:\n  script: npm test\n';
  const root = await repo(t, { '.gitlab-ci.yml': original });
  const result = await plan(root);
  const config = file(result, '.gitlab-ci.yml');
  assert.equal(withoutHashes(config.content), `${original}\n# block-beaver:start\ninclude:\n  - local: .blocks/ci/gitlab.yml\n# block-beaver:end\n`);
  const job = file(result, '.blocks/ci/gitlab.yml');
  assert.ok(job.content.startsWith('# block-beaver:managed-ci\n'));
  assert.match(job.content, /GIT_DEPTH: '0'/);
  assert.match(job.content, /npx --no-install block-beaver audit --base merge-base --strict --format summary\n/);
  await apply(root, result);
  assert.deepEqual((await plan(root)).files, []);
  const removal = await plan(root, { operation: 'uninstall' });
  assert.equal(file(removal, '.gitlab-ci.yml').content, original);
  assert.equal(file(removal, '.blocks/ci/gitlab.yml').content, null);

  const fromRemote = await repo(t, {}, { remote: 'git@gitlab.com:acme/app.git' });
  const created = file(await plan(fromRemote), '.gitlab-ci.yml');
  assert.equal(withoutHashes(created.content), '# block-beaver:start\ninclude:\n  - local: .blocks/ci/gitlab.yml\n# block-beaver:end\n');
  await apply(fromRemote, await plan(fromRemote));
  assert.equal(file(await plan(fromRemote, { operation: 'uninstall' }), '.gitlab-ci.yml').content, null);
});

test('GitLab include collisions and undetected providers are reported without changes', async (t) => {
  const include = await repo(t, { '.gitlab-ci.yml': 'include:\n  - local: other.yml\n' });
  const includePlan = await plan(include);
  assert.deepEqual(codes(includePlan.conflicts), ['gitlab-include']);
  assert.match(includePlan.conflicts[0].remediation, /\.blocks\/ci\/gitlab\.yml/);
  assert.equal(file(includePlan, '.gitlab-ci.yml'), undefined);

  const none = await repo(t);
  const nonePlan = await plan(none);
  assert.deepEqual(nonePlan.files, []);
  assert.ok(codes(nonePlan.diagnostics).includes('ci-provider-undetected'));
  const github = await repo(t, {}, { remote: 'https://github.com/acme/app.git' });
  assert.ok(file(await plan(github), '.github/workflows/block-beaver.yml'));
});

test('ignored install targets are reported with their ignore source and left alone by default', async (t) => {
  const root = await repo(t, { '.gitignore': '.claude/\n.claude/settings.local.json\n.claude/worktrees/\n' });
  const result = await plan(root, { agents: ['claude'] });
  const reported = result.diagnostics.filter((entry) => entry.code === 'ignored-target');
  assert.deepEqual(reported.map((entry) => entry.path).sort(), ['.claude/settings.json', '.claude/skills/block-beaver/']);
  assert.ok(reported.every((entry) => entry.source === '.gitignore:1:.claude/'));
  assert.ok(reported.every((entry) => /--fix-ignores/.test(entry.remediation)));
  assert.equal(file(result, '.gitignore'), undefined);
  const untouched = await plan(root, { agents: ['codex'] });
  assert.equal(untouched.diagnostics.filter((entry) => entry.code === 'ignored-target').length, 0, 'Only the selected agents are checked.');
});

test('--fix-ignores unignores only managed paths, keeps local settings and worktrees ignored, and is idempotent', async (t) => {
  const original = '.claude/\n.claude/settings.local.json\n.claude/worktrees/\nnode_modules/\n';
  const root = await repo(t, { '.gitignore': original });
  const result = await plan(root, { agents: ['claude'], fixIgnores: true });
  const edited = file(result, '.gitignore');
  assert.equal(edited.kind, 'gitignore');
  assert.equal(withoutHashes(edited.content), `${original}# block-beaver:start\n!.claude/\n.claude/*\n!.claude/settings.json\n!.claude/skills/\n.claude/skills/*\n!.claude/skills/block-beaver/\n# block-beaver:end\n`);
  await apply(root, result);
  assert.equal(ignored(root, '.claude/settings.json'), false);
  assert.equal(ignored(root, '.claude/skills/block-beaver/SKILL.md'), false);
  assert.equal(ignored(root, '.claude/settings.local.json'), true);
  assert.equal(ignored(root, '.claude/worktrees/task/file.txt'), true);
  assert.equal(ignored(root, '.claude/skills/other/SKILL.md'), true);
  assert.equal(ignored(root, 'node_modules/pkg/index.js'), true);
  const again = await plan(root, { agents: ['claude'], fixIgnores: true });
  assert.deepEqual(again.files, []);
  assert.equal(again.diagnostics.filter((entry) => entry.code === 'ignored-target').length, 0);
  const removal = await plan(root, { agents: ['claude'], operation: 'uninstall' });
  assert.equal(file(removal, '.gitignore').content, original);
});

test('--fix-ignores handles codex paths, narrower owner rules, and unfixable nested ignores', async (t) => {
  const codex = await repo(t, { '.gitignore': '.agents/\n.codex/\n' });
  const codexPlan = file(await plan(codex, { agents: ['codex'], fixIgnores: true }), '.gitignore').content;
  assert.match(codexPlan, /!\.agents\/\n\.agents\/\*\n!\.agents\/skills\/\n\.agents\/skills\/\*\n!\.agents\/skills\/block-beaver\/\n/);
  assert.match(codexPlan, /!\.codex\/\n\.codex\/\*\n!\.codex\/hooks\.json\n/);
  await apply(codex, await plan(codex, { agents: ['codex'], fixIgnores: true }));
  assert.equal(ignored(codex, '.codex/hooks.json'), false);
  assert.equal(ignored(codex, '.codex/other.json'), true);

  const narrow = await repo(t, { '.gitignore': '.claude/settings.json\n' });
  assert.equal(withoutHashes(file(await plan(narrow, { agents: ['claude'], fixIgnores: true }), '.gitignore').content), '.claude/settings.json\n# block-beaver:start\n!.claude/settings.json\n# block-beaver:end\n');

  const nested = await repo(t, { '.claude/.gitignore': '*\n' });
  const nestedPlan = await plan(nested, { agents: ['claude'], fixIgnores: true });
  assert.equal(file(nestedPlan, '.gitignore'), undefined);
  assert.ok(codes(nestedPlan.diagnostics).includes('ignored-target-unfixable'));
  assert.match(nestedPlan.diagnostics.find((entry) => entry.code === 'ignored-target-unfixable').message, /\.claude\/\.gitignore/);

  const notClaude = await repo(t, { '.gitignore': 'CLAUDE.md\n' });
  const notPlan = await plan(notClaude, { agents: ['claude'], fixIgnores: true });
  assert.equal(file(notPlan, '.gitignore'), undefined, 'Only managed .claude/.agents/.codex paths are unignored.');
  assert.ok(notPlan.diagnostics.some((entry) => entry.code === 'ignored-target-unfixable' && entry.path === 'CLAUDE.md'));
});

test('host tools that pick up Block Beaver working files are reported with narrow, opt-in tsconfig excludes', async (t) => {
  const original = '{\n  // owner comment\n  "compilerOptions": { "strict": true },\n  "include": ["src", ".blocks/**/*.ts"]\n}\n';
  const root = await repo(t, { 'tsconfig.json': original });
  const reported = await plan(root);
  assert.deepEqual(reported.files, []);
  const pickup = reported.diagnostics.filter((entry) => entry.code === 'host-pickup');
  assert.equal(pickup.length, 1);
  assert.equal(pickup[0].path, 'tsconfig.json');
  assert.deepEqual(pickup[0].paths, ['.blocks/worktrees', '.blocks/cache', '.blocks/view']);
  assert.match(pickup[0].remediation, /--fix-excludes/);

  const fixed = await plan(root, { fixExcludes: true });
  const edited = file(fixed, 'tsconfig.json');
  assert.equal(edited.kind, 'exclude');
  assert.ok(edited.content.includes('// owner comment'));
  assert.ok(edited.content.includes('"compilerOptions": { "strict": true }'));
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', edited.content);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.config.include, ['src', '.blocks/**/*.ts']);
  assert.deepEqual(parsed.config.exclude, ['node_modules', 'bower_components', 'jspm_packages', '.blocks/worktrees', '.blocks/cache', '.blocks/view'],
    'Creating an exclude keeps TypeScript’s default exclusions.');
  await apply(root, fixed);
  const settled = await plan(root, { fixExcludes: true });
  assert.deepEqual(settled.files, []);
  assert.equal(settled.diagnostics.filter((entry) => entry.code === 'host-pickup').length, 0);
});

test('tsconfig exclude edits preserve owner values, layout, outDir defaults, and unsupported inheritance', async (t) => {
  const inline = await repo(t, { 'tsconfig.json': '{ "include": [".blocks/**/*.ts"], "exclude": ["dist"] }\n' });
  const inlineParsed = ts.parseConfigFileTextToJson('x', file(await plan(inline, { fixExcludes: true }), 'tsconfig.json').content);
  assert.deepEqual(inlineParsed.config.exclude, ['dist', '.blocks/worktrees', '.blocks/cache', '.blocks/view']);

  const multi = await repo(t, { 'tsconfig.json': '{\n  "include": [".blocks/**/*.ts"],\n  "exclude": [\n    "dist", // keep\n    "coverage"\n  ]\n}\n' });
  const multiContent = file(await plan(multi, { fixExcludes: true }), 'tsconfig.json').content;
  assert.ok(multiContent.includes('"dist", // keep\n    "coverage",\n    ".blocks/worktrees",\n    ".blocks/cache",\n    ".blocks/view"\n  ]'));

  const outDir = await repo(t, { 'tsconfig.json': '{ "compilerOptions": { "outDir": "build" }, "include": [".blocks/view/**/*.ts"] }' });
  const outDirParsed = ts.parseConfigFileTextToJson('x', file(await plan(outDir, { fixExcludes: true }), 'tsconfig.json').content);
  assert.deepEqual(outDirParsed.config.exclude, ['node_modules', 'bower_components', 'jspm_packages', 'build', '.blocks/view']);

  const inherited = await repo(t, { 'base.json': '{ "exclude": ["dist"] }', 'tsconfig.json': '{ "extends": "./base.json", "include": [".blocks/**/*.ts"] }' });
  const inheritedPlan = await plan(inherited, { fixExcludes: true });
  assert.deepEqual(inheritedPlan.files, []);
  const unfixable = inheritedPlan.diagnostics.find((entry) => entry.code === 'host-pickup-unfixable');
  assert.equal(unfixable.path, 'tsconfig.json');
  assert.match(unfixable.message, /extends/);

  const broken = await repo(t, { 'tsconfig.json': '{ "include": ' });
  const brokenPlan = await plan(broken, { fixExcludes: true });
  assert.deepEqual(brokenPlan.files, []);
  assert.ok(codes(brokenPlan.diagnostics).includes('unsupported-host-config'));
});

test('default tsconfig include rules do not pick up dot directories, so nothing is reported', async (t) => {
  const root = await repo(t, { 'tsconfig.json': '{ "include": ["**/*", "."] }\n' });
  const result = await plan(root, { fixExcludes: true });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.diagnostics.filter((entry) => entry.code.startsWith('host-pickup')), []);
});

test('application tsconfig files from the config are checked with excludes relative to themselves', async (t) => {
  const root = await repo(t, { 'apps/web/tsconfig.json': '{ "include": ["../../.blocks/**/*.ts"] }\n' });
  const config = { apps: [{ id: 'web', root: 'apps/web', tsconfig: 'apps/web/tsconfig.json' }] };
  const result = await plan(root, { config, fixExcludes: true });
  const parsed = ts.parseConfigFileTextToJson('x', file(result, 'apps/web/tsconfig.json').content);
  assert.deepEqual(parsed.config.exclude.slice(-3), ['../../.blocks/worktrees', '../../.blocks/cache', '../../.blocks/view']);
});

test('line-based ignore files get a managed block and uninstall removes it', async (t) => {
  const root = await repo(t, { '.prettierrc': '{}\n', '.eslintrc.json': '{}\n', '.prettierignore': 'dist\n' });
  const reported = await plan(root);
  assert.deepEqual(reported.files, []);
  assert.deepEqual(reported.diagnostics.filter((entry) => entry.code === 'host-pickup').map((entry) => entry.tool).sort(), ['eslint', 'prettier']);

  const fixed = await plan(root, { fixExcludes: true });
  const block = '# block-beaver:start\n/.blocks/worktrees/\n/.blocks/cache/\n/.blocks/view/\n# block-beaver:end\n';
  assert.equal(withoutHashes(file(fixed, '.prettierignore').content), `dist\n${block}`);
  assert.equal(file(fixed, '.eslintignore').before, null);
  assert.equal(withoutHashes(file(fixed, '.eslintignore').content), block);
  assert.equal(file(fixed, '.prettierignore').kind, 'exclude');
  await apply(root, fixed);
  const settled = await plan(root, { fixExcludes: true });
  assert.deepEqual(settled.files, []);
  assert.equal(settled.diagnostics.filter((entry) => entry.code === 'host-pickup').length, 0);
  const removal = await plan(root, { operation: 'uninstall' });
  assert.equal(file(removal, '.prettierignore').content, 'dist\n');
  assert.equal(file(removal, '.eslintignore').content, null);

  const covered = await repo(t, { '.prettierrc': '{}\n', '.prettierignore': '/.blocks/\n' });
  assert.equal((await plan(covered)).diagnostics.filter((entry) => entry.code === 'host-pickup').length, 0);
  const partial = await repo(t, { '.prettierrc': '{}\n', '.prettierignore': '.blocks/worktrees\n!.blocks/worktrees/keep\n' });
  const partialPlan = await plan(partial);
  assert.deepEqual(partialPlan.diagnostics.find((entry) => entry.code === 'host-pickup').paths, ['.blocks/cache', '.blocks/view']);
});

test('jest json configuration is edited in place while script and unknown configurations are only reported', async (t) => {
  const root = await repo(t, { 'jest.config.json': '{\n  "preset": "ts-jest"\n}\n' });
  const reported = await plan(root);
  assert.equal(reported.diagnostics.filter((entry) => entry.code === 'host-pickup' && entry.tool === 'jest').length, 1);
  const fixed = file(await plan(root, { fixExcludes: true }), 'jest.config.json');
  assert.deepEqual(JSON.parse(fixed.content), { preset: 'ts-jest', modulePathIgnorePatterns: ['<rootDir>/\\.blocks/worktrees/', '<rootDir>/\\.blocks/cache/', '<rootDir>/\\.blocks/view/'] });
  for (const pattern of JSON.parse(fixed.content).modulePathIgnorePatterns) {
    const regex = new RegExp(pattern.replace('<rootDir>', root));
    assert.equal(regex.test(`${root}/xblocks/cache/index.test.ts`), false, 'The excludes cover only the actual Block Beaver directories.');
  }
  assert.ok(fixed.content.startsWith('{\n  "preset": "ts-jest",\n  "modulePathIgnorePatterns"'));
  await apply(root, await plan(root, { fixExcludes: true }));
  assert.deepEqual((await plan(root, { fixExcludes: true })).files, []);

  const covered = await repo(t, { 'jest.config.json': '{ "testPathIgnorePatterns": ["/node_modules/", "<rootDir>/\\\\.blocks/"] }' });
  assert.equal((await plan(covered)).diagnostics.filter((entry) => entry.tool === 'jest').length, 0);

  const scripts = await repo(t, { 'jest.config.js': 'export default {};\n', 'eslint.config.js': 'export default [];\n', 'vitest.config.ts': 'export default {};\n', 'biome.json': '{}\n', '.eslintrc.yml': 'root: true\n' });
  const scriptPlan = await plan(scripts, { fixExcludes: true });
  assert.deepEqual(scriptPlan.files, [], 'Unsupported parsers are never edited.');
  const unsupported = scriptPlan.diagnostics.filter((entry) => entry.code === 'unsupported-host-config');
  assert.deepEqual(unsupported.map((entry) => entry.path).sort(), ['.eslintrc.yml', 'biome.json', 'eslint.config.js', 'jest.config.js', 'vitest.config.ts']);
  assert.ok(unsupported.every((entry) => /manually/.test(entry.remediation) && entry.remediation.includes('.blocks/worktrees')));
  assert.equal(scriptPlan.diagnostics.filter((entry) => entry.code === 'host-pickup').length, 0, 'Unsupported tools are not claimed as covered or checked.');
});

test('a package.json jest key is edited with the same preserving rules', async (t) => {
  const root = await repo(t, { 'package.json': '{\n  "name": "app",\n  "jest": {\n    "preset": "ts-jest"\n  }\n}\n' });
  const fixed = file(await plan(root, { fixExcludes: true }), 'package.json');
  assert.deepEqual(JSON.parse(fixed.content), { name: 'app', jest: { preset: 'ts-jest', modulePathIgnorePatterns: ['<rootDir>/\\.blocks/worktrees/', '<rootDir>/\\.blocks/cache/', '<rootDir>/\\.blocks/view/'] } });
  assert.ok(fixed.content.startsWith('{\n  "name": "app",\n  "jest": {\n    "preset": "ts-jest",\n    "modulePathIgnorePatterns": ['));
  await apply(root, await plan(root, { fixExcludes: true }));
  assert.deepEqual((await plan(root, { fixExcludes: true })).files, []);
  const unrelated = await repo(t, { 'package.json': '{ "name": "app" }\n' });
  assert.deepEqual((await plan(unrelated, { fixExcludes: true })).files, []);
});

test('a worktrees directory outside the repository is honored and one inside is excluded and ignore-checked', async (t) => {
  const outside = await repo(t, { 'tsconfig.json': '{ "include": [".blocks/**/*.ts", "../.repo-block-beaver-worktrees/**/*.ts"] }\n' });
  const config = { worktrees: { dir: '../.repo-block-beaver-worktrees' } };
  const outsidePlan = await plan(outside, { config, fixExcludes: true });
  const parsed = ts.parseConfigFileTextToJson('x', file(outsidePlan, 'tsconfig.json').content);
  assert.deepEqual(parsed.config.exclude.slice(-2), ['.blocks/cache', '.blocks/view']);
  assert.ok(!parsed.config.exclude.includes('.blocks/worktrees'));
  assert.ok(codes(outsidePlan.diagnostics).includes('worktrees-outside-root'));

  const inside = await repo(t, { 'tsconfig.json': '{ "include": ["bb-trees/**/*.ts"] }\n' });
  const insidePlan = await plan(inside, { config: { worktrees: { dir: 'bb-trees' } }, fixExcludes: true });
  const insideParsed = ts.parseConfigFileTextToJson('x', file(insidePlan, 'tsconfig.json').content);
  assert.deepEqual(insideParsed.config.exclude.slice(-1), ['bb-trees']);
  assert.ok(insidePlan.diagnostics.some((entry) => entry.code === 'worktrees-not-ignored' && entry.path === 'bb-trees/'));
  const ignoredInside = await repo(t, { '.gitignore': '/bb-trees/\n' });
  assert.ok(!(await plan(ignoredInside, { config: { worktrees: { dir: 'bb-trees' } } })).diagnostics.some((entry) => entry.code === 'worktrees-not-ignored'));

  const invalid = await plan(await repo(t), { config: { worktrees: { dir: '.git/trees' } } });
  assert.ok(codes(invalid.diagnostics).includes('invalid-config'));
});

test('operations are pure: planning never writes, and unknown agents and non-Git directories are diagnosed', async (t) => {
  const root = await repo(t, { '.gitignore': '.claude/\n', 'tsconfig.json': '{ "include": [".blocks/**/*.ts"] }\n' });
  const before = await text(root, '.gitignore');
  await plan(root, { agents: ['claude'], fixIgnores: true, fixExcludes: true });
  assert.equal(await text(root, '.gitignore'), before);
  await assert.rejects(readFile(join(root, '.git/hooks/pre-commit')), { code: 'ENOENT' });

  const unknown = await plan(root, { agents: ['claude', 'vim'] });
  assert.ok(unknown.diagnostics.some((entry) => entry.code === 'unknown-agent' && /vim/.test(entry.message)));

  const plain = await mkdtemp(join(tmpdir(), 'block-beaver-host-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }));
  await writeFile(join(plain, 'lefthook.yml'), 'pre-commit:\n  commands:\n    a:\n      run: b\n');
  const plainPlan = await plan(plain, { agents: ['claude'] });
  assert.ok(codes(plainPlan.diagnostics).includes('git-unavailable'));
  assert.deepEqual(plainPlan.hooks, []);
  assert.ok(file(plainPlan, 'lefthook.yml'), 'Tracked hook-manager files can still be planned without Git.');
});

test('all managed host sections carry verified hashes, reject edits, and force preserves owner local sections', async (t) => {
  const local = '# block-beaver:local:start\n# owner local configuration\n# block-beaver:local:end\n';
  const cases = [
    { path: '.git/hooks/pre-commit', fixtures: {}, select: hook },
    { path: '.husky/pre-commit', fixtures: { '.husky/pre-commit': 'npm test\n' } },
    { path: 'lefthook.yml', fixtures: { 'lefthook.yml': 'pre-commit:\n  commands:\n    lint:\n      run: npm run lint\n' } },
    { path: '.github/workflows/block-beaver.yml', fixtures: { '.github/workflows/owner.yml': 'name: owner\n' } },
    { path: '.blocks/ci/gitlab.yml', fixtures: { '.gitlab-ci.yml': 'owner:\n  script: npm test\n' } },
    { path: '.gitlab-ci.yml', fixtures: { '.gitlab-ci.yml': 'owner:\n  script: npm test\n' } },
    { path: '.gitignore', fixtures: { '.gitignore': '.claude/\n' }, options: { agents: ['claude'], fixIgnores: true } },
    { path: '.prettierignore', fixtures: { '.prettierrc': '{}\n', '.prettierignore': 'dist\n' }, options: { fixExcludes: true } },
    { path: '.eslintignore', fixtures: { '.eslintrc.json': '{}\n' }, options: { fixExcludes: true } },
  ];
  for (const item of cases) {
    const root = await repo(t, item.fixtures);
    const installed = await plan(root, item.options);
    const entry = item.select ? item.select(installed) : file(installed, item.path);
    const region = entry.content.match(/^[ \t]*# block-beaver:start\n[\s\S]*?^[ \t]*# block-beaver:end\n/m)?.[0];
    assert.ok(region, item.path);
    const recorded = region.match(/# block-beaver:hash ([a-f0-9]{64})\n/)[1];
    assert.equal(recorded, createHash('sha256').update(withoutHashes(region)).digest('hex'), item.path);
    await apply(root, installed);
    await writeFile(join(root, item.path), entry.content + local);
    const next = await plan(root, { ...item.options, operation: 'upgrade', version: '0.4.0' });
    assert.deepEqual(next.conflicts, [], item.path);
    const nextEntry = item.select ? item.select(next) : file(next, item.path);
    if (nextEntry) assert.ok(nextEntry.content.endsWith(local), item.path);

    const edited = (entry.content + local).replace(/(^[ \t]*# block-beaver:end\n)/m, '# owner edit inside managed content\n$1');
    await writeFile(join(root, item.path), edited);
    const refused = await plan(root, { ...item.options, operation: 'upgrade', version: '0.4.0' });
    assert.ok(refused.conflicts.some((issue) => issue.path === item.path && issue.code === 'managed-edited'), item.path);
    const editConflict = refused.conflicts.find((issue) => issue.path === item.path && issue.code === 'managed-edited');
    assert.equal(editConflict.before, edited, item.path);
    assert.ok(!editConflict.expected.includes('# owner edit inside managed content'), `The conflict provides desired contents to review: ${item.path}`);
    assert.equal(item.select ? item.select(refused) : file(refused, item.path), undefined, item.path);
    assert.equal(await text(root, item.path), edited, 'Planning preserves edited bytes.');
    const forced = await plan(root, { ...item.options, operation: 'upgrade', version: '0.4.0', force: true });
    assert.deepEqual(forced.conflicts, [], item.path);
    const replaced = item.select ? item.select(forced) : file(forced, item.path);
    assert.ok(replaced.content.endsWith(local), item.path);
    assert.ok(!replaced.content.includes('# owner edit inside managed content'), item.path);
    await apply(root, forced);
    assert.deepEqual((await plan(root, { ...item.options, operation: 'upgrade', version: '0.4.0' })).conflicts, [], item.path);
  }
});

test('CI regenerates ignored view artifacts after dependency install and before audit for each package manager', async (t) => {
  for (const [manager, lock, local, dependencyInstall] of [
    ['npm', 'package-lock.json', 'npx --no-install block-beaver', 'npm ci'],
    ['pnpm', 'pnpm-lock.yaml', 'pnpm exec block-beaver', 'pnpm install --frozen-lockfile'],
    ['yarn', 'yarn.lock', 'yarn exec block-beaver', 'yarn install --frozen-lockfile'],
    ['bun', 'bun.lock', 'bunx --no-install block-beaver', 'bun install --frozen-lockfile'],
  ]) {
    const root = await repo(t, { [lock]: '', '.github/workflows/owner.yml': 'name: owner\n', '.gitlab-ci.yml': 'owner:\n  script: true\n' });
    const result = await plan(root);
    for (const path of ['.github/workflows/block-beaver.yml', '.blocks/ci/gitlab.yml']) {
      const ci = file(result, path).content;
      assert.ok(ci.includes(dependencyInstall) && ci.indexOf(`${local} update --root .`) > ci.indexOf(dependencyInstall), `${manager}: ${path}`);
      assert.ok(ci.indexOf(`${local} audit --base merge-base --strict --format summary`) > ci.indexOf(`${local} update --root .`), `${manager}: ${path}`);
    }
    assert.ok(hook(result).content.includes(`${local} audit --staged --format summary --root .`), manager);
    const huskyRoot = await repo(t, { [lock]: '', '.husky/pre-commit': 'echo owner\n' });
    assert.ok(file(await plan(huskyRoot), '.husky/pre-commit').content.includes(`${local} audit --staged --format summary --root .`), manager);
    const lefthookRoot = await repo(t, { [lock]: '', 'lefthook.yml': 'pre-commit:\n  commands:\n    lint:\n      run: echo owner\n' });
    assert.ok(file(await plan(lefthookRoot), 'lefthook.yml').content.includes(`run: ${local} audit --staged --format summary --root .`), manager);
  }
});

test('unverified and malformed hashes cannot authorize replacement of managed content', async (t) => {
  const root = await repo(t, { '.husky/pre-commit': '# block-beaver:start\necho owner\n# block-beaver:end\n' });
  const refused = await plan(root, { operation: 'upgrade' });
  assert.equal(file(refused, '.husky/pre-commit'), undefined);
  assert.deepEqual(codes(refused.conflicts), ['managed-edited']);
  const forced = await plan(root, { operation: 'upgrade', force: true });
  await apply(root, forced);
  const before = await text(root, '.husky/pre-commit');
  await writeFile(join(root, '.husky/pre-commit'), before.replace(/# block-beaver:hash [a-f0-9]+/, '# block-beaver:hash invalid'));
  assert.deepEqual(codes((await plan(root, { operation: 'upgrade' })).conflicts), ['managed-edited']);
  await apply(root, await plan(root, { operation: 'upgrade', force: true }));
  assert.equal(await text(root, '.husky/pre-commit'), before);
});

const ciFixtures = { '.github/workflows/owner.yml': 'name: owner\n', '.gitlab-ci.yml': 'owner:\n  script: true\n' };
const githubPath = '.github/workflows/block-beaver.yml';
const gitlabPath = '.blocks/ci/gitlab.yml';

test('managed CI uses the repository Node version: .nvmrc, .node-version, engines, then the default', async (t) => {
  const cases = [
    { name: '.nvmrc', files: { '.nvmrc': '24\n' }, yaml: 'node-version-file: .nvmrc', image: 'node:24' },
    { name: '.node-version', files: { '.node-version': '22.18.0\n' }, yaml: 'node-version-file: .node-version', image: 'node:22' },
    { name: 'engines', files: { 'package.json': JSON.stringify({ engines: { node: '24.x' } }) }, yaml: "node-version: '24.x'", image: 'node:24' },
    { name: 'nothing', files: {}, yaml: "node-version: '24'", image: 'node:24' },
    { name: 'nvmrc wins over node-version and engines', files: { '.nvmrc': 'v26.1.0\n', '.node-version': '22\n', 'package.json': JSON.stringify({ engines: { node: '>=22.18' } }) }, yaml: 'node-version-file: .nvmrc', image: 'node:26' },
    { name: 'node-version wins over engines', files: { '.node-version': '22.18.0\n', 'package.json': JSON.stringify({ engines: { node: '>=24' } }) }, yaml: 'node-version-file: .node-version', image: 'node:22' },
    { name: 'engines range with quotes', files: { 'package.json': JSON.stringify({ engines: { node: ">=22.18 <25 || '26'" } }) }, yaml: "node-version: '>=22.18 <25 || ''26'''", image: 'node:22' },
    { name: 'alias without a major', files: { '.nvmrc': 'lts/*\n' }, yaml: 'node-version-file: .nvmrc', image: 'node:24' },
    { name: 'blank version file falls through', files: { '.nvmrc': '\n', 'package.json': JSON.stringify({ engines: { node: '26.x' } }) }, yaml: "node-version: '26.x'", image: 'node:26' },
  ];
  for (const item of cases) {
    const root = await repo(t, { ...ciFixtures, ...item.files });
    const result = await plan(root);
    const workflow = file(result, githubPath).content;
    assert.ok(workflow.includes(`      - uses: actions/setup-node@v7\n        with:\n          ${item.yaml}\n`), `${item.name}: ${workflow}`);
    assert.ok(workflow.includes('      - uses: actions/checkout@v7\n'), item.name);
    assert.ok(!workflow.includes('@v4'), item.name);
    assert.ok(file(result, gitlabPath).content.includes(`\n  image: ${item.image}\n`), `${item.name}: ${file(result, gitlabPath).content}`);
    assert.deepEqual(result.diagnostics.filter((entry) => entry.code === 'ci-node-below-minimum'), [], item.name);
  }
});

test('managed CI keeps the Bun setup action unchanged and settles after install', async (t) => {
  const bun = await repo(t, { ...ciFixtures, 'bun.lock': '{}' });
  assert.ok(file(await plan(bun), githubPath).content.includes('      - uses: oven-sh/setup-bun@v2\n'));
  const root = await repo(t, { ...ciFixtures, '.nvmrc': '24\n', 'package-lock.json': '{}' });
  await apply(root, await plan(root));
  const settled = await plan(root, { operation: 'upgrade', force: true });
  assert.deepEqual(settled.files, [], 'The audit managed-current rule plans an upgrade and finds nothing to change.');
  assert.deepEqual(settled.conflicts, []);
});

test('a repository Node version below the Block Beaver minimum is reported but still planned', async (t) => {
  for (const files of [{ '.nvmrc': '20\n' }, { 'package.json': JSON.stringify({ engines: { node: '>=18' } }) }]) {
    const root = await repo(t, { ...ciFixtures, ...files });
    const result = await plan(root);
    const warnings = result.diagnostics.filter((entry) => entry.code === 'ci-node-below-minimum');
    assert.equal(warnings.length, 1, 'One warning even though both GitHub and GitLab are planned.');
    assert.equal(warnings[0].severity, 'warning');
    assert.match(warnings[0].message, /22\.18/);
    assert.ok(file(result, githubPath));
  }
  const supported = await repo(t, { ...ciFixtures, '.nvmrc': '22.18.0\n' });
  assert.deepEqual((await plan(supported)).diagnostics.filter((entry) => entry.code === 'ci-node-below-minimum'), []);
  const removal = await plan(await repo(t, { ...ciFixtures, '.nvmrc': '18\n' }), { operation: 'uninstall' });
  assert.deepEqual(removal.diagnostics.filter((entry) => entry.code === 'ci-node-below-minimum'), []);
});

const legacyWorkflow = (nodeLine = 'node-version: 22') => `# block-beaver:managed-ci
name: Block Beaver audit
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
jobs:
  block-beaver-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          ${nodeLine}
      - run: npm ci
      - name: Fetch the pull request base
        env:
          BASE_REF: \${{ github.base_ref }}
        run: git fetch --no-tags origin "+refs/heads/\${BASE_REF}:refs/remotes/origin/\${BASE_REF}"
      - name: Audit against the merge base
        env:
          BLOCK_BEAVER_BASE_REF: origin/\${{ github.base_ref }}
        run: npx --no-install block-beaver audit --base merge-base --strict
`;
const legacyGitlab = '# block-beaver:managed-ci\nblock_beaver_audit:\n  image: node:22\n  stage: .pre\n  variables:\n    GIT_DEPTH: \'0\'\n  rules:\n    - if: \'$CI_PIPELINE_SOURCE == "merge_request_event"\'\n  script:\n    - npm ci\n    - git fetch --no-tags origin "+refs/heads/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME:refs/remotes/origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"\n    - BLOCK_BEAVER_BASE_REF="origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" npx --no-install block-beaver audit --base merge-base --strict\n';

test('unmarked 0.1.x and 0.4.0 CI files with the old v4 and node 22 bytes are still adopted, even in a repository that pins another Node', async (t) => {
  for (const pinned of [{}, { '.nvmrc': '26\n' }]) {
    const root = await repo(t, { ...pinned, 'package-lock.json': '{}', '.github/workflows/block-beaver.yml': legacyWorkflow(), '.gitlab-ci.yml': 'owner:\n  script: true\n', '.blocks/ci/gitlab.yml': legacyGitlab });
    const result = await plan(root, { operation: 'upgrade', version: '0.5.0' });
    assert.deepEqual(result.conflicts, [], JSON.stringify(pinned));
    const workflow = file(result, githubPath);
    assert.equal(workflow.before, legacyWorkflow());
    assert.ok(workflow.content.includes('actions/checkout@v7') && workflow.content.includes('actions/setup-node@v7'));
    assert.ok(workflow.content.includes('# block-beaver:version 0.5.0\n'));
    assert.ok(file(result, gitlabPath).content.includes(`  image: node:${pinned['.nvmrc'] ? '26' : '24'}\n`));
    await apply(root, result);
    assert.deepEqual((await plan(root, { operation: 'upgrade', version: '0.5.0' })).files, []);
  }
  const quoted = await repo(t, { 'package-lock.json': '{}', '.github/workflows/block-beaver.yml': legacyWorkflow("node-version: '22'") });
  assert.deepEqual(codes((await plan(quoted, { operation: 'upgrade' })).conflicts), ['managed-edited'], 'Only the exact old bytes are adopted.');
});

test('a hashed 0.4.0 CI region upgrades cleanly to the current actions and Node setup', async (t) => {
  const body = legacyWorkflow().replace('# block-beaver:managed-ci\n', '# block-beaver:start\n# block-beaver:version 0.4.0\n')
    .replace('      - name: Audit against', '      - name: Regenerate the block view\n        run: npx --no-install block-beaver update --root .\n      - name: Audit against') + '# block-beaver:end\n';
  const [first, ...rest] = body.split('\n');
  const stamped = `# block-beaver:managed-ci\n${first}\n# block-beaver:hash ${createHash('sha256').update(body).digest('hex')}\n${rest.join('\n')}`;
  const root = await repo(t, { '.nvmrc': '24\n', 'package-lock.json': '{}', '.github/workflows/block-beaver.yml': stamped });
  const result = await plan(root, { operation: 'upgrade', version: '0.5.0' });
  assert.deepEqual(result.conflicts, []);
  const upgraded = file(result, githubPath).content;
  assert.ok(upgraded.includes('actions/checkout@v7') && upgraded.includes('actions/setup-node@v7\n        with:\n          node-version-file: .nvmrc\n'));
  assert.ok(!upgraded.includes('@v4') && !upgraded.includes('node-version: 22'));
  await apply(root, result);
  assert.deepEqual((await plan(root, { operation: 'upgrade', version: '0.5.0' })).files, []);
});
