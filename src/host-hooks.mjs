import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { git } from './compliance-git.mjs';
import { fileModeMatches } from './file-mode.mjs';

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const inside = (base, path) => {
  const local = relative(base, path);
  return local === '' || local !== '..' && !local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(local);
};
const validateMode = (mode) => {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid host file mode.');
};

async function parents(anchor, path, { create = false } = {}) {
  if (!inside(anchor, path) || path === anchor) throw new Error('Host path is outside its allowed directory.');
  let current = anchor;
  const parts = relative(anchor, dirname(path)).split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    let entry;
    try { entry = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) continue;
      try { await mkdir(current); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      entry = await lstat(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe host hook parent: ${current}`);
  }
  if (create && await realpath(dirname(path)) !== dirname(path)) throw new Error('Host hook parent changed during application.');
}

async function readCurrent(anchor, path) {
  await parents(anchor, path);
  let entry;
  try { entry = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return { content: null, stat: null }; throw error; }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error(`Host hook must be an independent regular file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!sameFile(entry, stat) || !stat.isFile() || stat.nlink !== 1) throw new Error('Host hook changed identity while reading.');
    const content = await handle.readFile('utf8');
    if (!sameFile(stat, await lstat(path))) throw new Error('Host hook changed identity while reading.');
    return { content, stat };
  } finally { await handle.close(); }
}

async function hookTarget(inputRoot) {
  const suppliedRoot = resolve(inputRoot);
  const root = await realpath(suppliedRoot);
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(top) !== root) throw new Error('Host hooks require the repository root.');
  let configured = null;
  try { configured = (await git(root, ['config', '--get', 'core.hooksPath'])).trim(); }
  catch (error) { if (error.code !== 1) throw error; }
  const raw = (await git(root, ['rev-parse', '--git-path', 'hooks'])).trim();
  let hooks = resolve(root, raw);
  const commonRaw = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
  const commonPath = resolve(root, commonRaw);
  const commonEntry = await lstat(commonPath);
  if (!commonEntry.isDirectory() || commonEntry.isSymbolicLink()) throw new Error('Git metadata directory is unsafe.');
  const common = await realpath(commonPath);
  if (inside(commonPath, hooks)) hooks = resolve(common, relative(commonPath, hooks));
  // External shared metadata is legitimate for linked worktrees. Arbitrary
  // external core.hooksPath destinations remain owner-managed.
  if (!inside(root, hooks) && !inside(common, hooks)) throw new Error(`External core.hooksPath is unsupported; existing hooks were preserved: ${configured || hooks}`);
  const anchor = inside(root, hooks) ? root : common;
  const target = join(hooks, 'pre-commit');
  await parents(anchor, target);
  return { root, suppliedRoot, commonPath, common, target, anchor };
}

function plannedPath(state, hook) {
  if (!hook || hook.kind !== 'hook' || typeof hook.absolutePath !== 'string' || !isAbsolute(hook.absolutePath) ||
      typeof hook.path !== 'string' || hook.before !== null && typeof hook.before !== 'string' ||
      hook.content !== null && typeof hook.content !== 'string') throw new Error('Malformed host hook plan.');
  const supplied = resolve(hook.absolutePath);
  let absolute = inside(state.suppliedRoot, supplied) ? resolve(state.root, relative(state.suppliedRoot, supplied)) : supplied;
  if (inside(state.commonPath, absolute)) absolute = resolve(state.common, relative(state.commonPath, absolute));
  const expectedLabel = relative(state.root, state.target).split('\\').join('/');
  if (absolute !== state.target || !['.git/hooks/pre-commit', expectedLabel].includes(hook.path)) throw new Error('Host plan does not name the actual Git pre-commit hook.');
  validateMode(hook.mode ?? 0o755);
  return absolute;
}

/** Verify every planned bare Git hook before any package commands or writes. */
export async function preflightHostHooks(root, hooks = []) {
  if (!Array.isArray(hooks)) throw new Error('Host hook plans must be an array.');
  if (!hooks.length) return [];
  const state = await hookTarget(root);
  if (hooks.length !== 1) throw new Error('Duplicate Git pre-commit hook plans.');
  const hook = hooks[0];
  const path = plannedPath(state, hook);
  const current = await readCurrent(state.anchor, path);
  if (current.content !== hook.before) throw new Error(`Host hook preimage changed: ${hook.path}`);
  return [{ ...hook, absolutePath: path, anchor: state.anchor, stat: current.stat }];
}

async function assertIdentity(anchor, path, stat) {
  await parents(anchor, path, { create: true });
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameFile(current, stat)) throw new Error('Host hook changed identity during application.');
}

/** Apply only pre-commit plans verified against Git's own configured location. */
export async function applyHostHooks(root, hooks = []) {
  const plans = await preflightHostHooks(root, hooks);
  const changed = [];
  for (const plan of plans) {
    const path = plan.absolutePath;
    if (plan.content === null) {
      if (plan.before === null) continue;
      const current = await readCurrent(plan.anchor, path);
      if (current.content !== plan.before || !sameFile(current.stat, plan.stat)) throw new Error('Host hook changed before removal.');
      await assertIdentity(plan.anchor, path, current.stat);
      await unlink(path);
      changed.push(plan.path);
      continue;
    }
    const mode = plan.mode ?? 0o755;
    if (plan.content === plan.before && fileModeMatches(plan.stat.mode, mode)) continue;
    await parents(plan.anchor, path, { create: true });
    const access = plan.content === plan.before ? constants.O_RDONLY : constants.O_RDWR;
    const flags = plan.before === null ? constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW : access | constants.O_NOFOLLOW;
    const handle = await open(path, flags, mode);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || plan.stat && !sameFile(stat, plan.stat)) throw new Error('Host hook changed before writing.');
      await assertIdentity(plan.anchor, path, stat);
      if (plan.before !== null && await handle.readFile('utf8') !== plan.before) throw new Error('Host hook preimage changed before writing.');
      if (plan.content !== plan.before) {
        const bytes = Buffer.from(plan.content);
        let offset = 0;
        while (offset < bytes.length) offset += (await handle.write(bytes, offset, bytes.length - offset, offset)).bytesWritten;
        await handle.truncate(bytes.length);
      }
      await assertIdentity(plan.anchor, path, stat);
      await handle.chmod(mode);
      changed.push(plan.path);
    } finally { await handle.close(); }
  }
  return changed;
}

function projectModePath(root, file) {
  if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || /[\x00-\x1f\x7f]/.test(file.path) ||
      isAbsolute(file.path) || /^[a-zA-Z]:/.test(file.path) || file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      file.path === '.git' || file.path.startsWith('.git/')) throw new Error('Unsafe project mode path.');
  validateMode(file.mode);
  return resolve(root, file.path);
}

/** Check mode-bearing ordinary files against their pre-write plan. */
export async function preflightProjectModes(inputRoot, files = []) {
  const plans = files.filter((file) => file.mode !== undefined && file.content !== null);
  if (!plans.length) return [];
  const root = await realpath(inputRoot);
  for (const file of plans) {
    const path = projectModePath(root, file);
    const current = await readCurrent(root, path);
    if (current.content !== file.before) throw new Error(`Project mode preimage changed: ${file.path}`);
  }
  return plans.map((file) => file.path);
}

/** Chmod the verified writer's exact outputs using safe file descriptors. */
export async function applyProjectModes(inputRoot, files = []) {
  const plans = files.filter((file) => file.mode !== undefined && file.content !== null);
  if (!plans.length) return [];
  const root = await realpath(inputRoot);
  const checked = [];
  for (const file of plans) {
    const path = projectModePath(root, file);
    const current = await readCurrent(root, path);
    if (current.content === null || current.content !== file.content) throw new Error(`Project writer output changed before chmod: ${file.path}`);
    checked.push({ file, path, stat: current.stat });
  }
  const changed = [];
  for (const { file, path, stat } of checked) {
    if (fileModeMatches(stat.mode, file.mode)) continue;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      if (!sameFile(stat, current) || !current.isFile() || current.nlink !== 1 || await handle.readFile('utf8') !== file.content) throw new Error('Project file changed before chmod.');
      await assertIdentity(root, path, current);
      await handle.chmod(file.mode);
      changed.push(file.path);
    } finally { await handle.close(); }
  }
  return changed;
}
