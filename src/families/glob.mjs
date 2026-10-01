import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ignoredDirectories = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel', 'vendor', '.worktrees', 'worktrees']);
const escape = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** Compile repository POSIX globs without making matching depend on the host shell. */
function compile(pattern) {
  if (typeof pattern !== 'string' || !pattern) throw new TypeError('Glob must be a nonempty string');
  const negative = pattern.startsWith('!');
  const input = negative ? pattern.slice(1) : pattern;
  let index = 0, captures = 0;
  function sequence(inBrace = false) {
    let output = '';
    while (index < input.length) {
      const character = input[index++];
      if (inBrace && (character === ',' || character === '}')) { index--; break; }
      if (character === '*') {
        if (input[index] === '*') {
          while (input[index] === '*') index++;
          if (input[index] === '/' && (index === 2 || input[index - 3] === '/' || input[index - 3] === '{' || input[index - 3] === ',')) {
            index++; output += '(?:[^/]+/)*';
          } else output += '.*';
        } else { output += '([^/]*)'; captures++; }
      } else if (character === '?') output += '[^/]';
      else if (character === '[') {
        let classText = '';
        if (input[index] === '!' || input[index] === '^') { classText = '^'; index++; }
        if (input[index] === ']') classText += '\\]';
        if (input[index] === ']') index++;
        while (index < input.length && input[index] !== ']') {
          const member = input[index++];
          if (member === '/' || member === '\\') throw new TypeError('Glob character class cannot contain a slash');
          classText += member;
        }
        if (input[index++] !== ']' || !classText || classText === '^') throw new TypeError('Unclosed or empty glob character class');
        output += `(?!/)[${classText}]`;
      } else if (character === '{') {
        const alternatives = [];
        for (;;) {
          alternatives.push(sequence(true));
          const delimiter = input[index++];
          if (delimiter === '}') break;
          if (delimiter !== ',') throw new TypeError('Unclosed glob brace');
        }
        if (alternatives.length < 2 || alternatives.some((item) => !item)) throw new TypeError('Glob braces need at least two alternatives');
        output += `(?:${alternatives.join('|')})`;
      } else if (character === '}' || character === ']') throw new TypeError(`Unexpected glob ${character}`);
      else if (character === '\\') throw new TypeError('Use POSIX slashes in globs');
      else output += escape(character);
    }
    return output;
  }
  const expression = sequence();
  return { regex: new RegExp(`^${expression}$`, 'u'), negative, captures };
}

export function globRegex(pattern) { return compile(pattern).regex; }
export function matchGlob(path, pattern) {
  const { regex, negative } = compile(pattern);
  return negative ? !regex.test(path) : regex.test(path);
}

/** Positive patterns include files, and negative patterns exclude them. */
export function matchGlobs(paths, patterns) {
  const compiled = patterns.map(compile);
  const positives = compiled.filter((item) => !item.negative), negatives = compiled.filter((item) => item.negative);
  return [...new Set(paths)].filter((path) => (positives.length === 0 || positives.some(({ regex }) => regex.test(path))) && !negatives.some(({ regex }) => regex.test(path))).sort();
}

/** The last single star matched by this alternative supplies the manifest ID. */
export function captureManifestId(path, pattern) {
  const { regex, negative } = compile(pattern);
  if (negative) return undefined;
  const result = regex.exec(path);
  return result?.slice(1).filter((capture) => capture !== undefined).at(-1);
}

export function hasManifestCapture(pattern) { return !compile(pattern).negative && compile(pattern).captures > 0; }

/** Discover all input kinds; configured manifests may live inside .blocks. */
export async function discoverFiles(root, { maxFiles = 20000 } = {}) {
  const paths = [];
  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && path !== '.blocks/cache' && path !== '.blocks/view') await walk(join(directory, entry.name), `${path}/`);
      } else if (entry.isFile()) {
        paths.push(path);
        if (paths.length > maxFiles) {
          const error = new Error(`Family input limit exceeded (${maxFiles} files)`);
          error.code = 'FAMILY_FILE_LIMIT';
          throw error;
        }
      }
    }
  }
  await walk(root);
  return paths;
}
