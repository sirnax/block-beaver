/** Inline scripts and styles use this placeholder until a host supplies its CSP nonce. */
export const VIEW_NONCE_PLACEHOLDER = '__BLOCK_BEAVER_NONCE__';
/** Insert trusted, static host navigation here when serving the complete document. */
export const VIEW_HOST_HEADER_SLOT = '<!--block-beaver:host-header-->';

const escapeAttribute = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/**
 * Prepare a generated snapshot for serving as a complete HTML document.
 * Supply the request's CSP nonce to allow its inline scripts and styles. Omitting
 * it removes the nonce attributes. headerHtml is trusted HTML: the host must
 * escape any untrusted values before supplying navigation markup.
 * This helper performs no I/O and does not alter content outside these slots.
 */
export function prepareView(html, { nonce, headerHtml } = {}) {
  const attribute = ` nonce="${VIEW_NONCE_PLACEHOLDER}"`;
  return String(html).split(attribute).join(nonce == null ? '' : ` nonce="${escapeAttribute(nonce)}"`)
    .replace(VIEW_HOST_HEADER_SLOT, () => headerHtml == null ? '' : String(headerHtml));
}
