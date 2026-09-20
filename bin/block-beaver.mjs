#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scanRepository } from '../src/scanner.mjs';
import { attachTeacakeRegistry, attachLocalRegistry, runTeacakeKit } from '../src/adapter.mjs';
import { inspect, search } from '../src/graph.mjs';
import { suggestBoundaries, makeProposal } from '../src/contracts.mjs';
import { createRoadmap, propose, repair, checkSlice, review, approve, reject, resume } from '../src/workflow.mjs';
import { runAgentAdapter } from '../src/agent.mjs';

const [command, ...args] = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; };
const positional = args.filter((value, index) => !value.startsWith('--') && (index === 0 || !args[index - 1].startsWith('--')));
const root = resolve(option('root', process.cwd()));
const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

try {
  if (!command || command === 'help') {
    process.stdout.write('Block Beaver\n  scan [--root PATH] [--full true]\n  inspect ID [--root PATH]\n  search QUERY [--root PATH] [--kind KIND]\n  kit COMMAND INPUT.json [--root TEACAKE_PATH]\n  agent --exec PATH --scope file1,file2 [--root PATH]\n  plan ROADMAP_ID --scope file1,file2 [--root PATH] [--title TITLE]\n  propose ROADMAP_ID PROPOSAL.json [--root PATH]\n  repair ROADMAP_ID SLICE_ID PROPOSAL.json [--root PATH]\n  check ROADMAP_ID SLICE_ID [--root PATH]\n  review ROADMAP_ID SLICE_ID [--root PATH]\n  approve ROADMAP_ID SLICE_ID [--root PATH]\n  reject ROADMAP_ID SLICE_ID --reason TEXT [--root PATH]\n  resume ROADMAP_ID [--root PATH]\n');
    process.exit(0);
  }
  if (command === 'resume') { print(await resume(root, positional[0])); process.exit(0); }
  if (command === 'reject') { print(await reject(root, positional[0], positional[1], option('reason', ''))); process.exit(0); }
  const graph = await attachTeacakeRegistry(await attachLocalRegistry(await scanRepository(root)));
  if (command === 'scan') print(option('full') === 'true' ? graph : { root, fingerprint: graph.fingerprint, summary: graph.summary, adapter: graph.adapter || null });
  else if (command === 'inspect') print(inspect(graph, positional[0]));
  else if (command === 'search') print(search(graph, positional.join(' '), { kind: option('kind') }));
  else if (command === 'kit') { if (graph.adapter !== 'teacake') throw new Error('The TeaCake kit adapter is unavailable for this repository.'); print(await runTeacakeKit(root, positional[0], positional[1] ? JSON.parse(await readFile(resolve(positional[1]), 'utf8')) : {})); }
  else if (command === 'agent') print(await runAgentAdapter(option('exec'), { graph, scope: option('scope', '').split(',').filter(Boolean) }));
  else if (command === 'plan') { const id = positional[0]; print({ roadmap: await createRoadmap(root, id, graph, { title: option('title', id), scope: option('scope', '').split(',').filter(Boolean) }), suggestions: suggestBoundaries(graph) }); }
  else if (command === 'propose') { const raw = JSON.parse(await readFile(resolve(positional[1]), 'utf8')); const candidate = raw.manifest ? raw : makeProposal(raw, graph); print(await propose(root, positional[0], candidate, graph)); }
  else if (command === 'repair') { const raw = JSON.parse(await readFile(resolve(positional[2]), 'utf8')); const candidate = raw.manifest ? raw : makeProposal(raw, graph); print(await repair(root, positional[0], positional[1], candidate, graph)); }
  else if (command === 'check') print(await checkSlice(root, positional[0], positional[1], graph));
  else if (command === 'review') print(await review(root, positional[0], positional[1], graph));
  else if (command === 'approve') print(await approve(root, positional[0], positional[1], graph));
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
