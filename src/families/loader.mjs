import { execFile, fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalJson } from './canonical.mjs';
import { historyLabelModule, isFamilyPath, parseFamiliesConfig } from './config.mjs';
import { discoverFiles, matchManifests } from './glob.mjs';

const cliVersion = createRequire(import.meta.url)('../../package.json').version;
const workerPath = fileURLToPath(new URL('./load-worker.mjs', import.meta.url));
const kernelUrl = new URL('../kernel/index.mjs', import.meta.url).href;
const roots = new Map();
const timeoutMs = 120000;
const execFileAsync = promisify(execFile);
const empty = (diagnostics = []) => ({ families: [], manifests: [], generators: [], loadedFiles: [], fileHashes: {}, diagnostics });

function childEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
}

function rootCache(root) {
  let state = roots.get(root);
  if (!state) state = { loadedFiles: [], results: new Map(), inflight: new Map() };
  roots.delete(root); roots.set(root, state);
  while (roots.size > 4) roots.delete(roots.keys().next().value);
  return state;
}

async function contentHashes(root, paths, fileHashes) {
  return Promise.all([...new Set(paths)].sort().map(async (path) => {
    // Hash actual bytes as well as the graph's snapshot: imported files may not be
    // scanner inputs, and a watch request can race a previously collected graph.
    try { return [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex'), fileHashes?.[path] ?? null]; }
    catch (error) { return [path, `missing:${error.code || error.message}`, fileHashes?.[path] ?? null]; }
  }));
}

function cacheKey({ config, resolutionSignature, matched, hashes, loaderUrl, paths }) {
  return createHash('sha256').update(canonicalJson({ protocol: 1, cliVersion, node: process.version, config, resolutionSignature: resolutionSignature ?? null, paths, matched, hashes, loaderUrl: loaderUrl ?? null })).digest('hex');
}

async function resolveLoader(root, packageName) {
  if (!packageName) return undefined;
  // require.resolve uses the require export condition. The actual --import must
  // use import conditions, with its synthetic importing module rooted in cwd.
  const env = childEnvironment();
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', `process.stdout.write(import.meta.resolve(${JSON.stringify(packageName)}))`], { cwd: root, env, timeout: 10000, maxBuffer: 16384 });
  return new URL(stdout).href;
}

function spawnLoad({ root, paths, config, generate, loaderUrl }) {
  return new Promise((resolveResult) => {
    const env = childEnvironment();
    const execArgv = ['--disable-warning=ExperimentalWarning'];
    if (loaderUrl) execArgv.push('--import', loaderUrl);
    let child;
    try { child = fork(workerPath, { cwd: root, execArgv, env, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); }
    catch (error) { resolveResult({ ...empty([{ rule: 'manifest-valid', code: 'load-failed', severity: 'error', message: error.message }]), cacheable: false }); return; }
    const token = randomBytes(32).toString('hex');
    let output = '', reply, done = false;
    const capture = (data) => { output = (output + data.toString()).slice(-16384); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const finish = (value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolveResult(value);
    };
    const failure = (code, message) => ({ ...empty([{ rule: 'manifest-valid', code, severity: 'error', message: output ? `${message}\nChild output (tail):\n${output}` : message }]), cacheable: false });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(failure('loader-timeout', 'Family loader exceeded its 120 second limit')); }, timeoutMs);
    child.once('error', (error) => finish(failure('load-failed', error.message)));
    child.on('message', (message) => {
      if (message?.protocol !== 1 || message.token !== token) return;
      const result = message.result;
      if (result && Array.isArray(result.families) && Array.isArray(result.manifests) && Array.isArray(result.generators) && Array.isArray(result.loadedFiles) && Array.isArray(result.diagnostics)) reply = result;
      else reply = failure('load-failed', 'Family loader returned an invalid result');
    });
    // Waiting for exit also captures logs written after a premature process.send().
    child.once('close', (code, signal) => {
      if (reply && code === 0) {
        if (output) for (const item of reply.diagnostics) if (item.code === 'load-failed') item.message += `\nChild output (tail):\n${output}`;
        finish(reply);
      } else finish(failure('load-failed', `Family loader exited ${signal || code} without a successful result`));
    });
    child.send({ protocol: 1, token, root, paths, config, kernelUrl, ...(generate ? { generate } : {}) }, (error) => { if (error) { child.kill('SIGKILL'); finish(failure('load-failed', error.message)); } });
  });
}

/** Execute repository code in a fresh child; only JSON data crosses the boundary. */
export async function loadFamilies({ root: inputRoot, config, paths, resolutionSignature, fileHashes = {}, generate } = {}) {
  const root = await realpath(resolve(inputRoot));
  if (config === undefined) {
    try { config = JSON.parse(await readFile(join(root, '.blocks/config.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') return { key: '', ...empty([{ rule: 'config-valid', code: 'family-path-invalid', severity: 'error', file: '.blocks/config.json', field: '$', message: error.message }]) };
      config = {};
    }
  }
  const parsed = parseFamiliesConfig(config);
  if (parsed.diagnostics.some((item) => item.field === '$.loader')) return { key: '', ...empty(parsed.diagnostics), ...(generate ? { outputs: [] } : {}) };
  // Discover non-source input kinds and configured .blocks paths even when the
  // scanner passes only source paths. Preserve that exact list for A ownership.
  let discovered;
  try { discovered = await discoverFiles(root); }
  catch (error) { return { key: '', ...empty([...parsed.diagnostics, { rule: 'manifest-valid', code: error.code === 'FAMILY_FILE_LIMIT' ? 'loader-file-limit' : 'load-failed', severity: 'error', file: '.', message: error.message }]), ...(generate ? { outputs: [] } : {}) }; }
  const matchingPaths = [...new Set([...discovered, ...(paths || [])])].sort();
  const resolverPaths = paths === undefined ? discovered : paths;
  // Config ignore keeps ignored files from loading as manifests; the project-model matcher is only needed when patterns exist.
  const ignored = Array.isArray(config?.ignore) && config.ignore.length ? (await import('../project-model.mjs')).ignoreMatcher(config.ignore) : () => false;
  const manifestCandidates = matchingPaths.filter((path) => !ignored(path));
  const matched = parsed.families.flatMap((entry) => matchManifests(manifestCandidates, entry));
  const direct = [...parsed.families.map((entry) => entry.contract), ...parsed.families.flatMap((entry) => entry.generators || []), ...parsed.generators, ...(Array.isArray(config.checks) ? config.checks.filter(isFamilyPath) : []), ...[historyLabelModule(config)].filter(Boolean), ...matched];
  const state = rootCache(root);
  let loaderUrl;
  try { loaderUrl = await resolveLoader(root, parsed.loader); }
  catch (error) { return { key: '', ...empty([...parsed.diagnostics, { rule: 'config-valid', code: 'loader-package-missing', severity: 'error', file: '.blocks/config.json', field: '$.loader', message: `Cannot resolve loader package ${config.loader}: ${error.message}` }]) }; }
  const labelFiles = historyLabelModule(config) ? state.labelFiles ?? [] : [];
  const tracked = [...new Set([...state.loadedFiles, ...labelFiles, ...direct])].sort();
  const hashes = await contentHashes(root, tracked, fileHashes);
  const key = cacheKey({ config, resolutionSignature, matched, hashes, loaderUrl, paths: matchingPaths });
  if (!generate && state.results.has(key)) return structuredClone(state.results.get(key));
  if (!generate && state.inflight.has(key)) return structuredClone(await state.inflight.get(key));
  const load = async () => {
    if (!parsed.families.length && !parsed.generators.length && !(Array.isArray(config.checks) && config.checks.length) && !historyLabelModule(config)) return { key, ...empty(parsed.diagnostics), discoveredFiles: matchingPaths, ...(generate ? { outputs: [] } : {}) };
    // The worker gets both the exact resolver ownership list and discovery inputs.
    const result = await spawnLoad({ root, paths: resolverPaths, config, generate, loaderUrl });
    state.loadedFiles = [...new Set([...result.loadedFiles, ...Object.keys(result.fileHashes || {})])];
    // The hook hashes the exact bytes supplied to Node. Re-reading here could
    // cache an older evaluated value under newer bytes saved while it was loading.
    const initialHashes = new Map(hashes.map((item) => [item[0], item]));
    const finalHashes = [...new Set([...direct, ...labelFiles, ...state.loadedFiles])].sort().map((path) => [path, result.fileHashes?.[path] ?? initialHashes.get(path)?.[1] ?? 'missing:unread', fileHashes[path] ?? null]);
    const finalKey = cacheKey({ config, resolutionSignature, matched, hashes: finalHashes, loaderUrl, paths: matchingPaths });
    const { cacheable, labelFiles: reachedByLabel, ...publicResult } = result;
    // Kept across ordinary loads: the label module is only evaluated in a generate pass, but editing what it reads must move the key.
    if (reachedByLabel) state.labelFiles = reachedByLabel;
    const completed = { key: finalKey, ...publicResult, discoveredFiles: matchingPaths };
    if (!generate && cacheable !== false) {
      state.results.set(finalKey, structuredClone(completed));
      while (state.results.size > 4) state.results.delete(state.results.keys().next().value);
    }
    return completed;
  };
  const pending = load();
  if (!generate) state.inflight.set(key, pending);
  try { return structuredClone(await pending); }
  finally { if (!generate) state.inflight.delete(key); }
}
