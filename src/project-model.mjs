import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { realpathSync, existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname, basename, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { readProjectFile, writeProjectFiles } from './project-files.mjs';
import { builtinModules } from 'node:module';

const excluded = new Set(['node_modules', '.git', '.blocks', '.next', 'dist', 'build', 'coverage', 'vendor', '.turbo', '.vercel']);
const slash = (path) => path.replaceAll('\\', '/');
const defaults = { allowJs: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.Latest, resolveJsonModule: true };
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const message = (error) => ts.flattenDiagnosticMessageText(error.messageText, '\n');
const within = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); };
const safePath = (root, path) => typeof path === 'string' && within(root, resolve(root, path));
const packageName = (specifier) => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
// TypeScript does not resolve these, so they are recognized as assets by file lookup instead.
const ASSET_EXTENSIONS = /\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|ogg)$/i;
const ASSET_OR_JSON = /\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|ogg|json)$/i;
const EXPORT_CONDITIONS = ['style', 'browser', 'import', 'require', 'module', 'default'];

function isFile(path) { try { return statSync(path).isFile(); } catch { return false; } }
/** Package.json export targets for a subpath, in preference order. Empty means the subpath is not exported. */
function exportTargets(exports, subpath) {
  if (exports === undefined || exports === null) return [];
  const entries = typeof exports === 'object' && !Array.isArray(exports) ? Object.keys(exports) : [];
  const map = entries.length && entries.every((key) => key.startsWith('.')) ? exports : { '.': exports };
  let value, capture = '';
  if (Object.hasOwn(map, subpath) && !subpath.includes('*')) value = map[subpath];
  else {
    const pattern = Object.keys(map).filter((key) => {
      if (!key.includes('*')) return false;
      const [prefix, suffix] = key.split('*');
      return subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length;
    }).sort((a, b) => b.split('*')[0].length - a.split('*')[0].length || b.length - a.length)[0]; // Node: longer prefix, then longer whole key
    if (!pattern) return [];
    const [prefix, suffix] = pattern.split('*');
    capture = subpath.slice(prefix.length, subpath.length - suffix.length); value = map[pattern];
  }
  const targets = [];
  (function collect(item) {
    if (typeof item === 'string') targets.push(item.replaceAll('*', capture));
    else if (Array.isArray(item)) item.forEach(collect);
    else if (item && typeof item === 'object') for (const condition of EXPORT_CONDITIONS) if (Object.hasOwn(item, condition)) collect(item[condition]);
  })(value);
  return targets;
}
/** Resolve a bare package asset specifier such as `reactflow/dist/style.css` through node_modules and package exports. */
export function resolvePackageAsset(specifier, containingFile, repoRoot) {
  const name = packageName(specifier), rest = specifier.slice(name.length);
  let packageDir = null;
  for (let directory = dirname(containingFile); ; directory = dirname(directory)) {
    const manifest = join(directory, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) { try { packageDir = realpathSync.native(dirname(manifest)); } catch { packageDir = dirname(manifest); } break; }
    if (dirname(directory) === directory) break;
  }
  if (!packageDir) return { ok: false, reason: 'no-package' };
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) || {}; } catch { /* unreadable manifest behaves as one without exports */ }
  const candidates = manifest.exports === undefined ? [`.${rest}`] : exportTargets(manifest.exports, `.${rest}`);
  const files = candidates.filter((target) => typeof target === 'string' && target.startsWith('./')).map((target) => resolve(packageDir, target)).filter((path) => within(packageDir, path));
  if (!files.length) return { ok: false, reason: manifest.exports === undefined ? 'missing' : 'not-exported' };
  const file = files.find(isFile);
  return file ? { ok: true, file } : { ok: false, reason: 'missing' };
}

function patternRegex(pattern) {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; result += '(?:.*/)?'; } else result += '.*'; }
    else if (char === '*') result += '[^/]*';
    else if (char === '?') result += '[^/]';
    else result += char.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return new RegExp(`${result}$`);
}
function matches(path, patterns = []) {
  let matched = false;
  for (const pattern of patterns) { if (typeof pattern !== 'string') continue; const negative = pattern.startsWith('!'); if (patternRegex(negative ? pattern.slice(1) : pattern).test(path)) matched = !negative; }
  return matched;
}
/** Build the config `ignore` matcher so every consumer shares the project-model semantics. */
export function ignoreMatcher(patterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  return (path) => matches(path, list);
}
async function json(path, fallback = null) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
async function inventory(root) {
  const configs = [], packages = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(entry.name)) await walk(join(dir, entry.name));
      else if (entry.isFile()) { const path = slash(relative(root, join(dir, entry.name))); if (entry.name === 'tsconfig.json') configs.push(path); if (entry.name === 'package.json') packages.push(path); }
    }
  }
  await walk(root); return { configs: configs.sort(), packages: packages.sort() };
}
function parseConfig(root, path) {
  const absolute = resolve(root, path);
  const read = ts.readConfigFile(absolute, ts.sys.readFile);
  if (read.error) return { options: defaults, fileNames: [], errors: [message(read.error)] };
  if (!read.config || typeof read.config !== 'object' || Array.isArray(read.config)) return { options: defaults, fileNames: [], errors: ['tsconfig must be an object'] };
  try {
    const boundaryErrors = [];
    const configHost = { ...ts.sys, readDirectory(directory, extensions, excludes, includes, depth) {
      if (!within(root, resolve(directory))) { boundaryErrors.push('tsconfig include directory is outside the repository'); return []; }
      const boundedIncludes = (includes || ['**/*']).filter((pattern) => {
        const base = pattern.split(/[*?]/)[0];
        if (!within(root, resolve(directory, base))) { boundaryErrors.push(`tsconfig include '${pattern}' is outside the repository`); return false; }
        return true;
      });
      if (!boundedIncludes.length) return [];
      const files = ts.sys.readDirectory(directory, extensions, excludes, boundedIncludes, depth);
      if (files.length > 20000) throw new Error('Source limit exceeded (20000 files) while parsing tsconfig');
      return files.filter((path) => { try { return within(root, realpathSync.native(path)); } catch { return false; } });
    } };
    const parsed = ts.parseJsonConfigFileContent(read.config, configHost, dirname(absolute), undefined, absolute);
    return { options: parsed.options, fileNames: parsed.fileNames, errors: [...parsed.errors.filter((error) => error.code !== 18003).map(message), ...new Set(boundaryErrors)], references: parsed.projectReferences };
  } catch (error) { return { options: defaults, fileNames: [], errors: [`Cannot parse tsconfig: ${error.message}`] }; }
}
async function detect(root, paths) {
  const { configs, packages } = await inventory(root);
  const rootPackage = await json(join(root, 'package.json'), {});
  let workspacePatterns = Array.isArray(rootPackage?.workspaces) ? rootPackage?.workspaces : rootPackage?.workspaces?.packages || [];
  try {
    const yaml = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
    const section = yaml.match(/^packages:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] || '';
    workspacePatterns = section.split('\n').map((line) => line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/)?.[1]?.trim()).filter(Boolean);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const roots = new Map(), parsedConfigs = new Map();
  for (const config of configs) {
    const parsed = parseConfig(root, config); parsedConfigs.set(config, parsed);
    if (parsed.fileNames.length || parsed.errors.length) roots.set(slash(dirname(config)), { tsconfig: config });
  }
  for (const packagePath of packages) {
    const folder = slash(dirname(packagePath));
    if (folder !== '.' && matches(folder, workspacePatterns)) roots.set(folder, { ...roots.get(folder) });
  }
  if (paths.some((path) => ![...roots.keys()].some((folder) => folder !== '.' && path.startsWith(`${folder}/`)))) roots.set('.', { ...roots.get('.') });
  const ids = new Set();
  const apps = [...roots].sort(([a], [b]) => a.localeCompare(b)).map(([folder, details]) => {
    const stem = folder === '.' ? basename(root) : basename(folder); let id = stem, number = 2;
    while (ids.has(id)) id = `${stem}-${number++}`; ids.add(id);
    return { id, root: folder, ...details, source: 'detected' };
  });
  const metadata = await Promise.all(packages.map(async (path) => [path, await readFile(join(root, path), 'utf8')]));
  const packageStamp = (name, path) => {
    try { const info = statSync(join(path, 'package.json')); metadata.push([name, realpathSync.native(path), info.mtimeMs, info.size]); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  try {
    for (const entry of await readdir(join(root, 'node_modules'), { withFileTypes: true })) {
      const packagePath = join(root, 'node_modules', entry.name);
      if (entry.isDirectory() && entry.name.startsWith('@')) {
        for (const child of await readdir(packagePath, { withFileTypes: true })) packageStamp(`${entry.name}/${child.name}`, join(packagePath, child.name));
      } else if (!entry.name.startsWith('.')) packageStamp(entry.name, packagePath);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  metadata.sort(([a], [b]) => a.localeCompare(b));
  return { apps, parsedConfigs, metadata };
}

/** Propose additive app detection; existing entries remain owner controlled. */
export async function detectProjectApps(inputRoot, { paths = [], write = false } = {}) {
  const root = realpathSync.native(resolve(inputRoot)), configPath = join(root, '.blocks/config.json'), statePath = join(root, '.blocks/detection.json');
  const diagnostics = [];
  let original, before;
  try { before = await readProjectFile(root, '.blocks/config.json'); original = before === null ? null : JSON.parse(before); } catch (error) { if (/symlink|independent regular|not a directory/.test(error.message)) throw error; return { config: { schemaVersion: 1, apps: [] }, added: [], disappeared: [], diagnostics: [{ app: null, field: 'config', message: `Cannot read .blocks/config.json: ${error.message}` }] }; }
  const fallback = { schemaVersion: 1, apps: [], ignore: [] };
  if (before !== null && (!original || typeof original !== 'object' || Array.isArray(original))) return { config: fallback, added: [], disappeared: [], diagnostics: [{ app: null, field: 'config', message: '.blocks/config.json must be an object' }] };
  const config = original ? structuredClone(original) : fallback;
  if (!Array.isArray(config.apps)) return { config, added: [], disappeared: [], diagnostics: [{ app: null, field: 'apps', message: 'config.apps must be an array' }] };
  const invalidApp = config.apps.findIndex((app) => !app || typeof app !== 'object' || Array.isArray(app));
  if (invalidApp !== -1) return { config, added: [], disappeared: [], diagnostics: [{ app: null, field: `apps[${invalidApp}]`, message: 'App entry must be an object' }] };
  const existingConfig = structuredClone(config);
  const { apps: detected, parsedConfigs, metadata } = await detect(root, paths);
  const stateBefore = await readProjectFile(root, '.blocks/detection.json');
  let state; try { state = stateBefore ? JSON.parse(stateBefore) : { schemaVersion: 1, apps: {} }; } catch { state = { schemaVersion: 1, apps: {} }; }
  const disappeared = [];
  for (const app of config.apps) {
    const previous = state?.apps?.[app.root];
    if (app.source === 'detected' && previous && JSON.stringify(app) !== JSON.stringify(previous)) app.source = 'config';
    if (app.source === 'config' ? !safePath(root, app.root) || !existsSync(resolve(root, app.root)) : !detected.some((candidate) => candidate.root === app.root)) disappeared.push(app);
  }
  const added = detected.filter((candidate) => !config.apps.some((app) => app.root === candidate.root));
  const ids = new Set(config.apps.map((app) => app.id));
  for (const app of added) { const stem = app.id; let number = 2; while (ids.has(app.id)) app.id = `${stem}-${number++}`; ids.add(app.id); config.apps.push(app); }
  if (write) {
    const snapshots = { ...state?.apps }; for (const app of added) snapshots[app.root] = app;
    await writeProjectFiles(root, [
      { path: '.blocks/config.json', before, content: `${JSON.stringify(config, null, 2)}\n` },
      { path: '.blocks/detection.json', before: stateBefore, content: `${JSON.stringify({ schemaVersion: 1, apps: snapshots }, null, 2)}\n` },
    ]);
  }
  return { config, added, disappeared, diagnostics, parsedConfigs, metadata, existingConfig };
}

async function detectEntries(root, app, paths) {
  const found = new Set(app.entries);
  const prefix = app.root === '.' ? '' : `${app.root}/`;
  const localPaths = paths.filter((path) => path.startsWith(prefix));
  for (const path of localPaths) {
    const local = path.slice(prefix.length);
    if (/^(?:src\/)?app\/(?:.*\/)?(?:page|layout|route|default|error|loading|not-found|global-error|template)\.[cm]?[jt]sx?$/.test(local) ||
        /^(?:src\/)?pages\/.*\.[cm]?[jt]sx?$/.test(local) || /^(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]sx?$/.test(local)) found.add(path);
  }
  const add = (value) => { if (typeof value === 'string') { const path = slash(relative(root, resolve(root, app.root, value))); if (paths.includes(path)) found.add(path); } else if (value && typeof value === 'object') for (const child of Object.values(value)) add(child); };
  try { const pkg = await json(resolve(root, app.root, 'package.json'), {}); add(pkg.main); add(pkg.bin); add(pkg.exports); } catch (error) { app.errors.push(`package.json: ${error.message}`); }
  for (const name of ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']) {
    try {
      const text = await readFile(resolve(root, app.root, name), 'utf8');
      if (name.endsWith('.toml')) add(text.match(/^\s*main\s*=\s*["']([^"']+)["']/m)?.[1]);
      else { const parsed = ts.parseConfigFileTextToJson(name, text); if (!parsed.error) add(parsed.config.main); }
    } catch (error) { if (error.code !== 'ENOENT') app.errors.push(`${name}: ${error.message}`); }
  }
  return [...found].sort();
}

/** Parse each app once and resolve imports using the owning app's compiler options. */
export async function loadProjectModel(inputRoot, { paths = [], writeConfig = true, strict = false } = {}) {
  const root = realpathSync.native(resolve(inputRoot));
  const initial = !existsSync(join(root, '.blocks/config.json'));
  const result = await detectProjectApps(root, { paths, write: writeConfig && initial });
  // An existing config only grows through the explicit detect --write command.
  if (!initial && result.existingConfig) result.config = result.existingConfig;
  const config = result.config, diagnostics = [...result.diagnostics], apps = [], ownerByFile = new Map(paths.map((path) => [path, null]));
  const parsedConfigs = result.parsedConfigs || new Map();
  const getParsed = (path) => { if (!parsedConfigs.has(path)) parsedConfigs.set(path, parseConfig(root, path)); return parsedConfigs.get(path); };
  const rootParsed = existsSync(join(root, 'tsconfig.json')) ? getParsed('tsconfig.json') : { options: defaults };
  if (config.schemaVersion !== 1) diagnostics.push({ app: null, field: 'schemaVersion', message: 'Supported config schemaVersion is 1' });
  if (!Array.isArray(config.apps)) diagnostics.push({ app: null, field: 'apps', message: 'config.apps must be an array' });
  if (config.ignore !== undefined && (!Array.isArray(config.ignore) || config.ignore.some((item) => typeof item !== 'string'))) diagnostics.push({ app: null, field: 'ignore', message: 'config.ignore must be an array of patterns' });
  const ids = new Set();
  for (const entry of Array.isArray(config.apps) ? config.apps : []) {
    const errors = [];
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) { diagnostics.push({ app: entry?.id ?? null, field: 'id', message: 'App id must be a unique nonempty string' }); continue; }
    ids.add(entry.id);
    if (!safePath(root, entry.root)) { diagnostics.push({ app: entry.id, field: 'root', message: 'App root must stay inside the repository' }); continue; }
    const appRoot = resolve(root, entry.root);
    if (existsSync(appRoot) && (!statSync(appRoot).isDirectory() || !within(root, realpathSync.native(appRoot)))) errors.push('root: must be a directory inside the repository');
    if (!existsSync(appRoot)) errors.push('root: directory does not exist');
    let parsed;
    if (entry.tsconfig !== undefined) {
      if (!safePath(root, entry.tsconfig)) errors.push('tsconfig: path must stay inside the repository');
      else if (!existsSync(resolve(root, entry.tsconfig))) errors.push('tsconfig: file does not exist');
      else { parsed = getParsed(entry.tsconfig); errors.push(...parsed.errors.map((error) => `tsconfig: ${error}`)); }
    }
    const compilerOptions = errors.length ? rootParsed.options : parsed?.options || defaults;
    const fileNames = parsed && !errors.length ? new Set(parsed.fileNames.filter((path) => within(root, path)).map((path) => slash(relative(root, path)))) : new Set(paths.filter((path) => within(appRoot, resolve(root, path))));
    const entries = Array.isArray(entry.entries) ? entry.entries.filter((path) => safePath(root, path)) : [];
    if (entry.entries !== undefined && (!Array.isArray(entry.entries) || entries.length !== entry.entries.length)) errors.push('entries: must contain repository-relative paths');
    const app = { ...entry, root: slash(entry.root), entries, compilerOptions, fileNames, references: parsed?.references || [], packages: [], errors };
    app.entries = await detectEntries(root, app, paths);
    app.cache = ts.createModuleResolutionCache(root, (path) => path, compilerOptions);
    apps.push(app); for (const error of errors) diagnostics.push({ app: app.id, field: error.split(':')[0], message: error });
  }
  for (const app of [...apps].sort((a, b) => a.root.split('/').length - b.root.split('/').length || (a.root === '.' ? -1 : 1))) {
    for (const path of paths) if (app.fileNames.has(path)) ownerByFile.set(path, app.id);
  }
  const outside = { compilerOptions: rootParsed.options, cache: ts.createModuleResolutionCache(root, (path) => path, rootParsed.options), packages: [] };
  const host = { ...ts.sys, realpath: (path) => { try { return slash(realpathSync.native(path)); } catch { return path; } } };
  function resolveImport(from, specifier, { mode } = {}) {
    const app = apps.find((candidate) => candidate.id === ownerByFile.get(from)) || outside;
    if (builtins.has(specifier.replace(/^node:/, ''))) return { external: true, package: specifier };
    const containingFile = resolve(root, from);
    const resolutionMode = mode === 'import' ? ts.ModuleKind.ESNext : mode === 'require' ? ts.ModuleKind.CommonJS : ts.getImpliedNodeFormatForFile(containingFile, undefined, host, app.compilerOptions);
    const resolved = ts.resolveModuleName(specifier, containingFile, app.compilerOptions, host, app.cache, undefined, resolutionMode).resolvedModule;
    if (!resolved) {
      // TypeScript intentionally does not resolve arbitrary assets. Recognize only
      // an existing asset via relative paths, configured aliases or a package in
      // node_modules, keeping compiler resolution authoritative for code.
      if (ASSET_OR_JSON.test(specifier)) {
        const candidates = [];
        if (specifier.startsWith('.')) candidates.push(resolve(dirname(containingFile), specifier));
        else {
          const options = app.compilerOptions;
          const matchingPaths = Object.keys(options.paths || {}).filter((pattern) => {
            if (!pattern.includes('*')) return pattern === specifier;
            const [prefix, suffix] = pattern.split('*'); return specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length;
          }).sort((a, b) => Number(b === specifier) - Number(a === specifier) || b.split('*')[0].length - a.split('*')[0].length || b.length - a.length);
          const pattern = matchingPaths[0];
          if (pattern) {
            const [prefix, suffix = ''] = pattern.split('*');
            const matched = pattern.includes('*') ? specifier.slice(prefix.length, suffix ? -suffix.length : undefined) : '';
            const base = options.baseUrl || options.pathsBasePath || root;
            for (const target of options.paths[pattern]) candidates.push(resolve(base, target.replace('*', matched)));
          }
          if (options.baseUrl) candidates.push(resolve(options.baseUrl, specifier));
        }
        for (const asset of candidates) if (existsSync(asset)) {
          if (!within(root, realpathSync.native(asset))) return { error: `Import '${specifier}' resolves outside the repository` };
          if (statSync(asset).isFile()) return { external: true, asset: slash(relative(root, asset)) };
        }
        let reason = 'missing';
        if (!specifier.startsWith('.') && !isAbsolute(specifier)) {
          const found = resolvePackageAsset(specifier, containingFile, root);
          const name = packageName(specifier);
          if (found.ok) { if (!app.packages.includes(name)) app.packages.push(name); return { external: true, package: name, asset: specifier }; }
          if (found.reason !== 'no-package' || !candidates.length) reason = found.reason;
        }
        return { error: `Cannot resolve asset '${specifier}' (${reason})`, category: 'asset' };
      }
      return { error: `Cannot resolve '${specifier}'` };
    }
    let absolute = resolved.resolvedFileName; try { absolute = realpathSync.native(absolute); } catch { /* compiler supplied a virtual path */ }
    if (within(root, absolute) && !slash(relative(root, absolute)).split('/').includes('node_modules')) return ASSET_OR_JSON.test(absolute) ? { external: true } : { path: slash(relative(root, absolute)) };
    if (specifier.startsWith('.') || isAbsolute(specifier)) return { error: `Import '${specifier}' resolves outside the repository` };
    const name = packageName(specifier); if (!app.packages.includes(name)) app.packages.push(name);
    return { external: true, package: name };
  }
  if (strict && diagnostics.length) throw new Error(diagnostics.map((item) => `${item.app || 'config'} ${item.field}: ${item.message}`).join('\n'));
  const resolutionSignature = createHash('sha256').update(JSON.stringify({ config, metadata: result.metadata, apps: apps.map((app) => ({ id: app.id, root: app.root, compilerOptions: app.compilerOptions })), paths })).digest('hex');
  return { resolutionSignature, config, apps, ownerByFile, diagnostics, resolveImport, isIgnored: ignoreMatcher(config.ignore) };
}
