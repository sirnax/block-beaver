import { readFile } from 'node:fs/promises';
import { localBlockBeaverCommand } from './package-manager.mjs';

export const AGENT_FILES = Object.freeze({ codex: 'AGENTS.md', claude: 'CLAUDE.md', cursor: '.cursor/rules/block-beaver.mdc', copilot: '.github/copilot-instructions.md' });
export const CURSOR_HEADER = '---\ndescription: Build this project in blocks and keep its block map current\nalwaysApply: true\n---\n\n';
export const HOOK_ID = 'block-beaver';

export const FAMILIES_START = '<!-- block-beaver:families:start -->';
export const FAMILIES_END = '<!-- block-beaver:families:end -->';

const cell = (value) => `\`${String(value).replaceAll('`', "'").replaceAll('|', '\\|')}\``;

/**
 * Families guidance derived only from `.blocks/config.json`. Empty (no bytes) without a usable
 * `families` array, so installs without families render exactly as before. Deterministic: config order.
 */
export function renderFamiliesSection(config, level = 3) {
  const entries = (Array.isArray(config?.families) ? config.families : []).filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.manifests === 'string' && typeof entry.contract === 'string');
  if (!entries.length) return '';
  const outputs = entries.map((entry) => entry.registry?.out).filter((out) => typeof out === 'string');
  const receipts = config?.enforcement?.receipts;
  const lines = [
    `${'#'.repeat(level)} Typed families`, '',
    'This project defines typed block families in `.blocks/config.json`. Each family owns its manifest contract; the manifest is the proposal for a typed block.', '',
    '| Family | Manifests | Contract |', '| --- | --- | --- |',
    ...entries.map((entry) => `| ${cell(entry.id)} | ${cell(entry.manifests)} | ${cell(entry.contract)} |`), '',
    '- Add a block = add one manifest that matches its family glob; links to other blocks are manifest fields.',
    '- After changing manifests or generator inputs, run `block-beaver gen --root .` (not only `block-beaver update --root .`), then `block-beaver gen --check --root .` to report drift without writing.',
    outputs.length ? `- Never hand-edit outputs written by \`gen\` (registries: ${outputs.map(cell).join(', ')}, and every other output \`gen --check\` lists); change the manifests or generators and regenerate.` : '- Never hand-edit outputs written by `gen`; change the manifests or generators and regenerate.',
    '- Inspect families with `block-beaver kit list` and `block-beaver kit describe FAMILY`; check data with `block-beaver kit validate` and `kit compose`; use `block-beaver kit create FAMILY ID` for families with a scaffold.',
  ];
  if (receipts === 'optional' || receipts === 'off') lines.push(`- \`enforcement.receipts\` is \`${receipts}\`: typed-family manifests are reviewed in the pull request rather than through a block receipt.`);
  return `${FAMILIES_START}\n${lines.join('\n')}\n${FAMILIES_END}\n`;
}

export function renderAgentInstructions(config) {
  const families = renderFamiliesSection(config, 3);
  return `## Block Beaver\n\nRead and follow .blocks/WORKFLOW.md before changing code.\n- Install this project’s locked dependencies with its package manager and use the pinned local Block Beaver command (for npm, \`npx --no-install block-beaver\`).\n- Inspect the owning block, its files, dependencies, and dependents using a fresh source graph and the authoritative registry.\n- Record purpose, rationale, file boundaries, interfaces, and verification before implementing a feature. Stay inside the agreed block; declare new connections and propose new blocks through plan/propose/check/review.\n- Review .blocks/config.json application ownership and health. Preserve owner-controlled entries; resolve imports using the owning app's tsconfig.\n- Require review JSON \`readyForApproval: true\` before approval. After authorized approval, run \`block-beaver integrate ROADMAP BLOCK --root .\` to apply the reviewed changes and create their receipt. Stage the receipt and matching workflow evidence with the implementation.\n- Run \`block-beaver audit --root .\` before finishing and \`block-beaver audit --staged --root .\` before committing. Record justified exceptions with the CLI.\n- After source or manifest changes, run \`block-beaver update --root .\` to regenerate the graph and view. Never hand-edit generated outputs.\n- Run \`block-beaver start --root .\` for live updates. Report affected blocks and verification at completion.\n${families ? `\n${families}` : ''}`;
}

const readTemplate = async (url) => (await readFile(url, 'utf8')).replaceAll('\r\n', '\n');

export async function readInstallTemplates(config) {
  const [workflow, skill, workflowReference, appsReference, legacyWorkflow011, legacyWorkflow020] = await Promise.all([
    readTemplate(new URL('../templates/block-workflow.md', import.meta.url)),
    readTemplate(new URL('../templates/agent-skill/SKILL.md', import.meta.url)),
    readTemplate(new URL('../templates/agent-skill/references/workflow.md', import.meta.url)),
    readTemplate(new URL('../templates/agent-skill/references/apps.md', import.meta.url)),
    readTemplate(new URL('../templates/legacy/0.1.1-workflow.md', import.meta.url)),
    readTemplate(new URL('../templates/legacy/0.2.0-workflow.md', import.meta.url)),
  ]);
  const families = renderFamiliesSection(config, 2);
  const append = (text) => families ? `${text.replace(/\n*$/, '\n')}\n${families}` : text;
  return { workflow: append(workflow), legacyWorkflows: [legacyWorkflow011, legacyWorkflow020], skill: append(skill), references: { 'references/workflow.md': workflowReference, 'references/apps.md': appsReference } };
}

/** Direct node invocation of the installed binary; forward slashes work in sh, cmd and PowerShell. */
export const DIRECT_HOOK_COMMAND = 'node node_modules/block-beaver/bin/block-beaver.mjs';

/**
 * Only native fields; the CLI command carries the stable managed id. Hooks run on every tool call
 * under a one second timeout, so they start the installed binary with node instead of a package
 * manager wrapper. Yarn PnP has no node_modules, so `pnp` keeps the Yarn launcher.
 */
export function renderAgentHook(agent, { manager = 'npm', pnp = false } = {}) {
  if (!['claude', 'codex'].includes(agent)) throw new Error('Native hooks require the claude or codex agent.');
  const launcher = localBlockBeaverCommand(manager);
  const command = pnp ? launcher : DIRECT_HOOK_COMMAND;
  return { matcher: agent === 'codex' ? 'Read|Edit|Write|apply_patch|Bash' : 'Read|Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: `${command} hook-check --agent ${agent} --hook-id ${HOOK_ID}`, timeout: 1 }] };
}

// Exact historical init bodies are trusted migration inputs, not broad patterns.
export const LEGACY_AGENT_INSTRUCTIONS = `## Block Beaver\n\nRead and follow the project workflow at .blocks/WORKFLOW.md before changing code.\n- Read the existing block registry and fresh source graph; define the feature's files, interfaces, dependencies, and checks before implementing it.\n- Keep block manifests aligned with implementation and use the bounded plan/propose/check/review workflow. Existing project registries remain authoritative.\n- After source or manifest changes, run \`block-beaver update --root .\` to regenerate .blocks/view/index.html and graph.json. Do not hand-edit generated views.\n- Run \`block-beaver start --root .\` for a live map that refreshes during development. Report block changes and verification at completion.\n`;
export const LEGACY_APP_INSTRUCTION = '- Review .blocks/config.json app ownership and app health; use `block-beaver detect` to preview additions and `detect --write` to apply them. Preserve owner-controlled app entries and resolve imports using each owning app’s tsconfig.\n';
