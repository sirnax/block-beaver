const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalBrowserRequest(headers) {
  try {
    const host = new URL(`http://${headers.host}`);
    if (!localHosts.has(host.hostname) || host.username || host.password) return false;
    if (headers.origin) {
      const origin = new URL(headers.origin);
      if (origin.protocol !== 'http:' || origin.host !== host.host) return false;
    }
    return true;
  } catch { return false; }
}

export const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
