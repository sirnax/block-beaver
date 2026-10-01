import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import ts from 'typescript';
import { readProjectFile } from './project-files.mjs';
import { localBlockBeaverCommand } from './package-manager.mjs';
import { remoteProvider } from './git-remote.mjs';

/**
 * Host setup planning for install, upgrade and uninstall. Nothing here writes: callers apply
 * `files` through the safe project writer and `hooks` (Git hook files, often outside the
 * project writer's reach) themselves.
 *
 * planHostSetup(root, { config, agents, fixIgnores, fixExcludes, operation, version, force }) resolves to
 *   files:       [{ path, before, content, kind, mode? }]  repository-relative; content null deletes;
 *                kind is 'hook' | 'ci' | 'gitignore' | 'exclude'; mode (0o755) is set on new executable files
 *   hooks:       [{ path, absolutePath, before, content, mode, kind: 'hook' }]  bare Git hook files; path is
 *                repository-relative when inside the checkout, otherwise absolute
 *   diagnostics: [{ code, severity, message, path?, remediation?, ... }]  problems the owner should know about
 *   conflicts:   [{ code, path, message, remediation? }]  owner files Block Beaver refuses to change
 * Only changed files appear, so a settled repository plans no changes.
 */

const begin = '# block-beaver:start';
const end = '# block-beaver:end';
const ciMarker = '# block-beaver:managed-ci';
const auditStaged = 'npx --no-install block-beaver audit --staged --root .';
const auditRange = 'npx --no-install block-beaver audit --base merge-base --strict';
const workflowPath = '.github/workflows/block-beaver.yml';
const gitlabJobPath = '.blocks/ci/gitlab.yml';
const gitlabConfigPath = '.gitlab-ci.yml';
const shellSection = `${begin}\n${auditStaged} || exit $?\n${end}\n`;
const shellShebang = /^#!\s*(?:\S*\/)?(?:env\s+(?:-S\s+)?)?(?:ba|da|a|k|z)?sh(?:\s|$)/;
const huskySource = /^\.\s+\S.*\/husky\.sh["']?\s*$/;
const lefthookSupported = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml'];
const lefthookUnsupported = ['lefthook.json', '.lefthook.json', 'lefthook.toml', '.lefthook.toml'];
const lockfiles = [['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']];
const fixablePrefixes = ['.claude/', '.agents/', '.codex/'];
const agentTargets = {
  claude: [{ path: 'CLAUDE.md' }, { path: '.claude/settings.json' }, { path: '.claude/skills/block-beaver/', dir: true, probe: 'SKILL.md' }],
  codex: [{ path: 'AGENTS.md' }, { path: '.codex/hooks.json' }, { path: '.agents/skills/block-beaver/', dir: true, probe: 'SKILL.md' }],
  cursor: [{ path: '.cursor/rules/block-beaver.mdc' }],
  copilot: [{ path: '.github/copilot-instructions.md' }],
};
const unsupportedTools = {
  eslint: ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml'],
  jest: ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'jest.config.cts'],
  vitest: ['vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs', 'vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts', 'vitest.workspace.js', 'vitest.workspace.ts'],
  biome: ['biome.json', 'biome.jsonc'],
};
const prettierConfigs = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.json5', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts', '.prettierignore'];

const slash = (path) => path.replaceAll('\\', '/');
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const unique = (list) => [...new Set(list)];
const escapeRegex = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

function git(root, args, input = '') {
  return new Promise((done) => {
    const child = execFile('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      done({ code: error ? (Number.isInteger(error.code) ? error.code : -1) : 0, stdout: stdout || '' });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function entryAt(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}
const exists = async (ctx, path) => Boolean(await entryAt(join(ctx.root, path)));
async function isDirectory(ctx, path) { return (await entryAt(join(ctx.root, path)))?.isDirectory() === true; }

function diagnose(ctx, code, severity, message, extra = {}) { ctx.diagnostics.push({ code, severity, message, ...extra }); }
function conflict(ctx, code, path, message, remediation, extra = {}) {
  const previous = ctx.conflicts.find((entry) => entry.code === code && entry.path === path);
  if (previous) { Object.assign(previous, extra); return; }
  ctx.conflicts.push({ code, path, message, ...(remediation ? { remediation } : {}), ...extra });
}
function addFile(ctx, file) {
  if (!protectRegion(ctx, file.path, file.before, file.content)) return;
  if (file.content !== null) file = { ...file, content: stampRegion(file.content) };
  if (file.content === file.before || ctx.files.has(file.path)) return;
  const { mode, ...rest } = file;
  ctx.files.set(file.path, mode ? { ...rest, mode } : rest);
}

/** Read through the safe project reader; refusal becomes a conflict instead of a crash. */
async function safeRead(ctx, path) {
  try {
    const before = await readProjectFile(ctx.root, path);
    const region = before === null ? null : findRegion(before);
    // Diagnose immediately, but keep reading so the planner can attach the real desired
    // contents to the conflict. The installer preflights all conflicts before any write.
    if (region && !region.ambiguous && hasHash(region.text)) protectRegion(ctx, path, before, before);
    return { before };
  }
  catch (error) {
    conflict(ctx, 'unsafe-path', path, error.message, 'Replace the symlink or shared file with an independent regular file, then rerun.');
    return null;
  }
}

// ---- marked regions -------------------------------------------------------------------------

function findRegion(text) {
  let offset = 0;
  const starts = [], stops = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === begin) starts.push({ at: offset, indent: line.length - line.trimStart().length });
    else if (trimmed === end) stops.push({ at: Math.min(offset + line.length + 1, text.length) });
    offset += line.length + 1;
  }
  if (!starts.length && !stops.length) return null;
  if (starts.length !== 1 || stops.length !== 1 || starts[0].at >= stops[0].at) return { ambiguous: true };
  return { start: starts[0].at, stop: stops[0].at, indent: starts[0].indent, text: text.slice(starts[0].at, stops[0].at) };
}
const replaceRegion = (text, region, replacement) => text.slice(0, region.start) + replacement + text.slice(region.stop);
const withoutRegion = (text, region) => replaceRegion(text, region, '');
const appendBlock = (before, block) => (before ? (before.endsWith('\n') ? before : `${before}\n`) : '') + block;

// Hash the entire managed region, excluding only its hash line. Surrounding instructions and
// optional block-beaver:local:start/end sections remain outside this region and are never edited.
const hashLine = /^[ \t]*# block-beaver:hash ([a-f0-9]{64})\r?\n/gm;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const withoutHash = (text) => text.replace(/^[ \t]*# block-beaver:hash(?:[^\n]*)\r?\n/gm, '');
const hasHash = (text) => /^[ \t]*# block-beaver:hash(?:\s|$)/m.test(text);

function stampRegion(text) {
  const region = findRegion(text);
  if (!region || region.ambiguous) return text;
  const body = withoutHash(region.text);
  const firstEnd = body.indexOf('\n') + 1;
  const block = body.slice(0, firstEnd) + `${' '.repeat(region.indent)}# block-beaver:hash ${digest(body)}\n` + body.slice(firstEnd);
  return replaceRegion(text, region, block);
}

function knownLegacyRegion(ctx, path, region, after) {
  const desired = after === null ? null : findRegion(after);
  if (desired && !desired.ambiguous && withoutHash(region.text) === withoutHash(desired.text)) return true;
  if (path.endsWith('/pre-commit')) return region.text === shellSection;
  if (lefthookSupported.includes(path)) {
    const lines = region.text.trimEnd().split('\n');
    const variant = lines[1]?.trim() === 'pre-commit:' ? 'a' : lines[1]?.trim() === 'commands:' ? 'b' : 'c';
    const command = lines.find((line) => line.trim() === 'block-beaver:');
    const run = lines.find((line) => line.trim() === `run: ${auditStaged}`);
    const step = command && run ? indentOf(run) - indentOf(command) : 2;
    return region.text === `${lefthookBlock(variant, region.indent, step).join('\n')}\n`;
  }
  if (path === gitlabConfigPath) return region.text === `${begin}\ninclude:\n  - local: ${gitlabJobPath}\n${end}\n`;
  if (['.prettierignore', '.eslintignore'].includes(path)) return region.text === `${begin}\n${ctx.work.dirs.map((dir) => `/${dir.path}/`).join('\n')}\n${end}\n`;
  return false;
}

function protectRegion(ctx, path, before, after) {
  const region = before === null ? null : findRegion(before);
  if (!region || region.ambiguous || ctx.force) return true;
  const hashes = [...region.text.matchAll(hashLine)];
  const valid = hasHash(region.text)
    ? hashes.length === 1 && (region.text.match(/^[ \t]*# block-beaver:hash(?:\s|$)/gm) || []).length === 1 && digest(withoutHash(region.text)) === hashes[0][1]
    : knownLegacyRegion(ctx, path, region, after);
  if (valid) return true;
  conflict(ctx, 'managed-edited', path, `Owner edits or unverified content inside the managed section in ${path}; existing content was preserved.`,
    'Review the managed-section diff and rerun with --force to replace only the managed part.', { before, expected: after });
  return false;
}

// ---- Git ------------------------------------------------------------------------------------

async function inspectGit(root) {
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { ok: false, reason: 'is not inside a Git checkout, or Git is unavailable' };
  let same = false;
  try { same = await realpath(top.stdout.trim()) === root; } catch { /* treated as a different root */ }
  if (!same) return { ok: false, reason: 'is not the Git checkout root' };
  const [hooks, configured, remote] = await Promise.all([
    git(root, ['rev-parse', '--git-path', 'hooks']), git(root, ['config', '--get', 'core.hooksPath']), git(root, ['remote', 'get-url', 'origin'])]);
  const raw = hooks.stdout.trim();
  return { ok: true, hooksDir: raw ? (isAbsolute(raw) ? raw : resolve(root, raw)) : join(root, '.git', 'hooks'),
    hooksPath: configured.code === 0 ? configured.stdout.trim() : '', origin: remote.code === 0 ? remote.stdout.trim() : '' };
}

async function checkIgnore(ctx, paths) {
  const result = await git(ctx.root, ['check-ignore', '-z', '-v', '-n', '--stdin'], `${paths.join('\0')}\0`);
  if (result.code > 1) return null;
  const fields = result.stdout.split('\0');
  fields.pop();
  const answers = new Map();
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [source, line, pattern, path] = fields.slice(index, index + 4);
    answers.set(path, { ignored: source !== '' && !pattern.startsWith('!'), source: `${source}:${line}:${pattern}`, file: source, pattern });
  }
  return answers;
}

// ---- shell hooks (bare Git hook, Husky, in-repository hooksPath) ------------------------------

function splitHead(text) {
  const lines = text.split('\n');
  let count = lines[0].startsWith('#!') ? 1 : 0;
  while (count < lines.length && huskySource.test(lines[count])) count++;
  return { head: count ? `${lines.slice(0, count).join('\n')}\n` : '', rest: lines.slice(count).join('\n') };
}

function planShell(before, { bare, audit = auditStaged }) {
  const section = `${begin}\n${audit} || exit $?\n${end}\n`;
  if (before === null || before.trim() === '') return { content: bare ? `#!/bin/sh\n${section}` : section };
  const region = findRegion(before);
  if (region?.ambiguous) return { problem: ['ambiguous-markers', 'The hook has unbalanced or repeated Block Beaver markers.', 'Remove the stray block-beaver:start/end lines, then rerun.'] };
  if (region) return { content: replaceRegion(before, region, section) };
  const first = before.split('\n')[0];
  if (first.startsWith('#!') ? !shellShebang.test(first) : bare) {
    return { problem: ['unsupported-hook', 'The existing pre-commit hook is not a shell script, so Block Beaver cannot chain into it.', `Call "${audit}" from that hook yourself.`] };
  }
  const { head, rest } = splitHead(before);
  return { content: head + section + rest };
}

function removeShell(before) {
  const region = findRegion(before);
  if (!region) return { content: before };
  if (region.ambiguous) return { problem: ['ambiguous-markers', 'The hook has unbalanced or repeated Block Beaver markers.', 'Remove the stray block-beaver:start/end lines by hand.'] };
  const remaining = withoutRegion(before, region);
  return { content: splitHead(remaining).rest.trim() === '' ? null : remaining };
}

async function planProjectShell(ctx, path, { uninstall, bare = false, kind = 'hook' }) {
  const read = await safeRead(ctx, path);
  if (!read || (uninstall && read.before === null)) return;
  const result = uninstall ? removeShell(read.before) : planShell(read.before, { bare, audit: ctx.auditStaged });
  if (result.problem) return conflict(ctx, result.problem[0], path, result.problem[1], result.problem[2]);
  addFile(ctx, { path, before: read.before, content: result.content, kind, mode: read.before === null ? 0o755 : undefined });
}

async function readGitHook(file) {
  const dir = await entryAt(dirname(file));
  if (dir?.isSymbolicLink()) return { problem: 'The Git hooks directory is a symlink.' };
  const entry = dir ? await entryAt(file) : null;
  if (!entry) return { before: null };
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return { problem: 'The existing pre-commit hook is not an independent regular file.' };
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    return { before: await handle.readFile('utf8') };
  } catch (error) { return { problem: `The existing pre-commit hook cannot be read: ${error.message}` }; }
  finally { await handle?.close(); }
}

async function planBareHook(ctx, uninstall) {
  const { hooksDir } = ctx.git;
  const rel = slash(relative(ctx.root, hooksDir));
  const inside = rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  const underGit = inside && (rel === '.git' || rel.startsWith('.git/'));
  if (ctx.git.hooksPath && !underGit) {
    if (!inside) {
      if (!uninstall) conflict(ctx, 'unsupported-hook', hooksDir, 'core.hooksPath points outside this repository, so its hooks are not managed here.', `Call "${ctx.auditStaged}" from your hooks yourself.`);
      return;
    }
    return planProjectShell(ctx, `${rel}/pre-commit`, { uninstall, bare: true });
  }
  const absolutePath = join(hooksDir, 'pre-commit');
  const path = inside ? `${rel}/pre-commit` : absolutePath;
  const read = await readGitHook(absolutePath);
  if (read.problem) { if (!uninstall) conflict(ctx, 'unsupported-hook', path, read.problem, `Call "${ctx.auditStaged}" from that hook yourself.`); return; }
  if (uninstall && read.before === null) return;
  const result = uninstall ? removeShell(read.before) : planShell(read.before, { bare: true, audit: ctx.auditStaged });
  if (result.problem) return conflict(ctx, result.problem[0], path, result.problem[1], result.problem[2]);
  if (!protectRegion(ctx, path, read.before, result.content)) return;
  const content = result.content === null ? null : stampRegion(result.content);
  if (content !== read.before) ctx.hooks.push({ path, absolutePath, before: read.before, content, mode: 0o755, kind: 'hook' });
}

// ---- lefthook ---------------------------------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length;
const meaningful = (line) => line.trim() !== '' && !line.trim().startsWith('#');

function lefthookBlock(variant, indent, step, audit = auditStaged) {
  const pad = ' '.repeat(indent), unit = ' '.repeat(step);
  const run = `run: ${audit}`;
  if (variant === 'a') return [begin, 'pre-commit:', '  commands:', '    block-beaver:', `      ${run}`, end];
  if (variant === 'b') return [`${pad}${begin}`, `${pad}commands:`, `${pad}${unit}block-beaver:`, `${pad}${unit}${unit}${run}`, `${pad}${end}`];
  return [`${pad}${begin}`, `${pad}block-beaver:`, `${pad}${unit}${run}`, `${pad}${end}`];
}

function planLefthook(before, audit = auditStaged) {
  const problem = (code, message, remediation) => ({ problem: [code, message, remediation] });
  const manual = `Add a pre-commit command running "${audit}" to your lefthook configuration yourself.`;
  if (before === null || before.trim() === '') return { content: `${lefthookBlock('a', 0, 2, audit).join('\n')}\n` };
  if (/^ *\t/m.test(before)) return problem('unsupported-hook', 'The lefthook configuration indents with tabs, which Block Beaver does not edit.', manual);
  const region = findRegion(before);
  if (region?.ambiguous) return problem('ambiguous-markers', 'The lefthook configuration has unbalanced or repeated Block Beaver markers.', 'Remove the stray block-beaver:start/end lines, then rerun.');
  if (region) {
    const lines = withoutHash(region.text).trimEnd().split('\n');
    const variant = region.indent === 0 ? 'a' : lines.some((line) => line.trim() === 'commands:') ? 'b' : 'c';
    const command = lines.find((line) => line.trim() === 'block-beaver:');
    const run = lines.find((line) => line.trim().startsWith('run:'));
    const step = command && run && indentOf(run) > indentOf(command) ? indentOf(run) - indentOf(command) : 2;
    return { content: replaceRegion(before, region, `${lefthookBlock(variant, region.indent, step, audit).join('\n')}\n`) };
  }
  const lines = before.split('\n');
  const tops = lines.map((line, index) => (/^["']?pre-commit["']?\s*:/.test(line) ? index : -1)).filter((index) => index >= 0);
  const finish = (at, block) => {
    lines.splice(at + 1, 0, ...block);
    if (lines.at(-1) !== '') lines.push('');
    return { content: lines.join('\n') };
  };
  if (tops.length > 1) return problem('unsupported-hook', 'The lefthook configuration defines pre-commit more than once.', manual);
  if (!tops.length) {
    if (lines.at(-1) === '') lines.pop();
    return finish(lines.length - 1, lefthookBlock('a', 0, 2, audit));
  }
  const start = tops[0];
  if (lines[start].replace(/^["']?pre-commit["']?\s*:/, '').replace(/\s+#.*$/, '').trim() !== '') {
    return problem('unsupported-hook', 'The lefthook pre-commit hook uses flow style or anchors, which Block Beaver does not edit.', manual);
  }
  let stop = start + 1;
  while (stop < lines.length && !(meaningful(lines[stop]) && indentOf(lines[stop]) === 0)) stop++;
  const block = lines.slice(start + 1, stop);
  const children = block.filter((line) => meaningful(line));
  const childIndent = children.length ? indentOf(children[0]) : 2;
  if (children.some((line) => indentOf(line) === childIndent && /^jobs\s*:/.test(line.trim()))) {
    return problem('unsupported-hook', 'The lefthook pre-commit hook uses "jobs", which Block Beaver does not edit.', manual);
  }
  if (children.some((line) => /^block-beaver\s*:/.test(line.trim()))) {
    return problem('command-name-collision', 'The lefthook pre-commit hook already has a command named "block-beaver" that Block Beaver did not write.', 'Rename that command or add the audit step to it yourself.');
  }
  const commands = block.findIndex((line) => indentOf(line) === childIndent && /^commands\s*:/.test(line.trim()) && meaningful(line));
  if (commands < 0) return finish(start, lefthookBlock('b', childIndent, childIndent, audit));
  if (block[commands].trim().replace(/^commands\s*:/, '').replace(/\s*#.*$/, '').trim() !== '') {
    return problem('unsupported-hook', 'The lefthook commands entry uses flow style, which Block Beaver does not edit.', manual);
  }
  const own = [];
  for (const line of block.slice(commands + 1)) {
    if (!meaningful(line)) continue;
    if (indentOf(line) <= childIndent) break;
    own.push(line);
  }
  const entries = own;
  const entryIndent = entries.length ? indentOf(entries[0]) : childIndent + 2;
  return finish(start + 1 + commands, lefthookBlock('c', entryIndent, Math.max(2, entryIndent - childIndent), audit));
}

function removeLefthook(before) {
  const region = findRegion(before);
  if (!region) return { content: before };
  if (region.ambiguous) return { problem: ['ambiguous-markers', 'The lefthook configuration has unbalanced or repeated Block Beaver markers.', 'Remove the stray block-beaver:start/end lines by hand.'] };
  const remaining = withoutRegion(before, region);
  return { content: remaining.trim() === '' ? null : remaining };
}

// ---- hook planning ---------------------------------------------------------------------------

async function readManifest(ctx) {
  const read = await safeRead(ctx, 'package.json');
  if (!read?.before) return {};
  try { const parsed = JSON.parse(read.before); return isObject(parsed) ? parsed : {}; } catch { return {}; }
}

async function planHooks(ctx) {
  const uninstall = ctx.operation === 'uninstall';
  const manifest = ctx.manifest;
  const lefthookFiles = [];
  for (const name of lefthookSupported) if (await exists(ctx, name)) lefthookFiles.push(name);
  const lefthookOther = [];
  for (const name of lefthookUnsupported) if (await exists(ctx, name)) lefthookOther.push(name);
  const hooksPath = ctx.git.ok ? ctx.git.hooksPath.replace(/\/$/, '') : '';

  if (uninstall) {
    if (await exists(ctx, '.husky/pre-commit')) await planProjectShell(ctx, '.husky/pre-commit', { uninstall });
    for (const name of lefthookFiles) await planLefthookFile(ctx, name, true);
    if (ctx.git.ok) await planBareHook(ctx, true);
    return;
  }

  const huskyByPath = hooksPath === '.husky' || hooksPath === '.husky/_';
  const husky = huskyByPath || await isDirectory(ctx, '.husky');
  const lefthookDependency = [manifest.dependencies, manifest.devDependencies].some((group) => isObject(group) && Object.hasOwn(group, 'lefthook'));
  const lefthook = lefthookFiles.length > 0 || lefthookOther.length > 0 || lefthookDependency;
  const foreign = [];
  if (isObject(manifest.husky)) foreign.push(['package.json', 'Husky 4 style "husky" configuration in package.json']);
  if (manifest['simple-git-hooks'] !== undefined) foreign.push(['package.json', 'simple-git-hooks configuration in package.json']);
  for (const name of ['.pre-commit-config.yaml', '.simple-git-hooks.json']) if (await exists(ctx, name)) foreign.push([name, `The ${name} hook manager`]);
  if (foreign.length) {
    for (const [path, what] of foreign) conflict(ctx, 'unsupported-hook', path, `${what} controls Git hooks here, and Block Beaver does not edit it.`, `Run "${ctx.auditStaged}" from that tool's pre-commit step.`);
    return;
  }
  if (husky && lefthook && !huskyByPath) {
    conflict(ctx, 'ambiguous-hook-manager', '.husky/pre-commit', 'Both Husky and lefthook are configured, so Block Beaver cannot tell which one runs pre-commit.', `Remove one of them, or add "${ctx.auditStaged}" to the one you use.`);
    return;
  }
  if (husky && (huskyByPath || !lefthook)) {
    if ((await entryAt(join(ctx.root, '.husky')))?.isSymbolicLink()) return conflict(ctx, 'unsafe-path', '.husky', 'The .husky directory is a symlink.', 'Use a real directory.');
    return planProjectShell(ctx, '.husky/pre-commit', { uninstall });
  }
  if (lefthook) {
    if (lefthookFiles.length > 1) return conflict(ctx, 'ambiguous-hook-manager', lefthookFiles[0], `Several lefthook configurations exist (${lefthookFiles.join(', ')}).`, 'Keep one, or add the audit step yourself.');
    if (!lefthookFiles.length && lefthookOther.length) return conflict(ctx, 'unsupported-hook', lefthookOther[0], `${lefthookOther[0]} is not a YAML configuration, which Block Beaver does not edit.`, `Add a pre-commit command running "${ctx.auditStaged}" yourself.`);
    return planLefthookFile(ctx, lefthookFiles[0] ?? 'lefthook.yml', false);
  }
  if (ctx.git.ok) await planBareHook(ctx, false);
}

async function planLefthookFile(ctx, path, uninstall) {
  const read = await safeRead(ctx, path);
  if (!read || (uninstall && read.before === null)) return;
  const result = uninstall ? removeLefthook(read.before) : planLefthook(read.before, ctx.auditStaged);
  if (result.problem) return conflict(ctx, result.problem[0], path, result.problem[1], result.problem[2]);
  addFile(ctx, { path, before: read.before, content: result.content, kind: 'hook' });
}

// ---- CI ---------------------------------------------------------------------------------------

async function detectPackageManager(ctx) {
  const found = [];
  for (const [name, id] of lockfiles) if (await exists(ctx, name)) found.push(id);
  const ids = unique(found);
  const declared = typeof ctx.manifest.packageManager === 'string' ? ctx.manifest.packageManager.split('@')[0] : '';
  if (ids.length > 1 && (!ids.includes(declared))) return { ambiguous: ids };
  if (ids.length === 1 && declared && declared !== ids[0]) return { ambiguous: unique([...ids, declared]) };
  let id = ids.includes(declared) ? declared : ids[0];
  if (!id && ['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) id = declared;
  const berry = id === 'yarn' && (/^yarn@(?:[2-9]|\d{2,})\./.test(ctx.manifest.packageManager || '') || await exists(ctx, '.yarnrc.yml') || await isDirectory(ctx, '.yarn'));
  return { id: id ?? 'npm', locked: found.includes(id), berry };
}

function installCommands(pm, { runner }) {
  if (pm.id === 'pnpm') return ['corepack enable', 'pnpm install --frozen-lockfile'];
  if (pm.id === 'yarn') return ['corepack enable', pm.berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile'];
  if (pm.id === 'bun') return [runner === 'github' ? null : 'npm install --global bun', 'bun install --frozen-lockfile'].filter((command) => command !== null);
  return [pm.locked ? 'npm ci' : 'npm install --no-audit --no-fund'];
}

const versionLine = (ctx) => (typeof ctx.version === 'string' && ctx.version ? `# block-beaver:version ${ctx.version}\n` : '');

export const DEFAULT_CI_NODE = '24';
const MINIMUM_CI_NODE = 22;

function majorFrom(text) {
  const match = typeof text === 'string' ? text.match(/(?<!\d)(\d{1,2})(?!\d)/) : null;
  return match ? match[1] : null;
}

/**
 * Pure node-version selection for managed CI, in order: .nvmrc, .node-version, package.json
 * engines.node, then the default. `image` is the major the GitLab image tag uses, or null.
 */
export function nodeSetupFrom({ nvmrc = null, nodeVersion = null, engines = null } = {}) {
  if (typeof nvmrc === 'string' && nvmrc.trim()) return { yaml: 'node-version-file: .nvmrc', image: majorFrom(nvmrc) };
  if (typeof nodeVersion === 'string' && nodeVersion.trim()) return { yaml: 'node-version-file: .node-version', image: majorFrom(nodeVersion) };
  if (typeof engines === 'string' && engines.trim()) return { yaml: `node-version: '${engines.trim().replace(/\s+/g, ' ').replaceAll("'", "''")}'`, image: majorFrom(engines) };
  return { yaml: `node-version: '${DEFAULT_CI_NODE}'`, image: DEFAULT_CI_NODE };
}

/** The repository's Node version for CI; unreadable version files fall through to the next source. */
async function ciNodeSetup(ctx) {
  const optional = async (path) => {
    if (!await exists(ctx, path)) return null;
    try { return await readProjectFile(ctx.root, path); }
    catch { return null; }
  };
  const setup = nodeSetupFrom({ nvmrc: await optional('.nvmrc'), nodeVersion: await optional('.node-version'), engines: ctx.manifest?.engines?.node });
  if (setup.image !== null && Number(setup.image) < MINIMUM_CI_NODE) {
    diagnose(ctx, 'ci-node-below-minimum', 'warning', `The repository's Node version (${setup.image}) is below ${MINIMUM_CI_NODE}, and Block Beaver requires Node >=22.18, so the managed CI job will fail.`,
      { remediation: 'Raise the Node version in .nvmrc, .node-version or package.json engines, or run the audit in your own CI.' });
  }
  return setup;
}

function githubWorkflow(ctx, pm, legacy = false) {
  const steps = [];
  if (pm.id === 'bun') steps.push('      - uses: oven-sh/setup-bun@v2');
  for (const command of installCommands(pm, { runner: 'github' })) steps.push(`      - run: ${command}`);
  const local = legacy ? 'npx --no-install block-beaver' : localBlockBeaverCommand(pm);
  const refresh = legacy ? '' : `      - name: Regenerate the block view\n        run: ${local} update --root .\n`;
  // Unmarked 0.1.x and 0.4.0 files carry the old bytes; they are matched exactly so they can be adopted.
  const [actionMajor, nodeLine] = legacy ? ['v4', 'node-version: 22'] : ['v7', (ctx.nodeSetup ?? nodeSetupFrom()).yaml];
  return `${ciMarker}\n${legacy ? '' : `${begin}\n`}${versionLine(ctx)}name: Block Beaver audit\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\npermissions:\n  contents: read\njobs:\n  block-beaver-audit:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${actionMajor}\n        with:\n          fetch-depth: 0\n      - uses: actions/setup-node@${actionMajor}\n        with:\n          ${nodeLine}\n${steps.join('\n')}\n      - name: Fetch the pull request base\n        env:\n          BASE_REF: \${{ github.base_ref }}\n        run: git fetch --no-tags origin "+refs/heads/\${BASE_REF}:refs/remotes/origin/\${BASE_REF}"\n${refresh}      - name: Audit against the merge base\n        env:\n          BLOCK_BEAVER_BASE_REF: origin/\${{ github.base_ref }}\n        run: ${local} audit --base merge-base --strict\n${legacy ? '' : `${end}\n`}`;
}

function gitlabJob(ctx, pm, legacy = false) {
  const install = installCommands(pm, { runner: 'gitlab' }).map((command) => `    - ${command}`).join('\n');
  const local = legacy ? 'npx --no-install block-beaver' : localBlockBeaverCommand(pm);
  const image = legacy ? '22' : ((ctx.nodeSetup ?? nodeSetupFrom()).image ?? DEFAULT_CI_NODE);
  return `${ciMarker}\n${legacy ? '' : `${begin}\n`}${versionLine(ctx)}block_beaver_audit:\n  image: node:${image}\n  stage: .pre\n  variables:\n    GIT_DEPTH: '0'\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'\n  script:\n${install}\n    - git fetch --no-tags origin "+refs/heads/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME:refs/remotes/origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"\n${legacy ? '' : `    - ${local} update --root .\n`}    - BLOCK_BEAVER_BASE_REF="origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" ${local} audit --base merge-base --strict\n${legacy ? '' : `${end}\n`}`;
}

function ciContent(ctx, path, before, desired, pm, render) {
  if (before === null) return desired;
  const region = findRegion(before);
  if (region?.ambiguous) {
    conflict(ctx, 'ambiguous-markers', path, `${path} has unbalanced or repeated Block Beaver markers.`, 'Remove the stray block-beaver:start/end lines, then rerun.');
    return undefined;
  }
  if (region) return replaceRegion(before, region, findRegion(desired).text);
  // Pre-hash installs can be adopted only when they match the exact known template.
  const oldVersion = before.match(/^# block-beaver:version (.+)$/m)?.[1];
  if (!ctx.force && before !== render({ ...ctx, version: oldVersion }, pm, true)) {
    conflict(ctx, 'managed-edited', path, `Owner edits or unverified content in the managed CI file ${path}; existing content was preserved.`,
      'Review the diff and rerun with --force to replace the managed file.', { before, expected: desired });
    return undefined;
  }
  return desired;
}

function removeCi(ctx, path, before) {
  const region = findRegion(before);
  if (region?.ambiguous) return conflict(ctx, 'ambiguous-markers', path, `${path} has unbalanced or repeated Block Beaver markers.`, 'Remove the stray block-beaver:start/end lines by hand.');
  if (!region) {
    if (!ctx.force) return conflict(ctx, 'managed-edited', path, `The managed CI file ${path} has no verified managed section; existing content was preserved.`, 'Review it and rerun with --force to remove it.');
    return addFile(ctx, { path, before, content: null, kind: 'ci' });
  }
  const remaining = withoutRegion(before, region).replace(new RegExp(`^${escapeRegex(ciMarker)}\\n`), '');
  addFile(ctx, { path, before, content: remaining.trim() ? remaining : null, kind: 'ci' });
}

const collisionRemediation = `Keep your file and add a step after installing dependencies and fetching the target branch: ${auditRange}`;

async function planCi(ctx) {
  const uninstall = ctx.operation === 'uninstall';
  const workflow = await safeRead(ctx, workflowPath);
  const job = await safeRead(ctx, gitlabJobPath);
  const config = await safeRead(ctx, gitlabConfigPath);
  const managed = (read) => read?.before?.startsWith(`${ciMarker}\n`) === true;

  if (uninstall) {
    if (managed(workflow)) removeCi(ctx, workflowPath, workflow.before);
    if (managed(job)) removeCi(ctx, gitlabJobPath, job.before);
    const region = config?.before ? findRegion(config.before) : null;
    if (region?.ambiguous) conflict(ctx, 'ambiguous-markers', gitlabConfigPath, 'The GitLab configuration has unbalanced or repeated Block Beaver markers.', 'Remove the stray block-beaver:start/end lines by hand.');
    else if (region) {
      let remaining = withoutRegion(config.before, region);
      if (remaining.endsWith('\n\n')) remaining = remaining.slice(0, -1);
      addFile(ctx, { path: gitlabConfigPath, before: config.before, content: remaining.trim() === '' ? null : remaining, kind: 'ci' });
    }
    return;
  }

  const origin = ctx.git.ok ? ctx.git.origin : '';
  const github = workflow !== null && (managed(workflow) || remoteProvider(origin) === 'github' || await isDirectory(ctx, '.github/workflows'));
  const gitlab = job !== null && config !== null && (managed(job) || remoteProvider(origin) === 'gitlab' || config.before !== null);
  if (!github && !gitlab) {
    if (workflow !== null && job !== null && config !== null) diagnose(ctx, 'ci-provider-undetected', 'info', 'No GitHub or GitLab project was detected, so no CI step was planned.', { remediation: `Run "${auditRange}" in your CI after installing dependencies and fetching the target branch.` });
    return;
  }
  const pm = await detectPackageManager(ctx);
  ctx.nodeSetup = await ciNodeSetup(ctx);

  if (github) {
    if (pm.ambiguous) conflict(ctx, 'ambiguous-package-manager', workflowPath, `Several lockfiles exist (${pm.ambiguous.join(', ')}), so the CI install command is ambiguous.`, 'Keep one lockfile, or add the audit step to your CI yourself.');
    else if (workflow.before !== null && !managed(workflow)) conflict(ctx, 'ci-collision', workflowPath, `${workflowPath} exists and is not managed by Block Beaver.`, collisionRemediation);
    else {
      const content = ciContent(ctx, workflowPath, workflow.before, githubWorkflow(ctx, pm), pm, githubWorkflow);
      if (content !== undefined) addFile(ctx, { path: workflowPath, before: workflow.before, content, kind: 'ci' });
    }
  }

  if (gitlab) {
    const section = `${begin}\ninclude:\n  - local: ${gitlabJobPath}\n${end}\n`;
    let content = null;
    if (pm.ambiguous) conflict(ctx, 'ambiguous-package-manager', gitlabJobPath, `Several lockfiles exist (${pm.ambiguous.join(', ')}), so the CI install command is ambiguous.`, 'Keep one lockfile, or add the audit step to your CI yourself.');
    else if (job.before !== null && !managed(job)) conflict(ctx, 'ci-collision', gitlabJobPath, `${gitlabJobPath} exists and is not managed by Block Beaver.`, collisionRemediation);
    else if (config.before === null) content = section;
    else {
      const region = findRegion(config.before);
      if (region?.ambiguous) conflict(ctx, 'ambiguous-markers', gitlabConfigPath, 'The GitLab configuration has unbalanced or repeated Block Beaver markers.', 'Remove the stray block-beaver:start/end lines, then rerun.');
      else if (region) content = replaceRegion(config.before, region, section);
      else if (/^include\s*:/m.test(config.before)) conflict(ctx, 'gitlab-include', gitlabConfigPath, 'The GitLab configuration already has an include list that Block Beaver does not edit.', `Add "- local: ${gitlabJobPath}" to your include list; the job file is written once that is done.`);
      else content = config.before + (config.before.endsWith('\n') ? '\n' : '\n\n') + section;
    }
    if (content !== null) {
      const jobContent = ciContent(ctx, gitlabJobPath, job.before, gitlabJob(ctx, pm), pm, gitlabJob);
      if (jobContent === undefined) return;
      addFile(ctx, { path: gitlabJobPath, before: job.before, content: jobContent, kind: 'ci' });
      addFile(ctx, { path: gitlabConfigPath, before: config.before, content, kind: 'ci' });
    }
  }
}

// ---- ignored install targets -------------------------------------------------------------------

function treeNode(parent, name) {
  if (!parent.children.has(name)) parent.children.set(name, { neg: false, reignore: false, dir: false, children: new Map() });
  return parent.children.get(name);
}

function parseBlockTree(region, tree) {
  if (!region || region.ambiguous) return;
  for (const raw of region.text.split('\n')) {
    const line = raw.trim();
    if (line === begin || line === end || !line) continue;
    const negated = line.startsWith('!');
    const path = negated ? line.slice(1) : line;
    if (!negated && !path.endsWith('/*')) continue;
    const segments = (negated ? path.replace(/\/$/, '') : path.slice(0, -2)).split('/');
    let node = tree;
    for (const segment of segments) node = treeNode(node, segment);
    if (negated) { node.neg = true; node.dir ||= path.endsWith('/'); }
    else { node.reignore = true; node.dir = true; }
  }
}

function renderTree(children, prefix, out) {
  for (const [name, node] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (node.neg) out.push(`!${path}${node.dir || node.reignore || node.children.size ? '/' : ''}`);
    if (node.reignore) out.push(`${path}/*`);
    renderTree(node.children, path, out);
  }
  return out;
}

async function planIgnores(ctx, agents) {
  const uninstall = ctx.operation === 'uninstall';
  const read = await safeRead(ctx, '.gitignore');
  if (!read) return;
  const before = read.before;
  const region = before === null ? null : findRegion(before);
  if (region?.ambiguous) return conflict(ctx, 'ambiguous-markers', '.gitignore', 'The .gitignore has unbalanced or repeated Block Beaver markers.', 'Remove the stray block-beaver:start/end lines, then rerun.');
  if (uninstall) {
    if (region) { const remaining = withoutRegion(before, region); addFile(ctx, { path: '.gitignore', before, content: remaining.trim() === '' ? null : remaining, kind: 'gitignore' }); }
    return;
  }

  const selected = new Set();
  for (const agent of agents) {
    const name = String(agent).toLowerCase() === 'agents' ? 'codex' : String(agent).toLowerCase();
    if (agentTargets[name]) selected.add(name);
    else diagnose(ctx, 'unknown-agent', 'warning', `Unknown agent "${agent}"; supported agents are ${Object.keys(agentTargets).join(', ')}.`);
  }
  if (!ctx.git.ok) return;
  const units = new Map();
  for (const path of ['.blocks/config.json', '.blocks/WORKFLOW.md']) units.set(path, { path });
  for (const name of selected) for (const unit of agentTargets[name]) units.set(unit.path, unit);
  for (const file of ctx.files.values()) if (file.content !== null && (file.kind === 'hook' || file.kind === 'ci')) units.set(file.path, { path: file.path });

  // Git only treats a trailing-slash path as a directory when it exists, so every unit is queried
  // through a file inside it: Git then reports the pattern of the excluded directory, if any.
  const queries = new Set();
  const chains = new Map();
  for (const unit of units.values()) {
    const segments = unit.path.replace(/\/$/, '').split('/');
    const depth = unit.dir ? segments.length : segments.length - 1;
    const query = unit.dir ? `${unit.path}${unit.probe}` : unit.path;
    chains.set(unit.path, { segments, query, chain: Array.from({ length: depth }, (_, index) => segments.slice(0, index + 1).join('/')) });
    queries.add(query);
  }
  const customWorktrees = ctx.work.custom ? ctx.work.dirs[0].path : null;
  if (customWorktrees) queries.add(`${customWorktrees}/probe/index.ts`);
  const answers = await checkIgnore(ctx, [...queries]);
  if (!answers) { diagnose(ctx, 'ignore-check-failed', 'info', 'Git could not check ignore rules for the install targets, so ignored targets were not reported.'); return; }

  if (customWorktrees && !answers.get(`${customWorktrees}/probe/index.ts`)?.ignored) {
    diagnose(ctx, 'worktrees-not-ignored', 'warning', `The configured worktrees directory ${customWorktrees}/ is not ignored by Git, so worktree copies could be committed.`,
      { path: `${customWorktrees}/`, remediation: `Add "/${customWorktrees}/" to .gitignore.` });
  }

  const tree = { children: new Map() };
  let additions = 0;
  for (const unit of units.values()) {
    const { segments, query, chain } = chains.get(unit.path);
    const answer = answers.get(query);
    if (!answer?.ignored) continue;
    const nested = answer.file.endsWith('.gitignore') && answer.file !== '.gitignore';
    const fixable = !nested && fixablePrefixes.some((prefix) => unit.path.startsWith(prefix));
    if (!fixable) {
      diagnose(ctx, 'ignored-target-unfixable', 'warning', `Block Beaver writes ${unit.path}, but it is ignored by ${answer.source}${nested ? ', a nested ignore file Block Beaver does not edit' : ', outside the .claude, .agents and .codex paths that --fix-ignores manages'}.`,
        { path: unit.path, source: answer.source, remediation: `Change the ignore rule yourself so ${unit.path} can be committed.` });
      continue;
    }
    if (!ctx.fixIgnores) {
      diagnose(ctx, 'ignored-target', 'warning', `Block Beaver writes ${unit.path}, but it is ignored by ${answer.source}; without a change it exists only on this machine.`,
        { path: unit.path, source: answer.source, remediation: 'Run with --fix-ignores to un-ignore only the managed paths, keeping local settings and worktrees ignored.' });
      continue;
    }
    // The topmost directory the reported pattern excludes: everything below it needs re-including.
    const first = chain.findIndex((dir) => dirPatternMatches(answer.pattern, dir));
    const leafSegments = unit.dir && first < 0 ? [...segments, unit.probe] : segments;
    let node = tree;
    for (const [index, segment] of leafSegments.slice(0, -1).entries()) {
      node = treeNode(node, segment);
      if (first >= 0 && index >= first) { node.neg = true; node.reignore = true; node.dir = true; }
    }
    const leaf = treeNode(node, leafSegments.at(-1));
    leaf.neg = true;
    leaf.dir ||= unit.dir === true && first >= 0;
    additions++;
  }
  if ((!ctx.fixIgnores && !region) || (!additions && !region)) return;

  parseBlockTree(region, tree);
  const lines = renderTree(tree.children, '', []);
  if (!lines.length) return;
  const block = `${begin}\n${lines.join('\n')}\n${end}\n`;
  let content;
  if (!region) content = appendBlock(before, block);
  else content = replaceRegion(before, region, block);
  addFile(ctx, { path: '.gitignore', before, content, kind: 'gitignore' });
}

// ---- host tools that pick up working files ----------------------------------------------------

function resolveWork(ctx) {
  const quiet = ctx.operation === 'uninstall';
  let worktrees = '.blocks/worktrees';
  const setting = isObject(ctx.config.worktrees) ? ctx.config.worktrees.dir : undefined;
  if (setting !== undefined) {
    const invalid = (reason) => { if (!quiet) diagnose(ctx, 'invalid-config', 'warning', `worktrees.dir ${reason}; using .blocks/worktrees.`, { path: '.blocks/config.json' }); };
    if (typeof setting !== 'string' || !setting.trim()) invalid('must be a non-empty path');
    else {
      const rel = slash(relative(ctx.root, resolve(ctx.root, setting)));
      if (rel === '') invalid('cannot be the repository root');
      else if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
        worktrees = null;
        if (!quiet) diagnose(ctx, 'worktrees-outside-root', 'info', `worktrees.dir ${setting} is outside the repository, so host tools cannot pick up worktree copies.`, { path: '.blocks/config.json' });
      } else if (rel === '.git' || rel.startsWith('.git/')) invalid('cannot be inside .git');
      else worktrees = rel;
    }
  }
  const dirs = [worktrees && { path: worktrees }, { path: '.blocks/cache' }, { path: '.blocks/view' }].filter(Boolean);
  return { dirs, custom: worktrees !== null && worktrees !== '.blocks/worktrees' };
}

const probes = (dir) => [`${dir.path}/probe/index.ts`, `${dir.path}/probe/index.js`, `${dir.path}/probe/index.test.ts`];

function virtualEntries(rootPath, files) {
  const directories = new Map();
  for (const file of files) {
    const parts = file.split('/');
    let current = rootPath;
    for (const [index, part] of parts.entries()) {
      if (!directories.has(current)) directories.set(current, { files: new Set(), directories: new Set() });
      const entry = directories.get(current);
      if (index === parts.length - 1) entry.files.add(part);
      else { entry.directories.add(part); current = `${current}/${part}`; }
    }
  }
  return (path) => {
    const entry = directories.get(path);
    return entry ? { files: [...entry.files], directories: [...entry.directories] } : { files: [], directories: [] };
  };
}

/** Ask TypeScript itself which Block Beaver working files a tsconfig would include. */
function tsPickup(ctx, rel, json) {
  if (typeof ts.matchFiles !== 'function') return { unverifiable: 'this TypeScript version cannot be asked about file matching' };
  const rootPath = slash(ctx.root);
  const entries = virtualEntries(rootPath, ctx.work.dirs.flatMap(probes));
  const host = { useCaseSensitiveFileNames: true, fileExists: ts.sys.fileExists, readFile: ts.sys.readFile,
    readDirectory: (dir, extensions, excludes, includes, depth) => ts.matchFiles(dir, extensions, excludes, includes, true, rootPath, depth, entries, (path) => path) };
  const configPath = `${rootPath}/${rel}`;
  const parsed = ts.parseJsonConfigFileContent(structuredClone(json), host, posix.dirname(configPath), undefined, configPath);
  const included = new Set(parsed.fileNames.map(slash));
  return { parsed, picked: ctx.work.dirs.filter((dir) => probes(dir).some((file) => included.has(`${rootPath}/${file}`))) };
}

// ---- JSON edits that keep the owner's text ----------------------------------------------------

function findProperty(object, name) {
  let found = null;
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) && property.name.text === name) found = property;
  }
  return found;
}
function inline(value) {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (isObject(value)) {
    const entries = Object.entries(value);
    return entries.length ? `{ ${entries.map(([key, child]) => `${JSON.stringify(key)}: ${inline(child)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(value);
}
function lineIndent(text, position) {
  return text.slice(text.lastIndexOf('\n', position - 1) + 1).match(/^[ \t]*/)[0];
}
function insertProperty(text, source, object, key, value) {
  const [first] = object.properties;
  if (!first) return { text: `${text.slice(0, object.getStart(source))}{ ${JSON.stringify(key)}: ${inline(value)} }${text.slice(object.end)}` };
  const last = object.properties.at(-1);
  let addition;
  if (text.slice(object.getStart(source), first.getStart(source)).includes('\n')) {
    const indent = lineIndent(text, last.getStart(source));
    addition = `,\n${indent}${JSON.stringify(key)}: ${JSON.stringify(value, null, indent.includes('\t') ? '\t' : '  ').replaceAll('\n', `\n${indent}`)}`;
  } else addition = `, ${JSON.stringify(key)}: ${inline(value)}`;
  return { text: text.slice(0, last.end) + addition + text.slice(last.end) };
}
function verified(result) {
  if (result.error) return result;
  const check = ts.parseConfigFileTextToJson('document.json', result.text);
  return check.error ? { error: 'The edited document would not be valid JSON.' } : result;
}

/** Add string values to the array at `keys`, creating it with `defaults` when absent. */
function editJsonArray(text, keys, values, defaults = []) {
  const source = ts.parseJsonText('document.json', text);
  if (source.parseDiagnostics.length) return { error: 'The file is not valid JSON.' };
  let object = source.statements[0]?.expression;
  if (!object || object.kind !== ts.SyntaxKind.ObjectLiteralExpression) return { error: 'The document is not a JSON object.' };
  for (let index = 0; index < keys.length - 1; index++) {
    const property = findProperty(object, keys[index]);
    if (!property) {
      let value = { [keys.at(-1)]: unique([...defaults, ...values]) };
      for (let back = keys.length - 2; back > index; back--) value = { [keys[back]]: value };
      return verified(insertProperty(text, source, object, keys[index], value));
    }
    if (property.initializer.kind !== ts.SyntaxKind.ObjectLiteralExpression) return { error: `"${keys[index]}" is not an object.` };
    object = property.initializer;
  }
  const key = keys.at(-1);
  const property = findProperty(object, key);
  if (!property) return verified(insertProperty(text, source, object, key, unique([...defaults, ...values])));
  const array = property.initializer;
  if (array.kind !== ts.SyntaxKind.ArrayLiteralExpression) return { error: `"${key}" is not an array.` };
  const present = new Set(array.elements.filter((element) => ts.isStringLiteral(element)).map((element) => element.text));
  const added = values.filter((value) => !present.has(value));
  if (!added.length) return { text };
  const last = array.elements[array.elements.length - 1];
  if (!last) return verified({ text: text.slice(0, array.getStart(source)) + inline(added) + text.slice(array.end) });
  const multiline = text.slice(array.getStart(source), array.elements[0].getStart(source)).includes('\n');
  const indent = lineIndent(text, last.getStart(source));
  const addition = added.map((value) => (multiline ? `,\n${indent}${JSON.stringify(value)}` : `, ${JSON.stringify(value)}`)).join('');
  return verified({ text: text.slice(0, last.end) + addition + text.slice(last.end) });
}

// ---- gitignore-style line matching (prettier and eslint ignore files) ---------------------------

function globSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') { index++; source += '(?:.*/)?'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += escapeRegex(char);
  }
  return source;
}
function lineRegex(raw) {
  let pattern = raw.trim();
  if (!pattern || pattern.startsWith('#')) return null;
  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);
  const directory = pattern.endsWith('/');
  if (directory) pattern = pattern.slice(0, -1);
  const anchored = pattern.includes('/');
  try { return { negated, regex: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globSource(pattern.replace(/^\//, ''))}${directory ? '/' : '(?:/|$)'}`) }; }
  catch { return null; }
}
/** Does an ignore pattern, as Git reported it, exclude this directory itself? */
function dirPatternMatches(raw, dir) {
  let pattern = raw.trim();
  if (!pattern || pattern.startsWith('!')) return false;
  if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
  const anchored = pattern.includes('/');
  try { return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globSource(pattern.replace(/^\//, ''))}$`).test(dir); }
  catch { return false; }
}
function coveredByLines(lines, path) {
  let ignored = false;
  for (const line of lines) {
    const matcher = lineRegex(line);
    if (matcher?.regex.test(path)) ignored = !matcher.negated;
  }
  return ignored;
}

// ---- host tool planning -----------------------------------------------------------------------

function pickupDiagnostic(ctx, tool, path, picked, how) {
  const paths = picked.map((dir) => dir.path);
  diagnose(ctx, 'host-pickup', 'warning', `${tool} configuration ${path} would pick up Block Beaver working files under ${paths.join(', ')}.`,
    { tool, path, paths, remediation: `${how}, or rerun with --fix-excludes.` });
  return paths;
}
function unfixableDiagnostic(ctx, tool, path, picked, reason) {
  diagnose(ctx, 'host-pickup-unfixable', 'warning', `${tool} configuration ${path} would pick up Block Beaver working files under ${picked.map((dir) => dir.path).join(', ')}, and ${reason}.`,
    { tool, path, paths: picked.map((dir) => dir.path), remediation: `Exclude those paths in ${path} manually.` });
}
function unsupportedDiagnostic(ctx, tool, path, reason) {
  diagnose(ctx, 'unsupported-host-config', 'warning', `${tool} is configured in ${path}, which ${reason}, so it was not checked or edited.`,
    { tool, path, remediation: `Exclude ${ctx.work.dirs.map((dir) => dir.path).join(', ')} manually in ${path}.` });
}

function tsDefaults(json, parsed, configDir) {
  const options = parsed?.options ?? {};
  const extras = [options.outDir, options.declarationDir].filter((value) => typeof value === 'string').map((value) => slash(relative(configDir, value)) || '.');
  const own = [json.compilerOptions?.outDir, json.compilerOptions?.declarationDir].filter((value) => typeof value === 'string');
  return unique(['node_modules', 'bower_components', 'jspm_packages', ...(own.length ? own : extras)]);
}

async function planTsconfig(ctx, rel) {
  const read = await safeRead(ctx, rel);
  if (!read || read.before === null) return;
  const text = read.before;
  const parsedText = ts.parseConfigFileTextToJson(rel, text);
  if (parsedText.error || !isObject(parsedText.config)) return unsupportedDiagnostic(ctx, 'tsc', rel, 'cannot be parsed as JSON');
  const json = parsedText.config;
  const analysis = tsPickup(ctx, rel, json);
  if (analysis.unverifiable) return unsupportedDiagnostic(ctx, 'tsc', rel, analysis.unverifiable);
  if (!analysis.picked.length) return;
  const configDir = posix.dirname(rel);
  const entries = analysis.picked.map((dir) => posix.relative(configDir, dir.path));
  const how = `Add ${entries.map((entry) => `"${entry}"`).join(', ')} to "exclude" in ${rel}`;
  if (!ctx.fixExcludes) return void pickupDiagnostic(ctx, 'tsc', rel, analysis.picked, how);
  if (json.exclude !== undefined && !Array.isArray(json.exclude)) return unfixableDiagnostic(ctx, 'tsc', rel, analysis.picked, 'its "exclude" is not an array');
  if (json.exclude === undefined && analysis.parsed.raw?.exclude !== undefined) return unfixableDiagnostic(ctx, 'tsc', rel, analysis.picked, 'its exclude is inherited through "extends", and adding one here would replace the inherited list');
  const defaults = json.exclude === undefined ? tsDefaults(json, analysis.parsed, join(ctx.root, configDir)) : [];
  const edit = editJsonArray(text, ['exclude'], entries, defaults);
  if (edit.error) return unfixableDiagnostic(ctx, 'tsc', rel, analysis.picked, edit.error.replace(/\.$/, ''));
  const after = tsPickup(ctx, rel, ts.parseConfigFileTextToJson(rel, edit.text).config);
  if (after.picked?.length) return unfixableDiagnostic(ctx, 'tsc', rel, analysis.picked, 'the added excludes would not be enough');
  addFile(ctx, { path: rel, before: text, content: edit.text, kind: 'exclude' });
}

async function planIgnoreFile(ctx, tool, path, extraLines = []) {
  const read = await safeRead(ctx, path);
  if (!read) return;
  const before = read.before;
  const region = before === null ? null : findRegion(before);
  if (region?.ambiguous) return conflict(ctx, 'ambiguous-markers', path, `${path} has unbalanced or repeated Block Beaver markers.`, 'Remove the stray block-beaver:start/end lines, then rerun.');
  const lines = [...(before ? before.split('\n') : []), ...extraLines];
  const missing = ctx.work.dirs.filter((dir) => !coveredByLines(lines, `${dir.path}/probe/index.ts`));
  if (!missing.length && !region) return;
  if (!ctx.fixExcludes && !region) return void pickupDiagnostic(ctx, tool, path, missing, `Add ${missing.map((dir) => `/${dir.path}/`).join(', ')} to ${path}`);
  const block = `${begin}\n${ctx.work.dirs.map((dir) => `/${dir.path}/`).join('\n')}\n${end}\n`;
  addFile(ctx, { path, before, content: region ? replaceRegion(before, region, block) : appendBlock(before, block), kind: 'exclude' });
}

async function removeIgnoreBlock(ctx, path) {
  const read = await safeRead(ctx, path);
  const region = read?.before ? findRegion(read.before) : null;
  if (!region) return;
  if (region.ambiguous) return conflict(ctx, 'ambiguous-markers', path, `${path} has unbalanced or repeated Block Beaver markers.`, 'Remove the stray block-beaver:start/end lines by hand.');
  const remaining = withoutRegion(read.before, region);
  addFile(ctx, { path, before: read.before, content: remaining.trim() === '' ? null : remaining, kind: 'exclude' });
}

async function planJest(ctx) {
  const scripts = [];
  for (const name of unsupportedTools.jest) if (await exists(ctx, name)) scripts.push(name);
  for (const name of scripts) unsupportedDiagnostic(ctx, 'jest', name, 'is a script Block Beaver cannot parse safely');
  if (scripts.length) return;
  let path = null, prefix = [];
  if (await exists(ctx, 'jest.config.json')) path = 'jest.config.json';
  else if (isObject(ctx.manifest.jest)) { path = 'package.json'; prefix = ['jest']; }
  if (!path) return;
  const read = await safeRead(ctx, path);
  if (!read || read.before === null) return;
  const parsed = ts.parseConfigFileTextToJson(path, read.before);
  let config = parsed.config;
  for (const key of prefix) config = isObject(config) ? config[key] : undefined;
  if (parsed.error || !isObject(config)) return unsupportedDiagnostic(ctx, 'jest', path, 'cannot be parsed as JSON');
  if (['rootDir', 'roots', 'projects', 'testMatch', 'testRegex'].some((key) => config[key] !== undefined)) {
    return unsupportedDiagnostic(ctx, 'jest', path, 'sets rootDir, roots, projects, testMatch or testRegex, which Block Beaver does not evaluate');
  }
  const patterns = [...(Array.isArray(config.testPathIgnorePatterns) ? config.testPathIgnorePatterns : ['/node_modules/']), ...(Array.isArray(config.modulePathIgnorePatterns) ? config.modulePathIgnorePatterns : [])];
  const regexes = [];
  for (const pattern of patterns.filter((value) => typeof value === 'string')) {
    try { regexes.push(new RegExp(pattern.replaceAll('<rootDir>', escapeRegex(ctx.root)))); }
    catch { return unsupportedDiagnostic(ctx, 'jest', path, 'has an ignore pattern that is not a valid regular expression'); }
  }
  const picked = ctx.work.dirs.filter((dir) => !regexes.some((regex) => regex.test(`${ctx.root}/${dir.path}/probe/index.test.ts`)));
  if (!picked.length) return;
  // Jest interprets these entries as regular expressions; escape configured directory names
  // so a dot (or other regex character) cannot also exclude unrelated owner source files.
  const entries = picked.map((dir) => `<rootDir>/${escapeRegex(dir.path)}/`);
  if (!ctx.fixExcludes) return void pickupDiagnostic(ctx, 'jest', path, picked, `Add ${entries.map((entry) => `"${entry}"`).join(', ')} to modulePathIgnorePatterns in ${path}`);
  const edit = editJsonArray(read.before, [...prefix, 'modulePathIgnorePatterns'], entries);
  if (edit.error) return unfixableDiagnostic(ctx, 'jest', path, picked, edit.error.replace(/\.$/, ''));
  addFile(ctx, { path, before: read.before, content: edit.text, kind: 'exclude' });
}

async function planHostTools(ctx, uninstall) {
  if (uninstall) {
    for (const path of ['.prettierignore', '.eslintignore']) await removeIgnoreBlock(ctx, path);
    return;
  }
  const configs = new Set(['tsconfig.json']);
  for (const app of Array.isArray(ctx.config.apps) ? ctx.config.apps : []) {
    if (!isObject(app) || typeof app.tsconfig !== 'string') continue;
    const normalized = posix.normalize(slash(app.tsconfig));
    if (!normalized.startsWith('..') && !isAbsolute(normalized) && normalized !== '.') configs.add(normalized);
  }
  for (const rel of configs) await planTsconfig(ctx, rel);

  let prettier = isObject(ctx.manifest) && ctx.manifest.prettier !== undefined;
  for (const name of prettierConfigs) prettier ||= await exists(ctx, name);
  if (prettier) await planIgnoreFile(ctx, 'prettier', '.prettierignore');

  const scripts = [];
  for (const name of unsupportedTools.eslint) if (await exists(ctx, name)) scripts.push(name);
  if (ctx.manifest.eslintConfig !== undefined) scripts.push('package.json');
  for (const name of scripts) unsupportedDiagnostic(ctx, 'eslint', name, 'Block Beaver cannot parse safely');
  if (!scripts.length && (await exists(ctx, '.eslintrc.json') || await exists(ctx, '.eslintrc') || await exists(ctx, '.eslintignore'))) {
    const extra = [];
    for (const name of ['.eslintrc.json', '.eslintrc']) {
      const read = await exists(ctx, name) ? await safeRead(ctx, name) : null;
      const patterns = read?.before ? ts.parseConfigFileTextToJson(name, read.before).config?.ignorePatterns : undefined;
      if (typeof patterns === 'string') extra.push(patterns);
      else if (Array.isArray(patterns)) extra.push(...patterns.filter((pattern) => typeof pattern === 'string'));
    }
    await planIgnoreFile(ctx, 'eslint', '.eslintignore', extra);
  }

  await planJest(ctx);
  for (const tool of ['vitest', 'biome']) for (const name of unsupportedTools[tool]) if (await exists(ctx, name)) unsupportedDiagnostic(ctx, tool, name, 'Block Beaver cannot parse safely');
}

// ---- entry point ------------------------------------------------------------------------------

export async function planHostSetup(root, { config, agents = [], fixIgnores = false, fixExcludes = false, operation = 'install', version, force = false } = {}) {
  if (!['install', 'upgrade', 'uninstall'].includes(operation)) throw new Error(`Unknown host setup operation: ${operation}`);
  const ctx = { root: await realpath(resolve(root)), config: isObject(config) ? config : {}, operation, version, fixIgnores, fixExcludes, force,
    files: new Map(), hooks: [], diagnostics: [], conflicts: [] };
  const uninstall = operation === 'uninstall';
  ctx.git = await inspectGit(ctx.root);
  if (!ctx.git.ok && !uninstall) diagnose(ctx, 'git-unavailable', 'warning', `${ctx.root} ${ctx.git.reason}, so Git hooks and ignore checks were skipped.`);
  ctx.manifest = await readManifest(ctx);
  ctx.work = resolveWork(ctx);
  ctx.pm = await detectPackageManager(ctx);
  ctx.auditStaged = `${localBlockBeaverCommand(ctx.pm.id || 'npm')} audit --staged --root .`;

  await planHooks(ctx);
  await planCi(ctx);
  await planIgnores(ctx, Array.isArray(agents) ? agents : []);
  await planHostTools(ctx, uninstall);
  return { files: [...ctx.files.values()], hooks: ctx.hooks, diagnostics: ctx.diagnostics, conflicts: ctx.conflicts };
}
