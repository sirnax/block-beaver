import { readFile } from 'node:fs/promises';
import { localBlockBeaverCommand } from './package-manager.mjs';

export const AGENT_FILES = Object.freeze({ codex: 'AGENTS.md', claude: 'CLAUDE.md', cursor: '.cursor/rules/block-beaver.mdc', copilot: '.github/copilot-instructions.md' });
export const CURSOR_HEADER = '---\ndescription: Build this project in blocks and keep its block map current\nalwaysApply: true\n---\n\n';
export const HOOK_ID = 'block-beaver';

export function renderAgentInstructions() {
  return `## Block Beaver\n\nRead and follow .blocks/WORKFLOW.md before changing code.\n- Inspect the owning block, its files, dependencies, and dependents using a fresh source graph and the authoritative registry.\n- Record purpose, rationale, file boundaries, interfaces, and verification before implementing a feature. Stay inside the agreed block; declare new connections and propose new blocks through plan/propose/check/review.\n- Review .blocks/config.json application ownership and health. Preserve owner-controlled entries; resolve imports using the owning app's tsconfig.\n- Require review JSON \`readyForApproval: true\` before approval. After authorized approval, run \`block-beaver integrate ROADMAP BLOCK --root .\` to apply the reviewed changes and create their receipt. Stage the receipt and matching workflow evidence with the implementation.\n- Run \`block-beaver audit --root .\` before finishing and \`block-beaver audit --staged --root .\` before committing. Record justified exceptions with the CLI.\n- After source or manifest changes, run \`block-beaver update --root .\` to regenerate the graph and view. Never hand-edit generated outputs.\n- Run \`block-beaver start --root .\` for live updates. Report affected blocks and verification at completion.\n`;
}

export async function readInstallTemplates() {
  const [workflow, skill, workflowReference, appsReference, legacyWorkflow011, legacyWorkflow020] = await Promise.all([
    readFile(new URL('../templates/block-workflow.md', import.meta.url), 'utf8'),
    readFile(new URL('../templates/agent-skill/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../templates/agent-skill/references/workflow.md', import.meta.url), 'utf8'),
    readFile(new URL('../templates/agent-skill/references/apps.md', import.meta.url), 'utf8'),
    readFile(new URL('../templates/legacy/0.1.1-workflow.md', import.meta.url), 'utf8'),
    readFile(new URL('../templates/legacy/0.2.0-workflow.md', import.meta.url), 'utf8'),
  ]);
  return { workflow, legacyWorkflows: [legacyWorkflow011, legacyWorkflow020], skill, references: { 'references/workflow.md': workflowReference, 'references/apps.md': appsReference } };
}

/** Only native fields; the CLI command carries the stable managed id. */
export function renderAgentHook(agent, { manager = 'npm' } = {}) {
  if (!['claude', 'codex'].includes(agent)) throw new Error('Native hooks require the claude or codex agent.');
  return { matcher: agent === 'codex' ? 'Read|Edit|Write|apply_patch|Bash' : 'Read|Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: `${localBlockBeaverCommand(manager)} hook-check --agent ${agent} --hook-id ${HOOK_ID}`, timeout: 1 }] };
}

// Exact historical init bodies are trusted migration inputs, not broad patterns.
export const LEGACY_AGENT_INSTRUCTIONS = `## Block Beaver\n\nRead and follow the project workflow at .blocks/WORKFLOW.md before changing code.\n- Read the existing block registry and fresh source graph; define the feature's files, interfaces, dependencies, and checks before implementing it.\n- Keep block manifests aligned with implementation and use the bounded plan/propose/check/review workflow. Existing project registries remain authoritative.\n- After source or manifest changes, run \`block-beaver update --root .\` to regenerate .blocks/view/index.html and graph.json. Do not hand-edit generated views.\n- Run \`block-beaver start --root .\` for a live map that refreshes during development. Report block changes and verification at completion.\n`;
export const LEGACY_APP_INSTRUCTION = '- Review .blocks/config.json app ownership and app health; use `block-beaver detect` to preview additions and `detect --write` to apply them. Preserve owner-controlled app entries and resolve imports using each owning app’s tsconfig.\n';
