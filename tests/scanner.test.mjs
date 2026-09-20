import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepository } from '../src/scanner.mjs';
import { inspect, impact } from '../src/graph.mjs';
import { makeProposal, suggestBoundaries } from '../src/contracts.mjs';

test('scanner maps TypeScript, React and import relationships to source evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'block-studio-scan-'));
  try {
    await mkdir(join(root, 'src', 'feature'), { recursive: true });
    await writeFile(join(root, 'src', 'feature', 'math.ts'), 'export function add(a: number, b: number) { return a + b }\n');
    await writeFile(join(root, 'src', 'feature', 'Card.tsx'), 'import { add } from "./math";\nexport function Card() { const n = add(1, 2); return <p>{n}</p> }\n');
    await writeFile(join(root, 'src', 'main.tsx'), 'import { Card } from "./feature/Card";\nexport function App() { return <Card /> }\n');
    const graph = await scanRepository(root);
    assert.equal(graph.summary.files, 3);
    assert.ok(graph.nodes.some((n) => n.id === 'symbol:src/feature/Card.tsx#Card' && n.kind === 'component'));
    const call = graph.edges.find((e) => e.from === 'symbol:src/feature/Card.tsx#Card' && e.to === 'symbol:src/feature/math.ts#add');
    assert.equal(call.kind, 'calls');
    assert.equal(call.evidence.line, 2);
    assert.ok(graph.edges.some((e) => e.from === 'symbol:src/main.tsx#App' && e.to === 'symbol:src/feature/Card.tsx#Card' && e.kind === 'renders'));
    assert.equal(inspect(graph, 'Card').node.name, 'Card');
    assert.ok(impact(graph, 'symbol:src/feature/math.ts#add').count > 0);
    assert.ok(suggestBoundaries(graph).some((b) => b.folder === 'src/feature'));
    const proposal = makeProposal({ id: 'feature', name: 'Feature', description: 'A feature.', rationale: 'The math and card form one feature.', files: ['src/feature/math.ts', 'src/feature/Card.tsx'] }, graph);
    assert.equal(proposal.check.valid, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
