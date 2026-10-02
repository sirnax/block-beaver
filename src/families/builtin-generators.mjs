import { posix } from 'node:path';

export const indexPath = '.blocks/index.json';

export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const words = (id) => id.split('-');
export const camelCase = (id) => words(id).map((word, index) => (index ? word[0].toUpperCase() + word.slice(1) : word)).join('');
export const pascalCase = (id) => words(id).map((word) => word[0].toUpperCase() + word.slice(1)).join('');

const quote = (text) => `'${JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
const identifier = /^[A-Za-z_$][\w$]*$/;
const runtimeExtensions = { '.ts': '.js', '.mts': '.mjs', '.cts': '.cjs' };

/** Relative import of a manifest module, with the extension style the family asked for. */
function specifier(out, path, importExtension = '') {
  let target = posix.relative(posix.dirname(out), path);
  if (!target.startsWith('.')) target = `./${target}`;
  const extension = /\.[cm]?[jt]s$/.exec(target)?.[0];
  if (!extension) return target;
  const stem = target.slice(0, -extension.length);
  if (importExtension === '.ts') return target;
  if (importExtension === '.js') return `${stem}${runtimeExtensions[extension] ?? extension}`;
  return stem;
}

/** Typed read-only registry module for one family; the runner adds the header. */
export function renderRegistry({ family, manifests }) {
  const settings = family.config.registry;
  const sorted = [...manifests].sort((a, b) => compare(a.id, b.id));
  const lines = ["import { createRegistry } from 'block-beaver/kernel';"];
  sorted.forEach((manifest, index) => {
    const from = quote(specifier(settings.out, manifest.path, settings.importExtension));
    if (manifest.exportName === 'default') lines.push(`import m${index} from ${from};`);
    else if (identifier.test(manifest.exportName)) lines.push(`import { ${manifest.exportName} as m${index} } from ${from};`);
    else throw new Error(`Manifest ${manifest.ref} exports ${JSON.stringify(manifest.exportName)}, which cannot be imported by name`);
  });
  const name = settings.exportName ?? `${camelCase(family.id)}Registry`;
  const type = pascalCase(family.id);
  const list = sorted.map((_, index) => `m${index}`);
  const single = `export const ${name} = createRegistry(${quote(family.id)}, [${list.join(', ')}] as const);`;
  lines.push('', ...(single.length <= 100 ? [single] : [`export const ${name} = createRegistry(${quote(family.id)}, [`, ...list.map((item) => `  ${item},`), '] as const);']));
  lines.push(`export type ${type}Manifest = (typeof ${name})['all'][number];`, `export type ${type}Id = ${type}Manifest['id'];`, '');
  return lines.join('\n');
}

/**
 * `.blocks/index.json`, index v1: a bare JSON array of the manifests exactly as authored,
 * ordered by family config order (never map.floors) and then ID. Never wrap it; a breaking change ships a new file.
 */
export function renderIndex({ families, manifests }) {
  const rank = new Map([...families].sort((a, b) => (a.configIndex ?? 0) - (b.configIndex ?? 0)).map((family, position) => [family.id, position]));
  const ordered = [...manifests].sort((a, b) => (rank.get(a.family) ?? Infinity) - (rank.get(b.family) ?? Infinity) || compare(a.family, b.family) || compare(a.id, b.id));
  return `${JSON.stringify(ordered.map((manifest) => manifest.value), null, 2)}\n`;
}
