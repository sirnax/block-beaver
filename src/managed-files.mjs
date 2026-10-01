import { createHash } from 'node:crypto';
import { readProjectFile } from './project-files.mjs';
import { detectPackageManager, localBlockBeaverCommand } from './package-manager.mjs';
import { AGENT_FILES, CURSOR_HEADER, LEGACY_AGENT_INSTRUCTIONS, LEGACY_APP_INSTRUCTION, readInstallTemplates, renderAgentHook, renderAgentInstructions } from './install-templates.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const lf = (text) => text.replaceAll('\r\n', '\n');
const statePath = '.blocks/managed-files.json';
const marker = (name, ignore) => ignore ? `# block-beaver:${name}` : `<!-- block-beaver:${name} -->`;
const normalizeAgents = (agents) => [...new Set(agents.map((agent) => agent === 'agents' ? 'codex' : agent))].sort();

function sectionBounds(text, path, ignore) {
  const begin = marker('start', ignore), end = marker('end', ignore);
  const starts = text.split(begin).length - 1, ends = text.split(end).length - 1;
  if (starts !== ends || starts > 1 || (starts && text.indexOf(begin) > text.indexOf(end))) throw new Error(`Ambiguous Block Beaver managed markers in ${path}.`);
  if (!starts) return null;
  const start = text.indexOf(begin), finish = text.indexOf(end) + end.length;
  const inner = text.slice(start + begin.length, finish - end.length).replace(/^\r?\n/, '');
  const hashPattern = ignore ? /^# block-beaver:hash ([a-f0-9]{64})\r?\n/ : /^<!-- block-beaver:hash ([a-f0-9]{64}) -->\r?\n/;
  const hash = inner.match(hashPattern);
  return { start, finish, body: hash ? inner.slice(hash[0].length) : inner, hash: hash?.[1] };
}

function renderSection(body, version, ignore) {
  const content = `${marker(`version ${version}`, ignore)}\n${body.trimEnd()}\n`;
  return `${marker('start', ignore)}\n${marker(`hash ${digest(content)}`, ignore)}\n${content}${marker('end', ignore)}`;
}

function planText(before, spec, { version, operation, force }) {
  const text = before ?? '';
  const bounds = sectionBounds(text, spec.path, spec.ignore);
  if (!bounds) {
    if (operation === 'uninstall') return before;
    if (spec.owned && before !== null) throw new Error(`Unmarked owner-authored file conflicts with managed output: ${spec.path}`);
    return text + (text ? (text.endsWith('\n') ? '\n' : '\n\n') : spec.prefix || '') + renderSection(spec.body, version, spec.ignore) + '\n';
  }
  // Old init sections did not carry hashes. Only their exact known bodies may be
  // adopted; unknown unverified content needs explicit force.
  const legacyBodies = spec.legacyBodies || [spec.body];
  const verified = bounds.hash ? digest(bounds.body) === bounds.hash || digest(lf(bounds.body)) === bounds.hash : legacyBodies.some((body) => lf(bounds.body) === lf(body).trimEnd() + '\n');
  if (!verified && !force) throw new Error(`Owner edits inside managed content in ${spec.path}; review the diff and use --force to replace only the managed section.`);
  if (operation === 'uninstall') {
    const remaining = text.slice(0, bounds.start) + text.slice(bounds.finish).replace(/^\r?\n/, '');
    if (spec.owned && (!remaining.trim() || remaining.trim() === (spec.prefix || '').trim())) return null;
    return remaining;
  }
  const rendered = renderSection(spec.body, version, spec.ignore);
  if (lf(text.slice(bounds.start, bounds.finish)) === rendered) return before;
  return text.slice(0, bounds.start) + rendered + text.slice(bounds.finish);
}

const ownsHook = (handler) => handler?.type === 'command' && typeof handler.command === 'string' && /^(?:(?:npx --no-install|pnpm exec|yarn exec|bunx --no-install) )?block-beaver hook-check(?:\s|$)/.test(handler.command) && /(?:^|\s)--hook-id\s+block-beaver(?:\s|$)/.test(handler.command);
function parseJson(text, path) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${path}; existing content was preserved.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected a JSON object in ${path}.`);
  return value;
}

function hookPlan(before, agent, operation, force, previousHash, manager) {
  const path = agent === 'claude' ? '.claude/settings.json' : '.codex/hooks.json';
  if (before === null && operation === 'uninstall') return { content: null, hash: null };
  const settings = before === null ? {} : parseJson(before, path);
  if (settings.hooks != null && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error(`Expected hooks object in ${path}.`);
  const hooks = settings.hooks || {};
  const groups = hooks.PreToolUse || [];
  if (!Array.isArray(groups)) throw new Error(`Expected hooks.PreToolUse array in ${path}.`);
  const existing = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) throw new Error(`Malformed PreToolUse matcher group in ${path}.`);
    for (const handler of group.hooks.filter(ownsHook)) existing.push({ matcher: group.matcher, hooks: [handler] });
  }
  const currentHash = digest(JSON.stringify(existing));
  if (previousHash && previousHash !== currentHash && !force) throw new Error(`Owner edits to Block Beaver hook in ${path}; review the diff and use --force.`);
  const desired = renderAgentHook(agent, { manager });
  const trusted = [desired, renderAgentHook(agent)];
  if (!previousHash && existing.length && !trusted.some((hook) => JSON.stringify(existing) === JSON.stringify([hook])) && !force) throw new Error(`Unverified Block Beaver hook in ${path}; existing content was preserved.`);
  const preserved = groups.flatMap((group) => {
    const handlers = group.hooks.filter((handler) => !ownsHook(handler));
    return handlers.length ? [{ ...group, hooks: handlers }] : [];
  });
  if (operation !== 'uninstall') preserved.push(desired);
  if (preserved.length) hooks.PreToolUse = preserved;
  else delete hooks.PreToolUse;
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  const empty = Object.keys(settings).length === 0;
  const content = operation === 'uninstall' && empty ? null : JSON.stringify(settings, null, 2) + '\n';
  // Preserve the exact bytes of owner JSON when no managed handler was present.
  if (operation === 'uninstall' && !existing.length) return { content: before, hash: null };
  return { content, hash: operation === 'uninstall' ? null : digest(JSON.stringify([desired])) };
}

function codexFeaturePlan(before, options) {
  const text = before ?? '';
  const path = '.codex/config.toml';
  const bounds = sectionBounds(text, path, true);
  if (bounds) {
    const content = planText(before, { path, body: 'hooks = true', ignore: true }, options);
    if (options.operation === 'uninstall' && content.trim() === '[features]') return null;
    return content;
  }
  if (options.operation === 'uninstall') return before;
  const dotted = text.match(/^\s*features\.hooks\s*=\s*(true|false)\s*(?:#.*)?$/m);
  const headers = [...text.matchAll(/^\s*\[([^\]\n]+)\]\s*(?:#.*)?$/gm)];
  const featureTables = headers.filter((entry) => ['features', '"features"', "'features'"].includes(entry[1].trim()));
  if (featureTables.length > 1 || /^\s*(?:features|"features"|'features')\s*=/m.test(text)) throw new Error('Unsupported Codex features table in .codex/config.toml; enable hooks explicitly without changing owner configuration.');
  const feature = featureTables[0];
  const end = feature ? headers.find((entry) => entry.index > feature.index)?.index ?? text.length : text.length;
  const table = feature ? text.slice(feature.index + feature[0].length, end) : '';
  const flag = table.match(/^\s*(?:hooks|"hooks"|'hooks')\s*=\s*(true|false)\s*(?:#.*)?$/m) || dotted;
  if (flag?.[1] === 'false') throw new Error('Owner disabled Codex hooks in .codex/config.toml; enable features.hooks explicitly to install agent hooks.');
  if (flag?.[1] === 'true') return before;
  if (/^\s*(?:hooks|"hooks"|'hooks')\s*=/m.test(table) || /^\s*features\.hooks\s*=/m.test(text)) throw new Error('Unsupported Codex features.hooks value in .codex/config.toml; enable it explicitly.');
  const section = renderSection('hooks = true', options.version, true) + '\n';
  if (feature) return text.slice(0, end) + (text.slice(0, end).endsWith('\n') ? '' : '\n') + section + text.slice(end);
  return text + (text ? (text.endsWith('\n') ? '\n' : '\n\n') : '') + '[features]\n' + section;
}

/**
 * Read-only desired-state plan. Callers preflight all conflicts, then apply files
 * with the safe compare-before-write writer. content:null means delete that file.
 */
export async function planManagedFiles({ root, version, config = {}, agents = [], manager, operation = 'install', force = false }) {
  if (!['install', 'upgrade', 'uninstall'].includes(operation)) throw new Error('Managed operation must be install, upgrade, or uninstall.');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Managed files require a semantic package version.');
  const selected = normalizeAgents(typeof agents === 'string' ? agents.split(',') : agents);
  if (selected.some((agent) => !Object.hasOwn(AGENT_FILES, agent))) throw new Error('Agents must be claude, codex, cursor, or copilot.');
  const templates = await readInstallTemplates();
  const files = [], conflicts = [], diagnostics = [];
  try {
    if (!manager) manager = await readProjectFile(root, 'package.json') === null ? 'npm' : await detectPackageManager(root);
    localBlockBeaverCommand(manager);
  } catch (error) {
    conflicts.push({ path: 'package.json', message: error.message });
    return { files, conflicts, diagnostics };
  }
  const options = { version, operation, force };
  const specifications = [
    { path: '.blocks/WORKFLOW.md', body: templates.workflow, legacyBodies: [templates.workflow, ...templates.legacyWorkflows], owned: true, kind: 'workflow' },
    { path: '.blocks/.gitignore', body: '/worktrees/\n/cache/\n/view/', legacyBodies: ['/worktrees/\n/view/'], ignore: true, kind: 'ignore' },
    ...selected.map((agent) => ({ path: AGENT_FILES[agent], body: renderAgentInstructions(), legacyBodies: [renderAgentInstructions(), LEGACY_AGENT_INSTRUCTIONS, LEGACY_AGENT_INSTRUCTIONS + LEGACY_APP_INSTRUCTION], prefix: agent === 'cursor' ? CURSOR_HEADER : '', owned: agent === 'cursor', kind: 'instructions' })),
  ];
  for (const agent of selected.filter((agent) => ['claude', 'codex'].includes(agent))) {
    const directory = agent === 'claude' ? '.claude/skills/block-beaver' : '.agents/skills/block-beaver';
    const frontmatter = templates.skill.match(/^---\n[\s\S]*?\n---\n\n/)?.[0] || '';
    specifications.push({ path: `${directory}/SKILL.md`, body: templates.skill.slice(frontmatter.length), prefix: frontmatter, owned: true, kind: 'skill' });
    for (const [path, body] of Object.entries(templates.references)) specifications.push({ path: `${directory}/${path}`, body, owned: true, kind: 'skill' });
  }
  for (const spec of specifications) {
    let before;
    try {
      before = await readProjectFile(root, spec.path);
      const content = planText(before, spec, options);
      files.push({ path: spec.path, before, content, kind: spec.kind });
    } catch (error) { conflicts.push({ path: spec.path, message: error.message, before, expected: spec.body }); }
  }
  let stateBefore, state = { schemaVersion: 1, generator: 'block-beaver', version, hooks: {} };
  try {
    stateBefore = await readProjectFile(root, statePath);
    if (stateBefore !== null) {
      state = parseJson(stateBefore, statePath);
      if (state.generator !== 'block-beaver' || state.schemaVersion !== 1 || !state.hooks || typeof state.hooks !== 'object' || Array.isArray(state.hooks)) throw new Error(`Unrecognized managed state in ${statePath}.`);
    }
  } catch (error) {
    conflicts.push({ path: statePath, message: error.message, before: stateBefore });
    return { files, conflicts, diagnostics };
  }
  if (selected.includes('codex')) {
    const path = '.codex/config.toml';
    let before;
    try {
      before = await readProjectFile(root, path);
      files.push({ path, before, content: codexFeaturePlan(before, options), kind: 'agent-config' });
    } catch (error) { conflicts.push({ path, message: error.message, before }); }
  }
  const nextHooks = { ...state.hooks };
  for (const agent of selected.filter((agent) => ['claude', 'codex'].includes(agent))) {
    const path = agent === 'claude' ? '.claude/settings.json' : '.codex/hooks.json';
    let before;
    try {
      before = await readProjectFile(root, path);
      const result = hookPlan(before, agent, operation, force, state.hooks[agent]?.hash, manager);
      files.push({ path, before, content: result.content, kind: 'hooks' });
      if (result.hash) nextHooks[agent] = { hash: result.hash };
      else delete nextHooks[agent];
    } catch (error) { conflicts.push({ path, message: error.message, before }); }
  }
  const content = operation === 'uninstall' && !Object.keys(nextHooks).length ? null : JSON.stringify({ ...state, version, hooks: nextHooks }, null, 2) + '\n';
  files.push({ path: statePath, before: stateBefore, content, kind: 'managed-state' });
  if (config.enforcement?.agents === 'block') diagnostics.push('Agent enforcement is configured to block; hook-check still fails open on errors and timeouts.');
  return { files, conflicts, diagnostics };
}
