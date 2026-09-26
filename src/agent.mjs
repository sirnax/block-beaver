import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateBlock, validateProposalPatches } from './contracts.mjs';
import { validateCreateScope } from './create-scope.mjs';

/** JSON stdin/stdout adapter. The executable chooses its own model or strategy. */
export async function runAgentAdapter(executable, { graph, scope = [], createScope = [], operation = 'propose', context = {} }) {
  if (!executable || !Array.isArray(scope) || !Array.isArray(createScope) || scope.length + createScope.length === 0) throw new Error('Agent adapter and bounded scope are required.');
  for (const path of scope) if (!graph.hashes[path]) throw new Error(`Unscanned file in agent scope: ${path}`);
  await validateCreateScope(graph.root, graph, createScope, { scope });
  const sources = {};
  let bytes = 0;
  for (const path of scope) {
    const content = await readFile(join(graph.root, path), 'utf8');
    bytes += Buffer.byteLength(content);
    if (bytes > 2_000_000) throw new Error('Agent scope exceeds the 2 MB source limit.');
    sources[path] = { content, hash: graph.hashes[path] };
  }
  const request = { protocol: 1, operation, root: graph.root, fingerprint: graph.fingerprint, scope, createScope, sources, graph: { nodes: graph.nodes.filter((node) => scope.includes(node.path)), edges: graph.edges.filter((edge) => scope.includes(edge.evidence.file)) }, context };
  const output = await new Promise((resolve, reject) => {
    const { BLOCK_BEAVER_TOKEN: _workerToken, BLOCK_STUDIO_TOKEN: _oldWorkerToken, ...safeEnvironment } = process.env;
    const script = /\.(?:[cm]?js)$/i.test(executable);
    const child = spawn(script ? process.execPath : executable, script ? [executable] : [], { cwd: graph.root, env: safeEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 10_000_000) child.kill('SIGTERM'); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 1_000_000) child.kill('SIGTERM'); });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`Agent adapter exited ${code}: ${stderr.slice(-1000)}`)); else resolve(stdout); });
    child.stdin.end(JSON.stringify(request));
  });
  let response;
  try { response = JSON.parse(output); } catch { throw new Error('Agent adapter must return JSON on stdout.'); }
  if (response.protocol !== 1 || !Array.isArray(response.proposals)) throw new Error('Agent adapter returned an incompatible response.');
  const reviewed = response.proposals.map((proposal) => {
    const patchCheck = validateProposalPatches(proposal, graph, { scope, createScope });
    const errors = [...patchCheck.errors, ...validateBlock(proposal?.manifest, graph, { createdPaths: patchCheck.createdPaths }).errors];
    if (!Array.isArray(proposal?.manifest?.files) || !proposal.manifest.files.every((path) => scope.includes(path) || createScope.includes(path))) errors.push({ path: '$.files', message: 'Proposal exceeds agent scope.' });
    return { ...proposal, fingerprint: graph.fingerprint, check: { valid: errors.length === 0, errors } };
  });
  return { protocol: 1, operation, proposals: reviewed, notes: response.notes || [] };
}
