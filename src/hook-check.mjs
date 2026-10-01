import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const allow = () => ({ decision: 'allow' });
const MAX_GRAPH_BYTES = 16 * 1024 * 1024;

// Only native, understood envelopes participate. Unknown tools stay fail-open.
function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || event.hook_event_name !== 'PreToolUse') return null;
  const input = event.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(event.tool_name)) {
    const path = input.file_path ?? input.notebook_path;
    if (typeof path !== 'string' || !path || /[\x00-\x1f]/.test(path)) return null;
    return { kind: event.tool_name === 'Read' ? 'read' : 'edit', paths: [path] };
  }
  if (event.tool_name === 'apply_patch') {
    const patch = input.command;
    if (typeof patch !== 'string' || !patch.startsWith('*** Begin Patch\n') || !patch.trimEnd().endsWith('*** End Patch')) return null;
    const paths = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1]);
    if (!paths.length || paths.some((path) => /[\x00-\x1f]/.test(path))) return null;
    return { kind: 'edit', paths: [...new Set(paths)] };
  }
  if (['Bash', 'exec_command', 'shell_command'].includes(event.tool_name)) {
    const command = input.command ?? input.cmd;
    if (typeof command !== 'string') return null;
    // A reminder, never shell-command enforcement or shell interpretation.
    if (/(?:^|[;&|\n]\s*)\s*git\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?commit(?:\s|$)/.test(command)) return { kind: 'commit', paths: [] };
  }
  return null;
}

async function readJson(root, localPath, maxBytes, signal) {
  const parts = localPath.split('/');
  for (let index = 1; index < parts.length; index++) {
    const entry = await lstat(join(root, ...parts.slice(0, index)));
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe hook cache parent.');
  }
  const path = join(root, localPath);
  // Nonblocking open also keeps an accidental FIFO from stalling a session.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('Invalid hook cache file.');
    const bytes = await handle.readFile({ encoding: 'utf8', signal });
    if (Buffer.byteLength(bytes) > maxBytes) throw new Error('Hook cache grew beyond its size limit.');
    return JSON.parse(bytes);
  } finally { await handle.close(); }
}

function pathInRoot(root, cwd, path) {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const local = relative(root, absolute).split('\\').join('/');
  return !local || local === '..' || local.startsWith('../') || isAbsolute(local) ? null : local;
}

function graphIndex(graph, expired) {
  if (!graph || ![1, 2].includes(graph.schemaVersion) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Invalid cached graph.');
  const nodes = new Map(), owners = new Map(), dependencies = new Map(), dependents = new Map();
  for (const node of graph.nodes) {
    if (expired()) throw new Error('Hook deadline exceeded.');
    if (!node || typeof node.id !== 'string' ||
        (node.kind === 'file' && typeof node.path !== 'string')) throw new Error('Invalid graph node.');
    nodes.set(node.id, node);
  }
  for (const edge of graph.edges) {
    if (expired()) throw new Error('Hook deadline exceeded.');
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') throw new Error('Invalid graph edge.');
    if (edge.kind === 'implemented-by' && nodes.get(edge.from)?.kind === 'block' && nodes.get(edge.to)?.kind === 'file') {
      const path = nodes.get(edge.to).path;
      owners.set(path, [...(owners.get(path) || []), nodes.get(edge.from)]);
    }
    if (edge.kind === 'depends-on' || edge.link === true &&
        nodes.get(edge.from)?.kind === 'block' && nodes.get(edge.to)?.kind === 'block') {
      dependencies.set(edge.from, [...(dependencies.get(edge.from) || []), edge.to]);
      dependents.set(edge.to, [...(dependents.get(edge.to) || []), edge.from]);
    }
  }
  // Manifests also own declared creation paths that have no file node yet.
  for (const node of nodes.values()) {
    if (expired()) throw new Error('Hook deadline exceeded.');
    if (node.kind !== 'block') continue;
    const files = node.manifest?.files || [];
    if (!Array.isArray(files)) throw new Error('Invalid block file boundary.');
    for (const path of files) {
      if (typeof path !== 'string') throw new Error('Invalid block file boundary.');
      const previous = owners.get(path) || [];
      if (!previous.some((owner) => owner.id === node.id)) owners.set(path, [...previous, node]);
    }
  }
  return { nodes, owners, dependencies, dependents };
}

/** Cached guidance only: never scans, runs Git, writes files or executes agent input. */
export async function hookCheck(event, { root = process.cwd(), deadlineMs = 500 } = {}) {
  const start = performance.now();
  const budget = Math.min(500, Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs) : 500);
  const expired = () => performance.now() - start >= budget;
  const normalized = normalizeEvent(event);
  if (!normalized || expired()) return allow();
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((done) => {
    timer = setTimeout(() => { controller.abort(); done(allow()); }, budget);
  });
  const check = async () => {
    const base = resolve(root);
    const config = await readJson(base, '.blocks/config.json', 1024 * 1024, controller.signal);
    if (expired() || !config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 1 ||
        (config.enforcement?.agents !== undefined && !['guide', 'block'].includes(config.enforcement.agents))) return allow();
    if (normalized.kind === 'commit') return { decision: 'allow', context: 'Block Beaver: run `block-beaver audit --staged` before committing.' };
    const graph = await readJson(base, '.blocks/view/graph.json', MAX_GRAPH_BYTES, controller.signal);
    const index = graphIndex(graph, expired);
    const cwd = typeof event.cwd === 'string' ? resolve(event.cwd) : base;
    const contexts = [], denied = [];
    for (const rawPath of normalized.paths) {
      if (expired()) return allow();
      const path = pathInRoot(base, cwd, rawPath);
      if (!path) {
        if (normalized.kind === 'edit') denied.push(`${rawPath} is outside this repository's block boundaries`);
        continue;
      }
      const file = index.nodes.get(`file:${path}`);
      const owners = [...(index.owners.get(path) || [])];
      // The graph deliberately keeps manifest metadata outside implementation
      // coverage. Its explicit association supplies context without adding a
      // synthetic implemented-by edge or changing the cached graph.
      const manifestOwner = file?.familyRole === 'manifest' && typeof file.owningBlock === 'string'
        ? index.nodes.get(file.owningBlock) : null;
      if (manifestOwner?.kind === 'block' && !owners.some((owner) => owner.id === manifestOwner.id)) owners.push(manifestOwner);
      const usedBy = [...new Set([...(file?.usedBy || []), ...(manifestOwner?.kind === 'block' ? manifestOwner.usedBy || [] : [])])];
      if (usedBy.length > 1) contexts.push(`Block Beaver: ${path} is used by apps: ${usedBy.join(', ')}.`);
      if (!owners.length) {
        if (normalized.kind === 'edit') {
          contexts.push(`Block Beaver: ${path} is outside every block. Place it in a block or record a justified coverage exception.`);
          denied.push(`${path} has no owning block`);
        }
        continue;
      }
      for (const owner of owners) {
        const depends = index.dependencies.get(owner.id) || owner.dependencies || owner.manifest?.dependencies || [];
        const dependents = index.dependents.get(owner.id) || [];
        if (file?.familyRole === 'manifest' && manifestOwner?.id === owner.id) {
          contexts.push(`Block Beaver: ${path} is the typed manifest for ${owner.id}. Dependencies: ${depends.join(', ') || 'none'}. Dependents: ${dependents.join(', ') || 'none'}. Keep its implementation boundary and family links aligned, then run \`block-beaver gen --check\` and audit. Manifest metadata is separate from implementation coverage.`);
        } else {
          contexts.push(`Block Beaver: ${path} belongs to ${owner.id}. Dependencies: ${depends.join(', ') || 'none'}. Dependents: ${dependents.join(', ') || 'none'}. Stay inside its declared files and declare new block links.`);
        }
      }
    }
    if (expired()) return allow();
    if (config.enforcement?.agents === 'block' && denied.length) {
      return { decision: 'deny', reason: `Block Beaver: ${denied.join('; ')}. Declare the file in a block. To record a scoped coverage exception, run \`block-beaver exception <id> --rule coverage-ratchet --allowance 1 --paths <path> --reason <reason>\` and audit. An exception does not replace block ownership for editing.` };
    }
    return contexts.length ? { decision: 'allow', context: contexts.join('\n') } : allow();
  };
  try { return await Promise.race([check().catch(allow), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Native PreToolUse JSON for both Claude and Codex; null means silent success. */
export function formatHookOutput(result, { agent = 'claude' } = {}) {
  if (!['claude', 'codex'].includes(agent) || !result) return null;
  if (result.decision === 'deny' && typeof result.reason === 'string' && result.reason) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } };
  }
  if (result.decision === 'allow' && typeof result.context === 'string' && result.context) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: result.context } };
  }
  return null;
}
