/** Inline scripts and styles use this placeholder until a host supplies its CSP nonce. */
export const VIEW_NONCE_PLACEHOLDER: '__BLOCK_BEAVER_NONCE__';
/** Insert trusted, static host navigation here when serving the complete document. */
export const VIEW_HOST_HEADER_SLOT: '<!--block-beaver:host-header-->';

export interface PrepareViewOptions {
  /** The request's CSP nonce. Omitting it removes the nonce attributes. */
  nonce?: string | null;
  /** Trusted HTML for the host header slot; the host must escape untrusted values. */
  headerHtml?: string | null;
}

/**
 * Prepare a generated snapshot for serving as a complete HTML document.
 * Performs no I/O and does not alter content outside the nonce and header slots.
 */
export function prepareView(html: string, options?: PrepareViewOptions): string;
