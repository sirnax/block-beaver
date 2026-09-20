import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { scanRepository } from './src/scanner.mjs';
import { attachTeacakeRegistry, attachLocalRegistry } from './src/adapter.mjs';
import { inspect, search } from './src/graph.mjs';
import { suggestBoundaries, makeProposal, connectionProposal } from './src/contracts.mjs';
import { resume } from './src/workflow.mjs';
import { isLocalBrowserRequest, securityHeaders } from './src/http-security.mjs';

const appRoot = dirname(fileURLToPath(import.meta.url));
const initialRoot = resolve(process.env.BLOCK_BEAVER_REPO || process.env.BLOCK_STUDIO_REPO || process.cwd());
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 4173);
let graph = null;
const json = (response, status, value) => response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(value));
async function body(request) {
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 1_000_000) throw new Error('Request too large'); }
  return raw ? JSON.parse(raw) : {};
}

createServer(async (request, response) => {
  try {
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
    if (!isLocalBrowserRequest(request.headers)) return json(response, 403, { error: 'Local browser request required.' });
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/meta') return json(response, 200, { root: initialRoot, hasGraph: !!graph });
    if (url.pathname === '/api/scan' && request.method === 'POST') {
      const input = await body(request);
      graph = await attachTeacakeRegistry(await attachLocalRegistry(await scanRepository(resolve(input.root || initialRoot))));
      return json(response, 200, graph);
    }
    if (url.pathname === '/api/graph') return json(response, graph ? 200 : 404, graph || { error: 'Scan a repository first.' });
    if (url.pathname === '/api/inspect') return json(response, graph ? 200 : 404, graph ? inspect(graph, url.searchParams.get('id')) : { error: 'Scan first.' });
    if (url.pathname === '/api/search') return json(response, graph ? 200 : 404, graph ? search(graph, url.searchParams.get('q'), { kind: url.searchParams.get('kind') || undefined }) : { error: 'Scan first.' });
    if (url.pathname === '/api/suggestions') return json(response, graph ? 200 : 404, graph ? suggestBoundaries(graph) : { error: 'Scan first.' });
    if (url.pathname === '/api/roadmaps') {
      if (!graph) return json(response, 404, { error: 'Scan first.' });
      let names = [];
      try { names = await readdir(join(graph.root, '.blocks', 'roadmaps')); } catch { /* No roadmaps yet. */ }
      const roadmaps = [];
      for (const name of names) { try { const value = await resume(graph.root, name); roadmaps.push(value.roadmap); } catch { /* Skip incomplete entries. */ } }
      return json(response, 200, roadmaps);
    }
    if (url.pathname === '/api/roadmap') {
      if (!graph) return json(response, 404, { error: 'Scan first.' });
      return json(response, 200, await resume(graph.root, url.searchParams.get('id') || ''));
    }
    if (url.pathname === '/api/proposal' && request.method === 'POST') {
      if (!graph) return json(response, 404, { error: 'Scan first.' });
      return json(response, 200, makeProposal(await body(request), graph));
    }
    if (url.pathname === '/api/connection-preview' && request.method === 'POST') {
      if (!graph) return json(response, 404, { error: 'Scan first.' });
      const input = await body(request);
      return json(response, 200, connectionProposal(graph, input.blockId, input.dependencyId));
    }
    if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed.' });
    const pathname = decodeURIComponent(url.pathname);
    const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1));
    const path = join(appRoot, relative);
    if (relative.startsWith('..' + sep) || relative === '..' || !path.startsWith(appRoot + sep)) return response.writeHead(403).end('Forbidden');
    if (!['index.html', 'styles.css'].includes(relative) && !relative.startsWith('src/')) return response.writeHead(404).end('Not found');
    const content = await readFile(path);
    response.writeHead(200, { 'content-type': `${types[extname(path)] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-cache' }).end(content);
  } catch (error) {
    if (request.url?.startsWith('/api/')) return json(response, 400, { error: error.message });
    response.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Block Beaver http://127.0.0.1:${port}`));
