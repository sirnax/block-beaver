/**
 * Walk a `.`/`[]` field path (`groups[].routes[].handler`) over plain JSON, calling `visit(field, value)`
 * for every concrete leaf, with `field` like `$.groups[0].routes[1].handler`. null/undefined are skipped.
 * `invalid(field, message)` hears a non-object where the path needs one, or a non-array where `[]` is marked.
 */
export function walkPath(root, path, visit, invalid = () => {}) {
  const segments = path.split('.').map((segment) => { const [, key, brackets] = /^(.*?)((?:\[\])*)$/.exec(segment); return { key, depth: brackets.length / 2 }; });
  function walk(value, index, field) {
    if (value == null) return;
    if (index === segments.length) { visit(field, value); return; }
    if (typeof value !== 'object' || Array.isArray(value)) { invalid(field, 'A link field path must traverse an object'); return; }
    const { key, depth } = segments[index], next = Object.hasOwn(value, key) ? value[key] : undefined;
    if (next == null) return;
    const descend = (entry, level, at) => {
      if (level === 0) walk(entry, index + 1, at);
      else if (entry == null) return;
      else if (!Array.isArray(entry)) invalid(at, 'A [] link field must contain an array');
      else entry.forEach((item, position) => descend(item, level - 1, `${at}[${position}]`));
    };
    descend(next, depth, `${field}.${key}`);
  }
  walk(root, 0, '$');
}

/** Every value a path reaches, as `[{ field, value }]` in document order. Invalid traversals are skipped. */
export function valuesAt(value, path) {
  const found = [];
  walkPath(value, path, (field, leaf) => found.push({ field, value: leaf }));
  return found;
}
