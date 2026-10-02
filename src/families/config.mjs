import { hasManifestCapture, globRegex } from './glob.mjs';

const idPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const reservedBindings = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'static', 'arguments', 'eval']);

export function isRegistryExportName(value) {
  return typeof value === 'string' && /^[A-Za-z_$][\w$]*$/.test(value) && !reservedBindings.has(value);
}

/** Same lexical path boundary as the safe project writer; filesystem checks follow on read. */
export function isFamilyPath(path) {
  return typeof path === 'string' && !!path && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !path.includes('\\') && !path.includes('\0') && path.split('/').every((part) => !!part && part !== '.' && part !== '..');
}

export function isFamilyGlob(pattern) {
  const positive = typeof pattern === 'string' && pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (!isFamilyPath(positive)) return false;
  try { globRegex(pattern); return true; } catch { return false; }
}

/** The repository path of a configured history label module, or null for a string, absent or invalid label. */
export const historyLabelModule = (config) => { const label = config?.history?.label; return object(label) && Object.keys(label).length === 1 && isFamilyPath(label.module) ? label.module : null; };

/** Parse additions to schemaVersion 1 without imposing domain names or folder conventions. */
export function parseFamiliesConfig(config) {
  const diagnostics = [], families = [], generators = [];
  let loader;
  const issue = (code, message, field, family) => diagnostics.push({ rule: 'config-valid', code, severity: 'error', message, file: '.blocks/config.json', field, ...(family ? { family } : {}) });
  if (!object(config)) { issue('family-path-invalid', 'Project config must be an object', '$'); return { families, generators, diagnostics }; }
  if (config.families !== undefined && !Array.isArray(config.families)) issue('family-path-invalid', 'families must be an array', '$.families');
  const seen = new Set();
  for (const [floor, entry] of (Array.isArray(config.families) ? config.families : []).entries()) {
    const field = `$.families[${floor}]`, family = entry?.id;
    if (!object(entry)) { issue('family-path-invalid', 'Family configuration must be an object', field); continue; }
    const start = diagnostics.length;
    if (typeof family !== 'string' || !idPattern.test(family)) issue('family-id-invalid', 'Family ID must be kebab-case starting with a letter', `${field}.id`);
    else if (family === 'local') issue('family-id-reserved', 'Family ID local is reserved for the base block registry', `${field}.id`, family);
    if (seen.has(family)) issue('family-duplicate', `Family ${family} is configured more than once`, `${field}.id`, family);
    seen.add(family);
    if (!isFamilyPath(entry.contract)) issue('family-path-invalid', 'Contract must be a repository-relative path', `${field}.contract`, family);
    if (!isFamilyGlob(entry.manifests) || !hasManifestCaptureSafely(entry.manifests)) issue('family-glob-invalid', 'Manifest glob must be repository-relative and contain a single * capture for the ID', `${field}.manifests`, family);
    if (entry.registry !== undefined) {
      if (!object(entry.registry) || !isFamilyPath(entry.registry.out)) issue('family-path-invalid', 'registry.out must be a repository-relative path', `${field}.registry.out`, family);
      else if (!/\.(?:ts|mts|cts)$/.test(entry.registry.out) || /\.d\.(?:ts|mts|cts)$/.test(entry.registry.out)) issue('family-path-invalid', 'Typed registry output must use .ts, .mts or .cts', `${field}.registry.out`, family);
      if (entry.registry?.exportName !== undefined && !isRegistryExportName(entry.registry.exportName)) issue('family-path-invalid', 'registry.exportName must be a valid ES module binding identifier', `${field}.registry.exportName`, family);
      if (entry.registry?.importExtension !== undefined && !['', '.js', '.ts'].includes(entry.registry.importExtension)) issue('family-path-invalid', 'registry.importExtension must be empty, .js or .ts', `${field}.registry.importExtension`, family);
    }
    if (entry.generators !== undefined && (!Array.isArray(entry.generators) || entry.generators.some((path) => !isFamilyPath(path)))) issue('family-path-invalid', 'generators must contain repository-relative paths', `${field}.generators`, family);
    if (entry.exclude !== undefined && (!Array.isArray(entry.exclude) || entry.exclude.some((pattern) => typeof pattern !== 'string' || pattern.startsWith('!') || !isFamilyGlob(pattern)))) issue('family-glob-invalid', 'exclude must contain repository-relative globs', `${field}.exclude`, family);
    if (diagnostics.length === start) families.push({ ...entry, configIndex: floor, floor });
  }
  applyMapFloors(families, config.map?.floors);
  if (config.generators !== undefined && (!Array.isArray(config.generators) || config.generators.some((path) => !isFamilyPath(path)))) issue('family-path-invalid', 'generators must contain repository-relative paths', '$.generators');
  else generators.push(...(config.generators || []));
  if (config.checks !== undefined && (!Array.isArray(config.checks) || config.checks.some((path) => !isFamilyPath(path)))) issue('family-path-invalid', 'checks must contain repository-relative paths', '$.checks');
  if (config.loader !== undefined) {
    if (typeof config.loader !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9._/-]+)?$/.test(config.loader) || config.loader.split('/').some((part) => part === '..' || part === '.')) issue('loader-package-missing', 'loader must name a package or a package subpath', '$.loader');
    else loader = config.loader;
  }
  if (config.history !== undefined && !object(config.history)) issue('family-path-invalid', 'history.label must be a string or { module }', '$.history.label');
  else if (config.history?.label !== undefined && typeof config.history.label !== 'string') {
    const label = config.history.label;
    if (!object(label)) issue('family-path-invalid', 'history.label must be a string or { module }', '$.history.label');
    else if (Object.keys(label).some((key) => key !== 'module')) issue('family-path-invalid', 'history.label accepts only a module key', '$.history.label');
    else if (!isFamilyPath(label.module)) issue('family-path-invalid', 'history.label.module must be a repository-relative path', '$.history.label.module');
  }
  if (config.map !== undefined) {
    if (!object(config.map)) issue('family-path-invalid', 'map must be an object', '$.map');
    else {
      if (config.map.skin !== undefined && !isFamilyPath(config.map.skin)) issue('family-path-invalid', 'map.skin must be a repository-relative path', '$.map.skin');
      if (config.map.tokens !== undefined && !validTokens(config.map.tokens)) issue('family-path-invalid', 'map.tokens must map kebab-case names to CSS strings', '$.map.tokens');
      const ids = new Set(families.map((entry) => entry.id));
      if (config.map.floors !== undefined) {
        const floors = config.map.floors;
        if (!Array.isArray(floors) || floors.some((id) => typeof id !== 'string') || new Set(floors).size !== floors.length) issue('family-path-invalid', 'map.floors must list distinct family IDs', '$.map.floors');
        else for (const [index, id] of floors.entries()) if (!ids.has(id)) issue('family-path-invalid', `map.floors names unknown family ${id}`, `$.map.floors[${index}]`);
      }
      if (config.map.groupBy !== undefined && (typeof config.map.groupBy !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(config.map.groupBy))) issue('family-path-invalid', 'map.groupBy must name a manifest field', '$.map.groupBy');
      if (config.map.skins !== undefined) {
        const skins = config.map.skins, skinIds = new Set();
        if (!Array.isArray(skins)) issue('family-path-invalid', 'map.skins must be an array', '$.map.skins');
        else for (const [index, skin] of skins.entries()) {
          const at = `$.map.skins[${index}]`;
          if (!object(skin) || typeof skin.id !== 'string' || !idPattern.test(skin.id) || skinIds.has(skin.id)) { issue('family-path-invalid', 'Each skin needs a distinct kebab-case id', `${at}.id`); continue; }
          skinIds.add(skin.id);
          if (skin.path !== undefined && !isFamilyPath(skin.path)) issue('family-path-invalid', 'Skin path must be a repository-relative path', `${at}.path`);
          if (skin.tokens !== undefined && !validTokens(skin.tokens)) issue('family-path-invalid', 'Skin tokens must map kebab-case names to CSS strings', `${at}.tokens`);
        }
      }
      if (config.map.bindings !== undefined) {
        const binding = /^[A-Za-z_$][\w$]*$/;
        if (!Array.isArray(config.map.bindings)) issue('family-path-invalid', 'map.bindings must be an array', '$.map.bindings');
        else for (const [index, entry] of config.map.bindings.entries()) {
          if (!object(entry) || !ids.has(entry.family) || typeof entry.call !== 'string' || typeof entry.registry !== 'string' || !binding.test(entry.call) || !binding.test(entry.registry)) issue('family-path-invalid', 'Each binding needs a configured family and identifier call and registry names', `$.map.bindings[${index}]`);
        }
      }
    }
  }
  return { families, generators, diagnostics, ...(loader ? { loader } : {}) };
}

function validTokens(tokens) { return object(tokens) && Object.entries(tokens).every(([key, value]) => idPattern.test(key) && typeof value === 'string'); }

function hasManifestCaptureSafely(pattern) { try { return hasManifestCapture(pattern); } catch { return false; } }

/**
 * `configIndex` is the position in config.families and drives emission order. `floor` is the map floor:
 * the position in map.floors (bottom to top), with unlisted families after the listed ones in config order.
 * Without a usable map.floors, floor equals configIndex.
 */
function applyMapFloors(families, floors) {
  if (!Array.isArray(floors)) return;
  const known = new Map(families.map((family) => [family.id, family]));
  const ordered = [];
  for (const id of floors) if (typeof id === 'string' && known.has(id) && !ordered.includes(known.get(id))) ordered.push(known.get(id));
  for (const family of families) if (!ordered.includes(family)) ordered.push(family);
  ordered.forEach((family, floor) => { family.floor = floor; });
}
