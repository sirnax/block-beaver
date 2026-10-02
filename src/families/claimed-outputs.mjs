import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { readProjectFile } from '../project-files.mjs';
import { indexPath } from './builtin-generators.mjs';
import { cachePath, readCache } from './cache.mjs';
import { isFamilyPath, parseFamiliesConfig } from './config.mjs';
import { historyPath } from './history.mjs';

const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const tsSwap = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const unresolved = /Cannot (?:resolve(?: asset)?|find module) '([^']+)'/;

async function readSource(root, path) {
  try { return await readProjectFile(root, path); } catch { return null; }
}

/** String-literal `out:` values, and the `generators: [...]` names, written in a module's source. */
function literals(ts, path, text) {
  const outs = [], generators = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) {
      if (node.name.text === 'out' && ts.isStringLiteralLike(node.initializer)) outs.push(node.initializer.text);
      if (node.name.text === 'generators' && ts.isArrayLiteralExpression(node.initializer)) generators.push(...node.initializer.elements.filter(ts.isStringLiteralLike).map((item) => item.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
  return { outs, generators };
}

/**
 * Every output a generator claims that can be known without evaluating project code:
 * registry outs, index and history (when a contract asks, or cannot be read), literal
 * `out` values in generator modules, and outs recorded by earlier runs in the cache.
 */
export async function claimedOutputs(root, config) {
  const { default: ts } = await import('typescript');
  const parsed = parseFamiliesConfig(config);
  const claimed = new Set();
  for (const family of parsed.families) {
    if (isFamilyPath(family.registry?.out)) claimed.add(family.registry.out);
    const text = await readSource(root, family.contract);
    const asks = text === null ? ['index', 'history'] : literals(ts, family.contract, text).generators;
    if (asks.includes('index')) claimed.add(indexPath);
    if (asks.includes('history')) claimed.add(historyPath);
  }
  const modules = new Set([...parsed.families.flatMap((family) => family.generators ?? []), ...parsed.generators]);
  for (const path of modules) {
    const text = await readSource(root, path);
    if (text !== null) for (const out of literals(ts, path, text).outs) if (isFamilyPath(out)) claimed.add(out);
  }
  // A cache entry outlives its generator; only modules still configured keep their recorded out.
  for (const [key, entry] of Object.entries(readCache(await readSource(root, cachePath)).entries)) if (key.startsWith('custom:') && modules.has(key.slice('custom:'.length)) && isFamilyPath(entry.out)) claimed.add(entry.out);
  return claimed;
}

/**
 * An alias (tsconfig `paths`/`baseUrl`) resolves with the importer's app options through the
 * compiler, which is told that the claimed outputs exist; no project code is evaluated.
 */
async function aliasedOutput(root, importer, specifier, claimed, context) {
  const { default: ts } = await import('typescript');
  context.project ??= (await import('../project-model.mjs')).loadProjectModel(root, { paths: context.importers, writeConfig: false });
  const project = await context.project;
  const app = project.apps.find((item) => item.id === project.ownerByFile.get(importer)) ?? project.apps.find((item) => item.root === '.');
  if (!app) return null;
  const outputs = new Set([...claimed].map((out) => join(root, out).split('\\').join('/')));
  const host = { ...ts.sys, fileExists: (path) => outputs.has(path.split('\\').join('/')) || ts.sys.fileExists(path) };
  const resolved = ts.resolveModuleName(specifier, resolve(root, importer), app.compilerOptions, host, undefined, undefined, ts.ModuleKind.ESNext).resolvedModule;
  const path = resolved && relative(root, resolved.resolvedFileName).split('\\').join('/');
  return path && claimed.has(path) ? path : null;
}

/** Where an unresolved import would have landed: the claimed output it names, if any. */
async function missingOutput(root, importer, specifier, claimed, context) {
  let base;
  if (isAbsolute(specifier)) base = relative(root, specifier).split('\\').join('/');
  else if (specifier.startsWith('./') || specifier.startsWith('../')) base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  else { try { return await aliasedOutput(root, importer, specifier, claimed, context); } catch { return null; } }
  if (!isFamilyPath(base)) return null;
  const extension = posix.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  const candidates = [base, ...extensions.map((item) => base + item), ...extensions.map((item) => `${base}/index${item}`), ...(tsSwap[extension] ?? []).map((item) => stem + item)];
  return candidates.find((path) => claimed.has(path)) ?? null;
}

/**
 * Re-code `unresolved-import` diagnostics whose target is a claimed generated output: loading
 * failed because an output was deleted, so the generator that would recreate it cannot run.
 */
export async function explainMissingOutputs(root, config, diagnostics) {
  if (!diagnostics.some((item) => item?.code === 'unresolved-import')) return diagnostics;
  let claimed;
  try { claimed = await claimedOutputs(root, config); } catch { return diagnostics; }
  const found = diagnostics.map((item) => {
    if (item?.code !== 'unresolved-import') return null;
    const importer = item.file ?? /^([^:\s]+): /.exec(item.message ?? '')?.[1];
    const specifier = unresolved.exec(item.message ?? '')?.[1];
    return importer && specifier && isFamilyPath(importer) ? { importer, specifier } : null;
  });
  const context = { importers: [...new Set(found.filter(Boolean).map((item) => item.importer))] };
  const results = [];
  for (const [index, item] of diagnostics.entries()) {
    const out = found[index] ? await missingOutput(root, found[index].importer, found[index].specifier, claimed, context) : null;
    if (!out) { results.push(item); continue; }
    const { importer } = found[index];
    results.push({ ...item, code: 'output-required-for-load', file: importer, output: out,
      message: `${importer} imports the generated output ${out}, which is missing, so loading stops before any generator can recreate it. Restore it with \`git restore ${out}\`, then run \`block-beaver gen --adopt ${out}\` if it predates Block Beaver. Do not delete outputs that contracts or checks import.` });
  }
  return results;
}
