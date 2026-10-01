import * as module from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function loaderError(code, message, file) {
  const error = new Error(message);
  error.familyLoaderCode = code;
  if (file) error.familyLoaderFile = file;
  return error;
}

export function repositoryPath(root, url) {
  if (!url?.startsWith('file:')) return undefined;
  let absolute;
  try { absolute = fileURLToPath(url); } catch { return undefined; }
  const path = relative(root, absolute).split('\\').join('/');
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path) || path.split('/').includes('node_modules')) return undefined;
  return path;
}

const internalSources = new Set(['load-worker.mjs', 'hooks.mjs', 'config.mjs', 'glob.mjs', 'canonical.mjs', 'loader.mjs'].map((path) => new URL(path, import.meta.url).href));
const kernelDirectory = new URL('../kernel/', import.meta.url).href;
const isInternal = (url) => internalSources.has(url) || url?.startsWith(kernelDirectory);

/** TypeScript declarations describe a module; they are never its runtime entry. */
export function runtimeSourcePath(root, path) {
  if (!/\.d\.(?:ts|mts|cts)$/.test(path)) return path;
  const runtime = path.replace(/\.d\.(ts|mts|cts)$/, (_, extension) => ({ ts: '.js', mts: '.mjs', cts: '.cjs' })[extension]);
  return existsSync(join(root, runtime)) ? runtime : undefined;
}

/** Follow the same independent-file boundary as the writer, before evaluating owner code. */
export function assertSafeSource(root, path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw loaderError('load-failed', 'Source path must stay inside the repository', path);
  let absolute = root;
  for (const [index, part] of path.split('/').entries()) {
    absolute = join(absolute, part);
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) throw loaderError('load-failed', `Source path is a symlink: ${path}`, path);
    if (index < path.split('/').length - 1 && !entry.isDirectory()) throw loaderError('load-failed', `Source parent is not a directory: ${path}`, path);
    if (index === path.split('/').length - 1 && (!entry.isFile() || entry.nlink !== 1)) throw loaderError('load-failed', `Source is not an independent regular file: ${path}`, path);
  }
  if (realpathSync(absolute) !== absolute) throw loaderError('load-failed', `Source path escapes the repository: ${path}`, path);
  return absolute;
}

/** Process-local hooks are installed only in the disposable loader child. */
export function installFamilyHooks({ root, project, kernelUrl, loadedFiles, sourceHashes, dependencies }) {
  if (typeof module.registerHooks !== 'function' || !process.features.typescript || typeof module.stripTypeScriptTypes !== 'function') {
    throw loaderError('loader-node-version', 'Family loading requires Node 22.18+ with registerHooks and built-in TypeScript stripping');
  }
  return module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const from = repositoryPath(root, context.parentURL);
      const delegate = () => {
        try { return nextResolve(specifier, context); }
        catch (error) {
          if (from !== undefined) throw loaderError('unresolved-import', `${from}: ${error.message}`, from);
          throw error;
        }
      };
      if (from === undefined || isInternal(context.parentURL) || /^(?:file|data|node):/.test(specifier)) return delegate();
      if (specifier === 'block-beaver/kernel') return { url: kernelUrl, shortCircuit: true };
      const resolution = project.resolveImport(from, specifier, { mode: 'import' });
      if (resolution.path) {
        const target = runtimeSourcePath(root, resolution.path);
        if (!target) return delegate();
        if (!dependencies.has(from)) dependencies.set(from, new Set());
        dependencies.get(from).add(target);
        if (/\.tsx$/i.test(target)) {
          loadedFiles.add(target);
          sourceHashes.set(target, createHash('sha256').update(readFileSync(assertSafeSource(root, target))).digest('hex'));
          throw loaderError('tsx-unsupported', `Cannot load ${target}, imported by ${from}: .tsx requires a configured loader`, target);
        }
        assertSafeSource(root, target);
        return { url: pathToFileURL(join(root, target)).href, shortCircuit: true };
      }
      if (resolution.error) throw loaderError('unresolved-import', `${from}: ${resolution.error}`, from);
      return delegate();
    },
    load(url, context, nextLoad) {
      const path = repositoryPath(root, url);
      if (path === undefined || isInternal(url)) return nextLoad(url, context);
      if (/\.tsx$/i.test(path)) throw loaderError('tsx-unsupported', `Cannot load ${path}: .tsx requires a configured loader`, path);
      const absolute = assertSafeSource(root, path);
      loadedFiles.add(path);
      if (/\.(?:ts|mts|cts)$/i.test(path)) {
        const source = readFileSync(absolute, 'utf8');
        sourceHashes.set(path, createHash('sha256').update(source).digest('hex'));
        try {
          // Preflight here so a transitive failure always names its offending file.
          module.stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url });
        } catch (error) {
          if (error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw loaderError('non-strippable-syntax', `${path}: ${error.message}`, path);
          throw loaderError('load-failed', `${path}: ${error.message}`, path);
        }
        return { format: 'module-typescript', source, shortCircuit: true };
      }
      try {
        const loaded = nextLoad(url, context);
        const source = loaded.source ?? readFileSync(absolute);
        sourceHashes.set(path, createHash('sha256').update(source).digest('hex'));
        if (/\.(?:js|mjs|cjs)$/.test(path)) module.stripTypeScriptTypes(source.toString(), { mode: 'strip', sourceUrl: url });
        return { ...loaded, source };
      } catch (error) { throw loaderError('load-failed', `${path}: ${error.message}`, path); }
    },
  });
}
