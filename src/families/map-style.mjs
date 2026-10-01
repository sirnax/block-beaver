import { readProjectFile } from '../project-files.mjs';
import { validateMapStyle } from './map-render.mjs';

/** Read a repo-defined skin safely. Local font assets remain the host's responsibility. */
export async function prepareMapStyle(root, config = {}) {
  const map = config.map || {};
  let css = '', readError;
  if (map.skin != null) {
    try {
      css = await readProjectFile(root, map.skin);
      if (css === null) throw new Error(`Map skin not found: ${map.skin}`);
    } catch (error) { css = ''; readError = error.message; }
  }
  const safe = validateMapStyle({ css, tokens: map.tokens });
  return { css: safe.css, tokens: safe.tokens, diagnostics: [...(readError ? [readError] : []), ...safe.diagnostics].map((message) => ({ rule: 'config-valid', code: 'map-style-invalid', severity: 'error', message, ...(map.skin ? { file: map.skin } : {}) })) };
}
