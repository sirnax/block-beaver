import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isSchema, validateManifest } from '../kernel/index.mjs';
import { loadProjectModel } from '../project-model.mjs';
import { parseFamiliesConfig, isFamilyGlob, isFamilyPath } from './config.mjs';
import { canonicalJson, manifestHash } from './canonical.mjs';
import { captureManifestId, discoverFiles, matchGlobs } from './glob.mjs';
import { assertSafeSource, installFamilyHooks, runtimeSourcePath } from './hooks.mjs';

const coreKeys = new Set(['id', 'family', 'version', 'name', 'description', 'rationale', 'implementation', 'files']);
const idPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const blockIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// File ownership, import resolution and symbol relationships consume these kinds.
// A typed block link may use depends-on, which is a block dependency already.
const reservedLinkKinds = new Set(['implemented-by', 'declares', 'imports', 'reexports', 'calls', 'renders', 'dynamic-import', 'require']);
const requireCache = createRequire(import.meta.url).cache;

function runtimeExports(namespace, absolute) {
  const commonjs = requireCache[absolute];
  if (!commonjs) return namespace;
  const value = commonjs.exports;
  if (object(value) && !('id' in value && 'family' in value)) {
    return Object.fromEntries(Object.keys(value).filter((name) => name !== '__esModule').map((name) => [name, value[name]]));
  }
  return { default: value };
}

function readonly(value, seen = new Set()) {
  if ((value === null || !['object', 'function'].includes(typeof value)) || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) readonly(child, seen);
  return Object.freeze(value);
}

function jsonCopy(value) {
  const copy = JSON.parse(JSON.stringify(value));
  if (!isDeepStrictEqual(copy, value)) throw new TypeError('Value must contain only plain JSON data');
  return copy;
}

function linkSchema(fields, path) {
  if (typeof path !== 'string' || !path) return false;
  const pieces = path.split('.');
  let schema = fields;
  for (const piece of pieces) {
    const match = /^([^.[\]]+)((?:\[\])*)$/.exec(piece);
    if (!match || schema?.type !== 'object' || !object(schema.shape) || !Object.hasOwn(schema.shape, match[1])) return false;
    schema = schema.shape[match[1]];
    for (let index = 0; index < match[2].length / 2; index++) {
      if (schema?.type !== 'array') return false;
      schema = schema.items;
    }
    if (schema?.type === 'array') return false;
  }
  return true;
}

function contractProblems(definition, entry, configured) {
  const issues = [];
  const issue = (code, message, field) => issues.push({ code, message, field });
  if (!object(definition) || definition[Symbol.for('block-beaver.family')] !== true) {
    issue('contract-invalid', 'Contract default must be created with defineFamily()', '$');
    return issues;
  }
  if (definition.id !== entry.id) issue('contract-id-mismatch', `Contract ID must equal configured family ${entry.id}`, '$.id');
  if (!isSchema(definition.fields) || definition.fields?.type !== 'object') issue('contract-invalid', 'Family fields must be an object schema', '$.fields');
  else for (const key of Object.keys(definition.fields.shape)) if (coreKeys.has(key)) issue('contract-reserved-field', `Family field ${key} is a reserved core manifest field`, `$.fields.shape.${key}`);
  if (!Array.isArray(definition.implementation) || !definition.implementation.length || definition.implementation.some((kind) => !['module', 'none'].includes(kind)) || new Set(definition.implementation).size !== definition.implementation.length) issue('contract-invalid', 'implementation must be a nonempty list of module and/or none', '$.implementation');
  if (definition.check !== undefined && typeof definition.check !== 'function') issue('contract-invalid', 'check must be a function', '$.check');
  if (definition.generators !== undefined && (!Array.isArray(definition.generators) || definition.generators.some((name) => !['registry', 'index', 'history'].includes(name)) || new Set(definition.generators).size !== definition.generators.length)) issue('contract-invalid', 'Contract generators may request registry, index and history once each', '$.generators');
  if (Array.isArray(definition.generators) && definition.generators.includes('registry') && !entry.registry?.out) issue('registry-out-missing', 'Family requesting registry must configure registry.out', '$.registry.out');
  if (definition.links !== undefined) {
    if (!Array.isArray(definition.links)) issue('link-path-invalid', 'links must be an array', '$.links');
    else for (const [index, link] of definition.links.entries()) {
      if (!object(link) || !linkSchema(definition.fields, link.field)) issue('link-path-invalid', 'Link field must walk the schema, marking every array with []', `$.links[${index}].field`);
      const targets = typeof link?.to === 'string' ? [link.to] : link?.to;
      if (!Array.isArray(targets) || !targets.length || targets.some((id) => !configured.has(id)) || new Set(targets).size !== targets.length) issue('link-target-family', 'Link targets must name configured families', `$.links[${index}].to`);
      if (typeof link?.kind !== 'string' || !idPattern.test(link.kind)) issue('contract-invalid', 'Link kind must be kebab-case', `$.links[${index}].kind`);
      else if (reservedLinkKinds.has(link.kind)) issue('contract-invalid', `Link kind ${link.kind} is reserved for source graph relationships`, `$.links[${index}].kind`);
    }
  }
  if (definition.map !== undefined && (!object(definition.map) || ['title', 'blurb'].some((key) => definition.map[key] !== undefined && typeof definition.map[key] !== 'string'))) issue('contract-invalid', 'map title and blurb must be strings', '$.map');
  if (definition.scaffold !== undefined) {
    const scaffold = definition.scaffold;
    if (!object(scaffold) || !Array.isArray(scaffold.files) || !scaffold.files.length || scaffold.files.some((file) => !object(file) || !isFamilyPath(file.path) || typeof file.template !== 'string') || (scaffold.manualSteps !== undefined && (!Array.isArray(scaffold.manualSteps) || scaffold.manualSteps.some((step) => typeof step !== 'string')))) issue('contract-invalid', 'scaffold must contain safe file paths, templates and optional string manual steps', '$.scaffold');
  }
  try {
    const { check, ...serializable } = definition;
    jsonCopy(serializable);
  } catch { issue('contract-invalid', 'Contract metadata other than check must contain only JSON data', '$'); }
  return issues;
}

async function execute(message) {
  const { root, config, kernelUrl, generate } = message;
  const result = { families: [], manifests: [], generators: [], loadedFiles: [], fileHashes: {}, cacheable: true, diagnostics: [], ...(generate ? { outputs: [] } : {}) };
  const parsed = parseFamiliesConfig(config);
  result.diagnostics.push(...parsed.diagnostics);
  const loadedFiles = new Set(), sourceHashes = new Map(), dependencies = new Map(), definitions = new Map(), generatorFunctions = new Map();
  const discovered = await discoverFiles(root);
  const paths = message.paths ?? discovered;
  const manifestPaths = [...new Set([...discovered, ...paths])].sort();
  const diagnostic = (code, message, context = {}, rule = 'manifest-valid') => {
    const item = { rule, code, severity: 'error', message, ...context };
    result.diagnostics.push(item);
    return item;
  };
  const errorDiagnostic = (error, context) => diagnostic(error.familyLoaderCode || (error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' ? 'non-strippable-syntax' : error.code === 'ERR_MODULE_NOT_FOUND' ? 'unresolved-import' : 'load-failed'), error.message || String(error), { ...context, ...(error.familyLoaderFile ? { file: error.familyLoaderFile } : {}) });
  let hooks;
  try {
    if (parsed.diagnostics.some((item) => item.field === '$.loader')) return result;
    const project = await loadProjectModel(root, { paths, writeConfig: false });
    if (!parsed.loader) {
      try { hooks = installFamilyHooks({ root, project, kernelUrl, loadedFiles, sourceHashes, dependencies }); }
      catch (error) { errorDiagnostic(error, {}); return result; }
    } else {
      // A third-party loader owns its source reads. Snapshot all possible repo
      // inputs before evaluation, and cache only if that snapshot remains stable.
      for (const path of discovered) {
        try { sourceHashes.set(path, createHash('sha256').update(await readFile(assertSafeSource(root, path))).digest('hex')); }
        catch (error) { result.cacheable = false; errorDiagnostic(error, { file: path }); }
      }
    }
    const importSource = async (path) => {
      assertSafeSource(root, path);
      loadedFiles.add(path);
      const absolute = join(root, path);
      const namespace = await import(pathToFileURL(absolute).href);
      return parsed.loader ? runtimeExports(namespace, absolute) : namespace;
    };
    const configured = new Set(parsed.families.map((family) => family.id));
    for (const entry of parsed.families) {
      try {
        const exports = await importSource(entry.contract);
        if (!Object.hasOwn(exports, 'default')) { diagnostic('contract-default-missing', 'Family contract must have a default export', { file: entry.contract, family: entry.id }); continue; }
        const definition = exports.default;
        const issues = contractProblems(definition, entry, configured);
        for (const item of issues) diagnostic(item.code, item.message, { file: entry.contract, family: entry.id, field: item.field }, item.code === 'registry-out-missing' ? 'config-valid' : 'manifest-valid');
        if (issues.length) continue;
        definitions.set(entry.id, definition);
        const { check, ...metadata } = definition;
        const { floor, ...familyConfig } = entry;
        result.families.push({ ...jsonCopy(metadata), hasCheck: typeof check === 'function', config: familyConfig, floor });
      } catch (error) { errorDiagnostic(error, { file: entry.contract, family: entry.id }); }
    }
    const candidates = parsed.families.flatMap((entry) => matchGlobs(manifestPaths, [entry.manifests]).map((path) => ({ entry, path }))).sort((a, b) => compare(a.path, b.path) || a.entry.floor - b.entry.floor);
    const manifestRefs = new Set();
    for (const { entry, path } of candidates) {
      const definition = definitions.get(entry.id);
      if (!definition) continue;
      try {
        const exports = await importSource(path), names = Object.keys(exports);
        if (names.length !== 1) { diagnostic('manifest-export-count', `Manifest must have exactly one runtime export; found ${names.length}`, { file: path, family: entry.id }); continue; }
        const exportName = names[0], manifest = exports[exportName];
        let value;
        try { value = jsonCopy(manifest); }
        catch { diagnostic('manifest-not-json', 'Manifest must survive a JSON round trip without functions, undefined, cycles or non-JSON objects', { file: path, family: entry.id, field: '$' }); continue; }
        if (!object(value) || !blockIdPattern.test(value.id || '') || value.id !== captureManifestId(path, entry.manifests)) { diagnostic('manifest-id-mismatch', `Manifest ID must match the last * in ${entry.manifests}`, { file: path, family: entry.id, field: '$.id' }); continue; }
        const ref = `${entry.id}:${value.id}`, context = { file: path, family: entry.id, block: ref };
        if (value.family !== entry.id) { diagnostic('manifest-family-mismatch', `Manifest family must equal ${entry.id}`, { ...context, field: '$.family' }); continue; }
        if (!definition.implementation.includes(value.implementation?.kind)) { diagnostic('implementation-kind-forbidden', `Implementation kind ${value.implementation?.kind ?? '(missing)'} is not allowed by family ${entry.id}`, { ...context, field: '$.implementation.kind' }); continue; }
        const validation = validateManifest(value, { mode: 'build', family: definition });
        if (!validation.valid) {
          for (const issue of validation.errors) diagnostic('manifest-schema', issue.message, { ...context, field: issue.path });
          continue;
        }
        if (manifestRefs.has(ref)) { diagnostic('block-duplicate', `Duplicate block ${ref}`, context); continue; }
        manifestRefs.add(ref);
        result.manifests.push({ family: entry.id, id: value.id, ref, graphId: `block:${ref}`, path, exportName, value, hash: manifestHash(value) });
      } catch (error) { errorDiagnostic(error, { file: path, family: entry.id }); }
    }
    result.manifests.sort((a, b) => parsed.families.findIndex((family) => family.id === a.family) - parsed.families.findIndex((family) => family.id === b.family) || compare(a.id, b.id));
    const values = new Map(result.manifests.map((manifest) => [manifest.ref, readonly(manifest.value)]));
    const rejected = new Set();
    for (const manifest of result.manifests) {
      const check = definitions.get(manifest.family)?.check;
      if (!check) continue;
      try {
        const issues = check(manifest.value, readonly({ family: manifest.family, get: (ref) => values.get(ref) }));
        if (issues !== undefined && (!Array.isArray(issues) || issues.some((issue) => !object(issue) || typeof issue.path !== 'string' || typeof issue.message !== 'string' || (issue.code !== undefined && typeof issue.code !== 'string')))) throw new TypeError('Family check must return an array of {path,message,code?} or undefined');
        for (const issue of issues || []) diagnostic('family-check-failed', issue.message, { file: manifest.path, family: manifest.family, block: manifest.ref, field: issue.path, ...(issue.code ? { checkCode: issue.code } : {}) });
        if (issues?.length) rejected.add(manifest.ref);
      } catch (error) {
        diagnostic('family-check-failed', error.message || String(error), { file: manifest.path, family: manifest.family, block: manifest.ref });
        rejected.add(manifest.ref);
      }
    }
    result.manifests = result.manifests.filter((manifest) => !rejected.has(manifest.ref));
    const allInputs = parsed.families.map((entry) => entry.manifests);
    for (const family of result.families) {
      if (family.generators?.includes('registry')) result.generators.push({ key: `registry:${family.id}`, source: 'builtin', family: family.id, out: family.config.registry.out, inputs: [family.config.manifests], cache: true, closureHash: '' });
    }
    if (result.families.some((family) => family.generators?.includes('index'))) result.generators.push({ key: 'index', source: 'builtin', out: '.blocks/index.json', inputs: allInputs, cache: true, closureHash: '' });
    const customs = [...parsed.families.flatMap((entry) => (entry.generators || []).map((path) => ({ path, family: entry.id }))), ...parsed.generators.map((path) => ({ path }))];
    const seenGenerators = new Set();
    for (const { path, family } of customs) {
      if (seenGenerators.has(path)) continue;
      seenGenerators.add(path);
      try {
        const exports = await importSource(path), definition = exports.default;
        if (!object(definition) || definition[Symbol.for('block-beaver.generator')] !== true || !isFamilyPath(definition.out) || !Array.isArray(definition.inputs) || !definition.inputs.length || definition.inputs.some((input) => !isFamilyGlob(input)) || !definition.inputs.some((input) => !input.startsWith('!')) || typeof definition.generate !== 'function' || (definition.cache !== undefined && typeof definition.cache !== 'boolean')) {
          diagnostic('generator-invalid', 'Generator needs a defineGenerator() default, safe out, nonempty input globs and generate function', { file: path, ...(family ? { family } : {}) }); continue;
        }
        const { generate: fn, ...metadata } = definition;
        try { jsonCopy(metadata); } catch { diagnostic('generator-invalid', 'Generator metadata must contain only JSON data', { file: path, ...(family ? { family } : {}) }); continue; }
        const key = `custom:${path}`;
        result.generators.push({ key, source: 'custom', ...(family ? { family } : {}), path, out: definition.out, inputs: [...definition.inputs], cache: definition.cache !== false, closureHash: '' });
        generatorFunctions.set(key, fn);
      } catch (error) { errorDiagnostic(error, { file: path, ...(family ? { family } : {}) }); }
    }
    if (result.families.some((family) => family.generators?.includes('history'))) result.generators.push({ key: 'history', source: 'builtin', out: '.blocks/history.json', inputs: allInputs, cache: true, closureHash: '' });
    if (generate) {
      const manifests = readonly(result.manifests.map((item) => item.value));
      const selected = new Set(generate.keys);
      let ctx, contextError;
      try { ctx = readonly({ config: jsonCopy(config), families: jsonCopy(result.families), manifests: (family) => readonly(manifests.filter((item) => item.family === family)), blocks: () => manifests, graph: jsonCopy(generate.graph), resolve: (from, spec) => readonly(project.resolveImport(from, spec, { mode: 'import' })), label: generate.label ?? null }); }
      catch (error) { contextError = new TypeError(`Generator context must contain only JSON data: ${error.message}`); }
      for (const info of result.generators) {
        if (info.source !== 'custom' || !selected.has(info.key)) continue;
        try {
          if (contextError) throw contextError;
          const content = await generatorFunctions.get(info.key)(ctx);
          if (typeof content !== 'string') throw new TypeError('Generator must return a string');
          result.outputs.push({ key: info.key, content });
        } catch (error) {
          const item = { rule: 'family-drift', code: 'generator-failed', severity: 'error', message: error.message || String(error), file: info.path, ...(info.family ? { family: info.family } : {}) };
          result.outputs.push({ key: info.key, diagnostic: item });
          result.diagnostics.push(item);
        }
      }
      for (const key of selected) if (!result.generators.some((info) => info.key === key)) result.outputs.push({ key, diagnostic: diagnostic('generator-invalid', `Unknown generator ${key}`, {}, 'family-drift') });
    }
    // A configured loader owns runtime imports. Parse its repository source closure
    // afterward for cache freshness without registering any competing hooks.
    if (parsed.loader) {
      await discoverClosure(root, project, loadedFiles, dependencies);
      for (const [path, hash] of sourceHashes) {
        try {
          if (createHash('sha256').update(await readFile(assertSafeSource(root, path))).digest('hex') !== hash) result.cacheable = false;
        } catch { result.cacheable = false; }
      }
    }
    for (const info of result.generators) {
      const starts = info.path ? [info.path] : result.families.filter((family) => !info.family || family.id === info.family).map((family) => family.config.contract);
      const closure = new Set(), pending = [...starts];
      while (pending.length) { const path = pending.pop(); if (closure.has(path)) continue; closure.add(path); pending.push(...(dependencies.get(path) || [])); }
      // Without our hooks, a loader may import computed paths. Its conservative
      // source closure ensures those helpers can never produce a stale cache hit.
      if (parsed.loader) for (const path of sourceHashes.keys()) if (/\.[cm]?[jt]sx?$/.test(path)) closure.add(path);
      info.closureHash = createHash('sha256').update(canonicalJson([...closure].sort().map((path) => [path, sourceHashes.get(path) ?? null]))).digest('hex');
    }
    return result;
  } finally {
    hooks?.deregister();
    result.loadedFiles = [...loadedFiles].sort();
    result.fileHashes = Object.fromEntries([...sourceHashes].sort(([a], [b]) => compare(a, b)));
  }
}

async function discoverClosure(root, project, loadedFiles, dependencies) {
  const pending = [...loadedFiles], seen = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    let source;
    try { source = ts.createSourceFile(path, await readFile(assertSafeSource(root, path), 'utf8'), ts.ScriptTarget.Latest, true); } catch { continue; }
    const specifiers = new Set();
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.add(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) specifiers.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of specifiers) {
      const resolved = project.resolveImport(path, specifier, { mode: 'import' }).path;
      const target = resolved && runtimeSourcePath(root, resolved);
      if (!target) continue;
      if (!dependencies.has(path)) dependencies.set(path, new Set());
      dependencies.get(path).add(target);
      loadedFiles.add(target); pending.push(target);
    }
  }
}

process.once('message', async (message) => {
  let result;
  try {
    if (message?.protocol !== 1) throw new Error('Unsupported family loader protocol');
    result = await execute(message);
  } catch (error) {
    result = { families: [], manifests: [], generators: [], loadedFiles: [], fileHashes: {}, cacheable: false, diagnostics: [{ rule: 'manifest-valid', code: error.familyLoaderCode || (error.code === 'FAMILY_FILE_LIMIT' ? 'loader-file-limit' : 'load-failed'), severity: 'error', message: error.message || String(error), ...(error.familyLoaderFile ? { file: error.familyLoaderFile } : {}) }] };
  }
  process.send({ protocol: 1, token: message?.token, result }, () => { process.disconnect(); process.exit(0); });
});
