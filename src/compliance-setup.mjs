import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { changedPaths, git, gitHead, sha256, versionBytes } from './compliance-git.mjs';
import { recordException } from './compliance.mjs';
import { readProjectFile, writeProjectFiles } from './project-files.mjs';
import { remoteProvider } from './git-remote.mjs';
import { DEFAULT_CI_NODE, nodeSetupFrom } from './install-host.mjs';

const marker = '# block-beaver:managed-ci';
const begin = '# block-beaver:start';
const end = '# block-beaver:end';

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function managedFile(root, path, content) {
  const before = await readProjectFile(root, path);
  if (before !== null && !before.startsWith(`${marker}\n`)) throw new Error(`Existing CI file is not Block Beaver managed: ${path}`);
  return await writeProjectFiles(root, [{ path, before, content }]);
}

async function sourceInstallSpec() {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return { version, spec: `block-beaver@${version}` };
}

async function ciNode(root) {
  const optional = async (path) => { try { return await readProjectFile(root, path); } catch { return null; } };
  let engines = null;
  try { engines = JSON.parse(await optional('package.json') ?? 'null')?.engines?.node ?? null; } catch { /* no usable manifest */ }
  return nodeSetupFrom({ nvmrc: await optional('.nvmrc'), nodeVersion: await optional('.node-version'), engines });
}

function githubWorkflow(spec, node) {
  return `${marker}\nname: Block Beaver compliance\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\npermissions:\n  contents: read\njobs:\n  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          fetch-depth: 0\n      - uses: actions/setup-node@v7\n        with:\n          ${node.yaml}\n      - run: npm install --no-save --ignore-scripts '${spec}'\n      - run: npx --no-install block-beaver audit --root . --base "\u0024{{ github.event.pull_request.base.sha }}"\n`;
}

function gitlabJob(spec, node) {
  return `${marker}\nblock_beaver_audit:\n  image: node:${node.image ?? DEFAULT_CI_NODE}\n  stage: .pre\n  variables:\n    GIT_DEPTH: '0'\n  script:\n    - npm install --no-save --ignore-scripts '${spec}'\n    - npx --no-install block-beaver audit --root . --base "$CI_MERGE_REQUEST_DIFF_BASE_SHA"\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'\n`;
}

async function installGitlab(root, spec, node) {
  const job = '.blocks/ci/gitlab.yml';
  const beforeJob = await readProjectFile(root, job);
  if (beforeJob !== null && !beforeJob.startsWith(`${marker}\n`)) throw new Error(`Existing CI file is not Block Beaver managed: ${job}`);
  const config = '.gitlab-ci.yml';
  const before = await readProjectFile(root, config);
  let content;
  const section = `${begin}\ninclude:\n  - local: .blocks/ci/gitlab.yml\n${end}`;
  if (before === null) content = `${section}\n`;
  else if (before.includes(begin) || before.includes(end)) {
    if (before.split(begin).length !== 2 || before.split(end).length !== 2 || before.indexOf(begin) > before.indexOf(end)) throw new Error('Ambiguous managed section in .gitlab-ci.yml.');
    content = before.slice(0, before.indexOf(begin)) + section + before.slice(before.indexOf(end) + end.length);
  } else {
    if (/^include\s*:/m.test(before)) throw new Error('Existing GitLab include needs manual integration; CI gate is incomplete.');
    content = before + (before.endsWith('\n') ? '\n' : '\n\n') + section + '\n';
  }
  return await writeProjectFiles(root, [{ path: job, before: beforeJob, content: gitlabJob(spec, node) }, { path: config, before, content }]);
}

async function installHook(root) {
  let configured;
  try { configured = (await git(root, ['config', '--get', 'core.hooksPath'])).trim(); }
  catch (error) { if (error.code !== 1) throw error; }
  if (configured) return { status: 'incomplete', reason: 'A custom core.hooksPath is configured; its existing hooks were preserved.' };
  const raw = (await git(root, ['rev-parse', '--git-path', 'hooks'])).trim();
  const hooks = isAbsolute(raw) ? raw : resolve(root, raw);
  if (await exists(hooks) && (await lstat(hooks)).isSymbolicLink()) return { status: 'incomplete', reason: 'Git hooks directory is a symlink.' };
  const file = join(hooks, 'pre-commit');
  await mkdir(hooks, { recursive: true });
  let before = null, originalInfo = null, existing = false;
  try {
    const entry = await lstat(file);
    existing = true;
    if (!entry.isFile() || entry.nlink !== 1 || entry.isSymbolicLink()) return { status: 'incomplete', reason: 'Existing pre-commit hook is not an independent regular file.' };
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.dev !== entry.dev || info.ino !== entry.ino) throw new Error('Pre-commit hook changed file identity during setup.');
      before = await handle.readFile('utf8');
      const after = await lstat(file);
      if (!after.isFile() || after.nlink !== 1 || after.dev !== info.dev || after.ino !== info.ino) throw new Error('Pre-commit hook changed file identity during setup.');
      originalInfo = info;
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT' || existing) throw error; }
  const section = `${begin}\nif ! command -v block-beaver >/dev/null 2>&1; then\n  echo 'Block Beaver is required for this commit. Install it, then retry.' >&2\n  exit 1\nfi\nblock-beaver audit --staged --root . || exit $?\n${end}\n`;
  let content;
  if (before === null) content = `#!/bin/sh\n${section}`;
  else {
    if (!/^#![^\n]*(?:\/sh|\/bash)(?:\s|$)/.test(before)) return { status: 'incomplete', reason: 'Existing pre-commit hook is not a shell script.' };
    if (before.includes(begin) || before.includes(end)) {
      if (before.split(begin).length !== 2 || before.split(end).length !== 2 || before.indexOf(begin) > before.indexOf(end)) return { status: 'incomplete', reason: 'Existing hook has ambiguous Block Beaver markers.' };
      content = before.slice(0, before.indexOf(begin)) + section + before.slice(before.indexOf(end) + end.length).replace(/^\n/, '');
    } else {
      const firstLine = before.indexOf('\n');
      content = before.slice(0, firstLine + 1) + section + before.slice(firstLine + 1);
    }
  }
  const flags = before === null ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW : constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(file, flags, 0o755);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Pre-commit hook changed file type during setup.');
    if (originalInfo && (info.dev !== originalInfo.dev || info.ino !== originalInfo.ino)) throw new Error('Pre-commit hook changed file identity during setup.');
    if (before !== null && await handle.readFile('utf8') !== before) throw new Error('Pre-commit hook changed during setup.');
    if (content !== before) {
      const bytes = Buffer.from(content);
      let offset = 0;
      while (offset < bytes.length) offset += (await handle.write(bytes, offset, bytes.length - offset, offset)).bytesWritten;
      await handle.truncate(bytes.length);
    }
    await handle.chmod(0o755);
  } finally { await handle.close(); }
  return { status: 'installed', path: file, changed: content !== before };
}

async function providers(root) {
  let origin = '';
  try { origin = (await git(root, ['remote', 'get-url', 'origin'])).trim(); }
  catch (error) { if (error.code !== 2 && error.code !== 128) throw error; }
  const github = remoteProvider(origin) === 'github' || await exists(join(root, '.github', 'workflows'));
  const gitlab = remoteProvider(origin) === 'gitlab' || await exists(join(root, '.gitlab-ci.yml'));
  return { github, gitlab };
}

export async function installCompliance(root, integrationChanged = []) {
  let top;
  try { top = (await git(root, ['rev-parse', '--show-toplevel'])).trim(); await gitHead(root); }
  catch { return { status: 'incomplete', reason: 'A Git checkout with a committed base is required for enforcement.' }; }
  if (await realpath(top) !== await realpath(root)) return { status: 'incomplete', reason: 'Run setup from the Git checkout root for enforcement.' };
  let hook;
  try { hook = await installHook(root); }
  catch (error) { hook = { status: 'incomplete', reason: error.message }; }
  const ci = {};
  const detected = await providers(root);
  let spec;
  try { spec = (await sourceInstallSpec()).spec; }
  catch (error) { ci.status = 'incomplete'; ci.reason = `Cannot resolve Block Beaver source commit: ${error.message}`; }
  if (spec) {
    const node = await ciNode(root);
    if (detected.github) {
      try { ci.github = { status: 'installed', changed: await managedFile(root, '.github/workflows/block-beaver.yml', githubWorkflow(spec, node)) }; }
      catch (error) { ci.github = { status: 'incomplete', reason: error.message }; }
    }
    if (detected.gitlab) {
      try { ci.gitlab = { status: 'installed', changed: await installGitlab(root, spec, node) }; }
      catch (error) { ci.gitlab = { status: 'incomplete', reason: error.message }; }
    }
    if (!detected.github && !detected.gitlab) ci.status = 'incomplete', ci.reason = 'No GitHub or GitLab project was detected. Use block-beaver audit in your CI.';
  }
  const changed = [...integrationChanged, ...(ci.github?.changed || []), ...(ci.gitlab?.changed || [])];
  let exception = null;
  if (changed.length) {
    try {
      const current = new Set((await changedPaths(root, 'working')).map((entry) => entry.path));
      const eligible = [...new Set(changed)].filter((path) => current.has(path) && !path.startsWith('.blocks/view/'));
      if (eligible.length) {
        const signature = [];
        for (const path of eligible.sort()) signature.push([path, sha256(await versionBytes(root, path, 'working'))]);
        const suffix = createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 12);
        exception = await recordException(root, `block-beaver-setup-${suffix}`, { reason: 'Block Beaver managed project integration', paths: eligible, managed: true });
      }
    } catch (error) { exception = { status: 'incomplete', reason: error.message }; }
  }
  const complete = hook.status === 'installed' && Object.values(ci).every((value) => typeof value !== 'object' || value.status === 'installed') && !ci.reason && exception?.status !== 'incomplete';
  return { status: complete ? 'installed' : 'incomplete', hook, ci, exception, installSpec: spec || null,
    mergeGate: { status: 'unverified', reason: 'Require the Block Beaver audit job in GitHub or GitLab branch rules to prevent an unchecked merge.' } };
}
