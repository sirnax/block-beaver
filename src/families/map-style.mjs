import { readProjectFile } from '../project-files.mjs';
import { validateMapStyle } from './map-render.mjs';

const skinId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const problem = (message, file) => ({ rule: 'config-valid', code: 'map-style-invalid', severity: 'error', message, ...(file ? { file } : {}) });

async function readSkin(root, path) {
  if (path == null) return { css: '' };
  try {
    const css = await readProjectFile(root, path);
    if (css === null) throw new Error(`Map skin not found: ${path}`);
    return { css };
  } catch (error) { return { css: '', error: error.message }; }
}

/**
 * Read repo-defined skins safely. Local font assets remain the host's responsibility.
 * `map.skin`/`map.tokens` is the base sheet. `map.skins` (0.6.0) adds selectable skins,
 * each read and validated the same way; `skins` is present only when that key is used.
 */
export async function prepareMapStyle(root, config = {}) {
  const map = config.map || {};
  const base = await readSkin(root, map.skin);
  const safe = validateMapStyle({ css: base.css, tokens: map.tokens });
  const result = { css: safe.css, tokens: safe.tokens, diagnostics: [...(base.error ? [base.error] : []), ...safe.diagnostics].map((message) => problem(message, map.skin)) };
  if (!Array.isArray(map.skins) || !map.skins.length) return result;
  result.skins = [];
  const seen = new Set();
  for (const skin of map.skins) {
    if (!skin || typeof skin.id !== 'string' || !skinId.test(skin.id) || seen.has(skin.id)) {
      result.diagnostics.push(problem(`Map skin id must be a distinct kebab-case name: ${JSON.stringify(skin?.id ?? null)}`));
      continue;
    }
    seen.add(skin.id);
    const file = typeof skin.path === 'string' ? skin.path : undefined;
    const read = await readSkin(root, file);
    const checked = validateMapStyle({ css: read.css, tokens: skin.tokens });
    result.skins.push({ id: skin.id, css: checked.css, tokens: checked.tokens });
    result.diagnostics.push(...[...(read.error ? [read.error] : []), ...checked.diagnostics].map((message) => problem(`Skin ${skin.id}: ${message}`, file)));
  }
  return result;
}
