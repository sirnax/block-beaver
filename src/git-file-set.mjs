import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Files Git considers part of the working tree: tracked plus untracked-not-ignored, relative to
 * `root` (which may be a subdirectory of the work tree). Resolves to null outside Git, on any Git
 * error, or when nothing is tracked (a fresh `git init`, such as the staged-audit snapshot), so
 * callers fall back to the plain directory walk.
 * Self-contained (no compliance-git import) because the family load worker copies a minimal module set.
 * Pass one `cache` Map per scan so the listing is computed once per root.
 */
export function gitFileSet(root, cache) {
  const key = resolve(root);
  if (cache?.has(key)) return cache.get(key);
  const promise = list(key);
  cache?.set(key, promise);
  return promise;
}

async function list(root) {
  let output;
  try { output = (await exec('git', ['-C', root, 'ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })).stdout; }
  catch { return null; }
  const files = new Set(), directories = [];
  let tracked = 0;
  for (const record of output.toString('utf8').split('\0')) {
    if (record.length < 3) continue;
    const path = record.slice(2);
    if (record[0] !== '?') tracked++;
    if (path.endsWith('/')) directories.push(path); // an untracked nested repository
    else files.add(path);
  }
  if (!tracked) return null;
  return { has: (path) => files.has(path) || directories.some((directory) => path.startsWith(directory)) };
}
