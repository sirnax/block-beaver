import { readFile } from 'node:fs/promises';
import { readProjectFile, writeProjectFiles } from './project-files.mjs';
import { updateProject } from './block-map.mjs';

const begin = '<!-- block-beaver:start -->';
const end = '<!-- block-beaver:end -->';
const instruction = `## Block Beaver\n\nRead and follow the project workflow at .blocks/WORKFLOW.md before changing code.\n- Read the existing block registry and fresh source graph; define the feature's files, interfaces, dependencies, and checks before implementing it.\n- Keep block manifests aligned with implementation and use the bounded plan/propose/check/review workflow. Existing project registries remain authoritative.\n- After source or manifest changes, run \`block-beaver update --root .\` to regenerate .blocks/view/index.html and graph.json. Do not hand-edit generated views.\n- Run \`block-beaver start --root .\` for a live map that refreshes during development. Report block changes and verification at completion.\n`;
const cursorHeader = '---\ndescription: Build this project in blocks and keep its block map current\nalwaysApply: true\n---\n\n';
const editorFiles = { agents: 'AGENTS.md', claude: 'CLAUDE.md', cursor: '.cursor/rules/block-beaver.mdc', copilot: '.github/copilot-instructions.md' };

function managedSection(before, body, path, prefix = '') {
  const text = before || '';
  const starts = text.split(begin).length - 1, ends = text.split(end).length - 1;
  if (starts !== ends || starts > 1 || (starts && text.indexOf(begin) > text.indexOf(end))) throw new Error(`Ambiguous Block Beaver section in ${path}. Existing content was preserved.`);
  const section = `${begin}\n${body.trimEnd()}\n${end}`;
  if (starts) {
    if (prefix && !text.startsWith(prefix)) throw new Error(`Unexpected rule header in ${path}. Existing content was preserved.`);
    return text.slice(0, text.indexOf(begin)) + section + text.slice(text.indexOf(end) + end.length);
  }
  if (prefix && before !== null) throw new Error(`Existing file conflicts with generated rule: ${path}`);
  return text + (text ? (text.endsWith('\n') ? '\n' : '\n\n') : prefix) + section + '\n';
}

export async function initializeProject(root, { editor = 'all' } = {}) {
  const editors = editor === 'all' ? Object.keys(editorFiles) : [editor];
  if (editors.some((name) => !Object.hasOwn(editorFiles, name))) throw new Error('Editor must be all, agents, claude, cursor, or copilot.');
  const guide = await readFile(new URL('../templates/block-workflow.md', import.meta.url), 'utf8');
  const specifications = [
    { path: '.blocks/WORKFLOW.md', body: guide },
    { path: '.blocks/.gitignore', body: '/worktrees/\n/view/', ignore: true },
    ...editors.map((name) => ({ path: editorFiles[name], body: instruction, prefix: name === 'cursor' ? cursorHeader : '' })),
  ];
  const files = [];
  for (const item of specifications) {
    const before = await readProjectFile(root, item.path);
    // Gitignore uses comment markers; the same managed-section rules preserve project additions.
    const source = item.ignore ? before?.replaceAll('# block-beaver:start', begin).replaceAll('# block-beaver:end', end) ?? null : before;
    let content = managedSection(source, item.body, item.path, item.prefix);
    if (item.ignore) content = content.replaceAll(begin, '# block-beaver:start').replaceAll(end, '# block-beaver:end');
    files.push({ path: item.path, before, content });
  }
  // Scan before installing instructions so an invalid target fails without instruction edits.
  const view = await updateProject(root);
  const changed = await writeProjectFiles(root, files);
  return { initialized: true, editors, changed, view: view.html, watch: 'block-beaver start --root .' };
}
