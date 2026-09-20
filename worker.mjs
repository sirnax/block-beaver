import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { scanRepository } from './src/scanner.mjs';
import { attachLocalRegistry, attachTeacakeRegistry } from './src/adapter.mjs';
import { inspect, search } from './src/graph.mjs';
import { makeProposal, suggestBoundaries } from './src/contracts.mjs';
import { createRoadmap, propose, repair, checkSlice, review, approve, reject, resume } from './src/workflow.mjs';
import { isLocalBrowserRequest, securityHeaders } from './src/http-security.mjs';

const repoPath = process.env.BLOCK_BEAVER_REPO || process.env.BLOCK_STUDIO_REPO;
const root = resolve(repoPath || '');
const token = process.env.BLOCK_BEAVER_TOKEN || process.env.BLOCK_STUDIO_TOKEN || '';
const port = Number(process.env.BLOCK_BEAVER_WORKER_PORT || process.env.BLOCK_STUDIO_WORKER_PORT || 4174);
if (!repoPath) throw new Error('Set BLOCK_BEAVER_REPO to an explicit repository path.');
if (token.length < 16) throw new Error('Set BLOCK_BEAVER_TOKEN to at least 16 characters.');
const authorized = (header) => {
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
};
const send = (response, status, value) => response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(value));
async function body(request) {
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 2_000_000) throw new Error('Request too large.'); }
  return raw ? JSON.parse(raw) : {};
}
async function graph() { return attachTeacakeRegistry(await attachLocalRegistry(await scanRepository(root))); }

export async function dispatch(action, input = {}) {
  if (action === 'resume') return resume(root, input.roadmapId);
  if (action === 'reject') return reject(root, input.roadmapId, input.sliceId, input.reason);
  const current = await graph();
  if (action === 'scan') return current;
  if (action === 'inspect') return inspect(current, input.id);
  if (action === 'search') return search(current, input.query, { kind: input.kind, limit: input.limit });
  if (action === 'suggest') return suggestBoundaries(current);
  if (action === 'plan') return createRoadmap(root, input.roadmapId, current, { title: input.title, scope: input.scope });
  if (action === 'propose') return propose(root, input.roadmapId, input.proposal?.manifest ? input.proposal : makeProposal(input.proposal || {}, current), current);
  if (action === 'repair') return repair(root, input.roadmapId, input.sliceId, input.proposal?.manifest ? input.proposal : makeProposal(input.proposal || {}, current), current);
  if (action === 'check') return checkSlice(root, input.roadmapId, input.sliceId, current);
  if (action === 'review') return review(root, input.roadmapId, input.sliceId, current);
  if (action === 'approve') return approve(root, input.roadmapId, input.sliceId, current);
  throw new Error(`Unknown worker action: ${action}`);
}

createServer(async (request, response) => {
  for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
  if (!isLocalBrowserRequest(request.headers)) return send(response, 403, { error: 'Local request required.' });
  if (!authorized(request.headers.authorization)) return send(response, 401, { error: 'Bearer token required.' });
  if (request.method !== 'POST') return send(response, 405, { error: 'Use POST.' });
  try { return send(response, 200, await dispatch(new URL(request.url, 'http://localhost').pathname.slice(1), await body(request))); }
  catch (error) { return send(response, 400, { error: error.message }); }
}).listen(port, '127.0.0.1', () => console.log(`Block Beaver worker on 127.0.0.1:${port}`));
