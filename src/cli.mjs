import { renderViewModule, viewDetails } from './view-exports.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scanRepository } from './scanner.mjs';
import { attachProjectRegistry } from './adapter.mjs';
import { inspect, search } from './graph.mjs';
import { suggestBoundaries, makeProposal } from './contracts.mjs';
import { createRoadmap, propose, repair, checkSlice, review, approve, reject, resume } from './workflow.mjs';
import { runAgentAdapter } from './agent.mjs';
import { initializeProject } from './project-integration.mjs';
import { updateProject } from './block-map.mjs';
import { watchProject } from './project-watch.mjs';
import { detectProjectApps } from './project-model.mjs';
import { findSourceFiles } from './scanner.mjs';
import { writeProjectFiles, readProjectFile } from './project-files.mjs';
import { relative, isAbsolute } from 'node:path';
import { auditProject, integrateApproved, recordException } from './compliance.mjs';
import { git } from './compliance-git.mjs';

const [command, ...args] = process.argv.slice(2);
const flags = new Set(['write', 'strict', 'dry-run', 'force', 'fix-ignores', 'fix-excludes', 'staged', 'remove-data', 'yes']);
if (command === 'gen') flags.add('check');
if (command === 'baseline') flags.add('lower');
const options = new Map();
const positional = [];
for (let index = 0; index < args.length; index++) {
  const value = args[index];
  if (!value.startsWith('--')) { positional.push(value); continue; }
  const [name, inline] = value.slice(2).split(/=(.*)/s);
  if (inline !== undefined) options.set(name, inline);
  else if (flags.has(name)) options.set(name, true);
  else {
    if (!args[index + 1] || args[index + 1].startsWith('--')) { options.set('parseError', `Missing value for --${name}`); break; }
    options.set(name, args[++index]);
  }
}
const option = (name, fallback) => options.get(name) ?? fallback;
const root = resolve(option('root', process.cwd()));
const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
// Pipe writes are asynchronous, so exit only after stdout drains; the forced exit still stops `start`, child processes and timers.
const exit = (code) => new Promise(() => { process.exitCode = code; process.stdout.write('', () => process.exit(code)); });

try {
  if (option('parseError')) throw new Error(option('parseError'));
  if (!command || command === 'help') {
    process.stdout.write('Project integration\n  start [--root PATH] [--editor all|agents|claude|cursor|copilot] [--port 4175]\n  init [--root PATH] [--editor all|agents|claude|cursor|copilot]\n  update [--root PATH]\n  detect [--root PATH] [--write]\n  view --format module --out PATH [--detail full|map] [--max-bytes N] [--root PATH]\n  install [--agents claude,codex,cursor,copilot] [--dry-run]\n  upgrade [--dry-run] [--force]\n  baseline --lower [--root PATH] [--dry-run]\n  uninstall [--dry-run] [--remove-data --yes]\n  audit [--staged | --base SHA] [--strict]\n  integrate ROADMAP BLOCK\n  exception ID --reason TEXT --paths PATHS --check COMMAND\n\n');
    process.stdout.write('Block Beaver\n  scan [--root PATH] [--full true]\n  inspect ID [--root PATH]\n  search QUERY [--root PATH] [--kind KIND]\n  kit list|describe|validate|compose|create [ARGS] [--json JSON] [--dry-run] [--root PATH]\n  gen [--check] [--label TEXT]\n  history import FILE --map MAPPING.json\n  agent --exec PATH [--scope file1,file2] [--create new1,new2] [--root PATH]\n  plan ROADMAP_ID [--scope file1,file2] [--create new1,new2] [--root PATH] [--title TITLE]\n  propose ROADMAP_ID PROPOSAL.json [--root PATH]\n  repair ROADMAP_ID SLICE_ID PROPOSAL.json [--root PATH]\n  check ROADMAP_ID SLICE_ID [--root PATH]\n  review ROADMAP_ID SLICE_ID [--root PATH]\n  approve ROADMAP_ID SLICE_ID [--root PATH]\n  reject ROADMAP_ID SLICE_ID --reason TEXT [--root PATH]\n  resume ROADMAP_ID [--root PATH]\n');
    await exit(0);
  }
  if (command === 'init') { print(await initializeProject(root, { editor: option('editor', 'all') })); await exit(0); }
  if (['install', 'upgrade', 'uninstall'].includes(command)) {
    if (command === 'uninstall' && option('remove-data') && !option('yes')) throw new Error('Deleting .blocks data requires explicit --remove-data --yes.');
    const { installProject, upgradeProject, uninstallProject } = await import('./install.mjs');
    const action = { install: installProject, upgrade: upgradeProject, uninstall: uninstallProject }[command];
    const result = await action(root, { agents: option('agents')?.split(',').filter(Boolean), dryRun: option('dry-run', false), force: option('force', false), fixIgnores: option('fix-ignores', false), fixExcludes: option('fix-excludes', false), removeData: option('remove-data', false) });
    print(result);
    await exit(result.conflicts?.length || (!result.dryRun && !result.complete) ? 2 : 0);
  }
  if (command === 'baseline') {
    if (!option('lower')) throw new Error('Use baseline --lower [--dry-run]; the baseline can only be lowered.');
    const { lowerBaseline } = await import('./baseline.mjs');
    print(await lowerBaseline(root, { dryRun: option('dry-run', false) }));
    await exit(0);
  }
  if (command === 'audit') {
    if (option('staged') && option('base')) throw new Error('Choose either --staged or --base.');
    const base = option('base') === 'merge-base' ? (await git(root, ['merge-base', 'HEAD', process.env.BLOCK_BEAVER_BASE_REF || 'origin/main'])).trim() : option('base');
    const result = await auditProject(root, { mode: base ? 'range' : option('staged') ? 'staged' : 'working', base, strict: option('strict', false) });
    print(result);
    await exit(result.pass ? 0 : 2);
  }
  if (command === 'integrate') {
    const result = await integrateApproved(root, positional[0], positional[1]);
    const { graph, ...view } = await updateProject(root);
    print({ ...result, view: view.html, summary: graph.summary });
    await exit(0);
  }
  if (command === 'exception') {
    print(await recordException(root, positional[0], { reason: option('reason'), paths: option('paths', '').split(',').filter(Boolean), check: option('check'), rule: option('rule'), allowance: option('allowance') === undefined ? undefined : Number(option('allowance')) }));
    await exit(0);
  }
  if (command === 'gen') {
    const { generateProject } = await import('./families/commands.mjs');
    const result = await generateProject(root, { check: option('check', false), dryRun: option('dry-run', false), label: option('label') });
    print(result);
    await exit(result.pass === false || result.ok === false || result.diagnostics?.some((item) => item.severity === 'error') ? 2 : 0);
  }
  if (command === 'history') {
    if (positional[0] !== 'import' || !positional[1] || !option('map')) throw new Error('Use history import FILE --map MAPPING.json.');
    const { importProjectHistory } = await import('./families/commands.mjs');
    const result = await importProjectHistory(root, resolve(root, positional[1]), resolve(root, option('map')), { dryRun: option('dry-run', false) });
    print(result);
    await exit(result.ok === false ? 2 : 0);
  }
  if (command === 'kit') {
    const { runKit } = await import('./families/kit.mjs');
    let input;
    try {
      let json = option('json', '{}');
      if (json === '-') { json = ''; for await (const chunk of process.stdin) { json += chunk; if (Buffer.byteLength(json) > 1_000_000) throw new Error('Kit input exceeds 1MB.'); } }
      input = JSON.parse(json);
    } catch (error) {
      print({ ok: false, error: { code: 'kit-input-invalid', message: error.message } });
      await exit(2);
    }
    const result = await runKit(root, positional[0], positional.slice(1), { input, dryRun: option('dry-run', false) });
    print(result);
    const partialWrite = !option('dry-run', false) && result.error?.details?.written?.length > 0;
    await exit(result.ok ? 0 : partialWrite ? 1 : 2);
  }
  if (command === 'detect') {
    const { config, added, disappeared, diagnostics } = await detectProjectApps(root, { paths: await findSourceFiles(root), write: option('write', false) === true });
    print({ config, added, disappeared, diagnostics });
    await exit(0);
  }
  if (command === 'view') {
    if (option('format', 'html') !== 'module') throw new Error('Use view --format module --out PATH.');
    if (!option('out')) throw new Error('view requires --out PATH.');
    const output = relative(root, resolve(root, option('out'))).split('\\').join('/');
    if (!output || output.startsWith('../') || isAbsolute(output)) throw new Error('View output must be inside the project root.');
    const before = await readProjectFile(root, output);
    if (before !== null && !/^\/\/ generated by block-beaver from the project graph; do not edit\.?\n/i.test(before)) throw new Error(`Existing file conflicts with generated view module: ${output}`);
    const registryPath = '.blocks/view-exports.json';
    const registryBefore = await readProjectFile(root, registryPath);
    // Only the legacy registry may exist; its entries carry over into the primary one this command writes.
    const registry = JSON.parse(registryBefore ?? await readProjectFile(root, '.blocks/view/exports.json') ?? '[]');
    if (!Array.isArray(registry)) throw new Error('Invalid generated view exports registry.');
    const index = registry.findIndex((entry) => entry?.path === output);
    let configured;
    try { configured = JSON.parse(await readProjectFile(root, '.blocks/config.json') ?? 'null')?.view?.detail; } catch { /* config-valid reports an unreadable config */ }
    // An explicit flag wins; an existing entry keeps its recorded detail; a new one follows config, then full.
    const detail = option('detail') ?? (index < 0 ? configured : registry[index].detail ?? 'full') ?? 'full';
    if (!viewDetails.includes(detail)) throw new Error(`${option('detail') !== undefined ? '--detail' : index < 0 ? 'Config view.detail' : 'Registered view detail'} must be full or map.`);
    const limit = option('max-bytes');
    if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) throw new Error('--max-bytes must be a positive integer.');
    const record = { path: output, format: 'module', ...(detail === 'full' ? {} : { detail }) };
    if (index < 0) registry.push(record);
    else if ((registry[index].detail ?? 'full') !== detail) { const { detail: previous, ...rest } = registry[index]; registry[index] = { ...rest, ...record }; }
    registry.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    // Measure the module from a scan that already honours the final registry, then write exactly those bytes.
    const scanned = await attachProjectRegistry(await scanRepository(root, { writeConfig: false, extraExports: registry.map((entry) => entry?.path).filter((path) => typeof path === 'string') }));
    const content = renderViewModule({ ...scanned, root: '.', generator: 'block-beaver' }, { detail });
    const bytes = Buffer.byteLength(content);
    if (limit !== undefined && bytes > Number(limit)) {
      print({ ok: false, error: { code: 'view-too-large', message: `View module is ${bytes} bytes, over the ${limit} byte limit${detail === 'full' ? '; try --detail map' : ''}.`, details: { output, bytes, limit: Number(limit), detail } } });
      await exit(2);
    }
    await writeProjectFiles(root, [{ path: registryPath, before: registryBefore, content: JSON.stringify(registry, null, 2) + '\n' }]);
    await updateProject(root);
    const changed = await writeProjectFiles(root, [{ path: output, before, content }]);
    print({ output, bytes, changed, detail });
    await exit(0);
  }
  if (command === 'update') {
    const { graph, ...result } = await updateProject(root);
    print({ ...result, summary: graph.summary });
    await exit(0);
  }
  if (command === 'start') {
    const integration = await initializeProject(root, { editor: option('editor', 'all') });
    const session = await watchProject(root, { port: Number(option('port', '4175')) });
    print({ ...integration, url: session.url, message: 'Open this URL for the live block map. Keep this process running for automatic updates; Ctrl+C stops it.' });
    await new Promise((done, fail) => {
      const stop = () => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        session.close().then(done, fail);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await exit(0);
  }
  if (command === 'resume') { print(await resume(root, positional[0])); await exit(0); }
  if (command === 'reject') { print(await reject(root, positional[0], positional[1], option('reason', ''))); await exit(0); }
  const graph = await attachProjectRegistry(await scanRepository(root, { strict: option('strict', false) === true, writeConfig: !['inspect', 'search', 'kit'].includes(command) }));
  if (command === 'scan') {
    const moduleBytes = Buffer.byteLength(renderViewModule(graph));
    print(option('full') === 'true' ? { ...graph, summary: { ...graph.summary, viewModuleBytes: moduleBytes } } : { root, fingerprint: graph.fingerprint, summary: { ...graph.summary, viewModuleBytes: moduleBytes }, adapter: graph.adapter || null });
  }
  else if (command === 'inspect') print(inspect(graph, positional[0]));
  else if (command === 'search') print(search(graph, positional.join(' '), { kind: option('kind') }));
  else if (command === 'agent') print(await runAgentAdapter(option('exec'), { graph, scope: option('scope', '').split(',').filter(Boolean), createScope: option('create', '').split(',').filter(Boolean) }));
  else if (command === 'plan') { const id = positional[0]; print({ roadmap: await createRoadmap(root, id, graph, { title: option('title', id), scope: option('scope', '').split(',').filter(Boolean), createScope: option('create', '').split(',').filter(Boolean) }), suggestions: suggestBoundaries(graph) }); }
  else if (command === 'propose') { const raw = JSON.parse(await readFile(resolve(positional[1]), 'utf8')); const candidate = raw.manifest ? raw : makeProposal(raw, graph); print(await propose(root, positional[0], candidate, graph)); }
  else if (command === 'repair') { const raw = JSON.parse(await readFile(resolve(positional[2]), 'utf8')); const candidate = raw.manifest ? raw : makeProposal(raw, graph); print(await repair(root, positional[0], positional[1], candidate, graph)); }
  else if (command === 'check') print(await checkSlice(root, positional[0], positional[1], graph));
  else if (command === 'review') print(await review(root, positional[0], positional[1], graph));
  else if (command === 'approve') print(await approve(root, positional[0], positional[1], graph));
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  if (command === 'hook-check') await exit(0);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
