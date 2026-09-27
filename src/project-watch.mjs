import { createServer } from 'node:http';
import { updateProject, renderBlockMap } from './block-map.mjs';
import { isLocalBrowserRequest, securityHeaders } from './http-security.mjs';

export async function watchProject(root, { port = 4175, interval = 1500, onRefresh = () => {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  if (!Number.isInteger(interval) || interval < 100) throw new Error('Refresh interval must be at least 100 ms.');
  let latest = await updateProject(root);
  let error = null, stopped = false, timer, active;
  async function refresh() {
    try {
      const next = await updateProject(root);
      if (next.revision !== latest.revision) onRefresh(next);
      latest = next;
      error = null;
    } catch (failure) { error = failure.message; }
    if (!stopped) timer = setTimeout(() => { active = refresh(); }, interval);
  }
  const server = createServer((request, response) => {
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
    // The generated view has only tool-owned inline scripts and styles; repository text is escaped.
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('cache-control', 'no-store');
    if (!isLocalBrowserRequest(request.headers)) return response.writeHead(403).end('Local browser request required.');
    if (request.method !== 'GET') return response.writeHead(405).end('Use GET.');
    let path;
    try { path = new URL(request.url, 'http://localhost').pathname; }
    catch { return response.writeHead(400).end('Invalid URL.'); }
    if (path === '/_revision') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ revision: latest.revision, error }));
    if (path === '/graph.json') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(latest.graph));
    if (path !== '/') return response.writeHead(404).end('Not found');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(renderBlockMap(latest.graph, { live: true }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  timer = setTimeout(() => { active = refresh(); }, interval);
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      stopped = true;
      clearTimeout(timer);
      await active;
      await new Promise((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve()));
    },
  };
}
