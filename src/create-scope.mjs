import { lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, join } from 'node:path';

const exec = promisify(execFile);
const skippedDirectories = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel', '.blocks', 'vendor']);
const extensions = new Set(['.json', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

function assertRelativePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) ||
      path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe creation path: ${path}`);
  }
  const parts = path.split('/');
  if (parts.some((part, index) => index < parts.length - 1 && (part.startsWith('.') || skippedDirectories.has(part)))) {
    throw new Error(`Creation path is in a directory excluded by the scanner: ${path}`);
  }
  if (parts[parts.length - 1].startsWith('.') || !extensions.has(extname(path)) || path.endsWith('.d.ts')) {
    throw new Error(`Creation path must be a supported JSON or JS/TS/React source file: ${path}`);
  }
  return path;
}

/** Recheck before application as well as at planning: graph fingerprints omit new files. */
export async function assertCreatePathAbsent(root, path) {
  assertRelativePath(path);
  const parts = path.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let entry;
    try { entry = await lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (entry.isSymbolicLink()) throw new Error(`Creation path has a symlink component: ${path}`);
    if (index === parts.length - 1) throw new Error(`Creation target already exists: ${path}`);
    if (!entry.isDirectory()) throw new Error(`Creation path has a non-directory parent: ${path}`);
  }
}

async function assertNotIgnored(root, path) {
  try { await exec('git', ['-C', root, 'check-ignore', '-q', '--no-index', '--', path]); }
  catch (error) {
    if (error.code === 1) return;
    throw new Error(`Cannot check whether creation path is ignored: ${path}`);
  }
  throw new Error(`Creation path is ignored by Git: ${path}`);
}

/** Validate proposed new files independently of graph nodes and source hashes. */
export async function validateCreateScope(root, graph, createScope = [], { scope = [] } = {}) {
  if (!Array.isArray(createScope)) throw new Error('Creation scope must be an array of paths.');
  const seen = new Set();
  for (const path of createScope) {
    assertRelativePath(path);
    if (seen.has(path)) throw new Error(`Duplicate creation path: ${path}`);
    if (scope.includes(path) || Object.hasOwn(graph.hashes, path)) throw new Error(`Creation path overlaps existing source scope: ${path}`);
    for (const other of seen) if (path.startsWith(`${other}/`) || other.startsWith(`${path}/`)) throw new Error(`Overlapping creation paths: ${path} and ${other}`);
    seen.add(path);
    await assertCreatePathAbsent(root, path);
    await assertNotIgnored(root, path);
  }
  return createScope;
}
