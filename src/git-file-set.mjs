import { join, resolve } from 'node:path';
import { access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';

const exec = promisify(execFile);

/**
 * One listing per root for the duration of an operation (a CLI command, one live refresh, one load
 * worker message). Callers without a scope or an explicit cache list afresh.
 */
export const gitScope = new AsyncLocalStorage();

/**
 * Git's view of which working-tree files are ignored, relative to `root` (which may be a subdirectory
 * of the work tree). `has(path)` is true unless Git ignores the path; tracked files are never ignored.
 * Because it lists ignored paths rather than included ones, a file created later in the same
 * operation (a freshly generated output) is still seen. Resolves to null outside Git or on any Git
 * error, or when nothing is tracked yet, so callers fall back to the plain directory walk.
 * Self-contained (no compliance-git import) because the family load worker copies a minimal module set.
 */
export function gitFileSet(root, cache = gitScope.getStore()) {
  const key = resolve(root);
  if (cache?.has(key)) return cache.get(key);
  const promise = list(key);
  cache?.set(key, promise);
  return promise;
}

async function list(root) {
  // Nothing tracked yet (a fresh `git init` with no index, such as the staged-audit snapshot): walk
  // plainly, so a force-added ignored file is treated the same in the working tree and the snapshot.
  const gitDirectory = await stat(join(root, '.git')).catch(() => null);
  if (gitDirectory?.isDirectory() && !await access(join(root, '.git', 'index')).then(() => true, () => false)) return null;
  let output;
  try { output = (await exec('git', ['-C', root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })).stdout; }
  catch { return null; }
  const files = new Set(), directories = [];
  for (const path of output.toString('utf8').split('\0')) {
    if (!path) continue;
    if (path.endsWith('/')) directories.push(path); // a wholly ignored directory
    else files.add(path);
  }
  return fromIgnored({ files: [...files], directories });
}

/** `ignored` is plain data, so a parent process can hand its listing to a child (the family load worker). */
function fromIgnored(ignored) {
  const files = new Set(ignored.files);
  return { ignored, has: (path) => !files.has(path) && !ignored.directories.some((directory) => path.startsWith(directory)) };
}

/** Seed the current scope with a listing another process already made (`null` means: walk plainly). */
export function seedGitFileSet(root, ignored, cache = gitScope.getStore()) {
  cache?.set(resolve(root), Promise.resolve(ignored ? fromIgnored(ignored) : null));
}
