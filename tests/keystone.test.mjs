import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepository } from '../src/scanner.mjs';
import { approve, checkSlice, createRoadmap, propose, repair, review } from '../src/workflow.mjs';

const original = 'export const value: number = 1;\n';
const replacement = 'export const value: number = 2;\n';
const contract = '{"name":"new-contract"}\n';
const selector = 'export const selectValue = () => 2;\n';

async function withRepository(run, { extraFiles = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-keystone-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, '.gitignore'), '.blocks/\nnode_modules/\n');
    await writeFile(join(root, 'src', 'consumer.ts'), original);
    for (const [path, content] of Object.entries(extraFiles)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    }
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial']);
    await run(root, await scanRepository(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function candidate(graph, { patches, files, verification = [] } = {}) {
  return {
    manifest: {
      schemaVersion: 1, id: 'keystone', version: 1, name: 'Keystone',
      description: 'Scoped creation fixture.', rationale: 'One bounded feature.',
      files: files ?? ['src/consumer.ts', 'src/contracts/new.json', 'src/selectors/new.ts'],
      dependencies: [], verification,
    },
    patches: patches ?? [
      { path: 'src/consumer.ts', baseHash: graph.hashes['src/consumer.ts'], content: replacement },
      { op: 'create', path: 'src/contracts/new.json', content: contract },
      { op: 'create', path: 'src/selectors/new.ts', content: selector },
    ],
  };
}

async function planned(root, graph, { createScope = ['src/contracts/new.json', 'src/selectors/new.ts'], scope = ['src/consumer.ts'], proposal } = {}) {
  await createRoadmap(root, 'keystone-roadmap', graph, { scope, createScope });
  const result = await propose(root, 'keystone-roadmap', proposal ?? candidate(graph), graph);
  assert.equal(result.accepted, true, JSON.stringify(result.check));
  return 'keystone-roadmap';
}

async function rejected(operation) {
  try {
    const result = await operation();
    assert.ok(result?.accepted === false || result?.pass === false,
      `Expected rejection or failed check, received ${JSON.stringify(result)}`);
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error;
    assert.ok(error instanceof Error);
  }
}

test('declared JSON and TypeScript creation passes plan, propose, check, review, and approval', async () => {
  await withRepository(async (root, graph) => {
    const roadmap = await planned(root, graph);
    const result = await checkSlice(root, roadmap, 'keystone', graph);
    assert.equal(result.pass, true, JSON.stringify(result));
    assert.equal(await readFile(join(result.worktree, 'src/contracts/new.json'), 'utf8'), contract);
    assert.equal(await readFile(join(result.worktree, 'src/selectors/new.ts'), 'utf8'), selector);
    const reviewed = await review(root, roadmap, 'keystone', graph);
    assert.equal(reviewed.integrity.matches, true);
    assert.deepEqual(new Set(reviewed.changeSet.map((change) => change.path)), new Set([
      'src/consumer.ts', 'src/contracts/new.json', 'src/selectors/new.ts', '.blocks/manifests/keystone.json',
    ]));
    assert.equal((await approve(root, roadmap, 'keystone', graph)).status, 'approved');
  });
});

test('creation scope rejects collisions, unsafe paths, ignored paths, and symlink parents', async (t) => {
  await withRepository(async (root, graph) => {
    await writeFile(join(root, 'src/existing.json'), '{}\n'); // Existing but absent from the source graph.
    const outside = await mkdtemp(join(tmpdir(), 'block-beaver-keystone-outside-'));
    try {
      await symlink(outside, join(root, 'src/link'));
      for (const path of ['src/existing.json', '../escape.ts', '/tmp/escape.ts', '.blocks/other.json', 'node_modules/out.ts', 'src/link/out.ts']) {
        await t.test(path, async () => {
          await rejected(() => createRoadmap(root, `invalid-${Math.random().toString(36).slice(2)}`, graph,
            { scope: ['src/consumer.ts'], createScope: [path] }));
        });
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('create operations require declared scope and cannot duplicate a path', async (t) => {
  await withRepository(async (root, graph) => {
    await createRoadmap(root, 'keystone-roadmap', graph, { scope: ['src/consumer.ts'], createScope: ['src/contracts/new.json'] });
    const base = candidate(graph, { files: ['src/consumer.ts', 'src/contracts/new.json'], patches: [
      { path: 'src/consumer.ts', baseHash: graph.hashes['src/consumer.ts'], content: replacement },
      { op: 'create', path: 'src/contracts/new.json', content: contract },
    ] });
    await t.test('undeclared create', async () => {
      const proposal = structuredClone(base);
      proposal.patches[1].path = 'src/contracts/other.json';
      await rejected(() => propose(root, 'keystone-roadmap', proposal, graph));
    });
    await t.test('duplicate operations', async () => {
      const proposal = structuredClone(base);
      proposal.patches.push({ ...proposal.patches[1] });
      await rejected(() => propose(root, 'keystone-roadmap', proposal, graph));
    });
    await t.test('create operation on replacement path', async () => {
      const proposal = structuredClone(base);
      proposal.patches[0] = { op: 'create', path: 'src/consumer.ts', content: replacement };
      await rejected(() => propose(root, 'keystone-roadmap', proposal, graph));
    });
  });
});

test('stale replacement hashes and malformed JSON or TypeScript fail before worktree approval', async (t) => {
  for (const [name, mutate] of [
    ['stale hash', (proposal) => { proposal.patches[0].baseHash = 'stale'; }],
    ['malformed JSON', (proposal) => { proposal.patches[1].content = '{ bad json'; }],
    ['malformed TypeScript', (proposal) => { proposal.patches[2].content = 'export const value = (;\n'; }],
  ]) {
    await t.test(name, async () => {
      await withRepository(async (root, graph) => {
        const proposal = candidate(graph);
        mutate(proposal);
        await createRoadmap(root, 'keystone-roadmap', graph,
          { scope: ['src/consumer.ts'], createScope: ['src/contracts/new.json', 'src/selectors/new.ts'] });
        let accepted;
        try { accepted = await propose(root, 'keystone-roadmap', proposal, graph); }
        catch (error) { assert.ok(error instanceof Error); return; }
        if (accepted.accepted) await rejected(() => checkSlice(root, 'keystone-roadmap', 'keystone', graph));
      });
    });
  }
});

test('creation fails if a planned target appears before check', async () => {
  await withRepository(async (root, graph) => {
    const roadmap = await planned(root, graph);
    await mkdir(join(root, 'src/contracts'), { recursive: true });
    await writeFile(join(root, 'src/contracts/new.json'), '{}\n');
    await rejected(() => checkSlice(root, roadmap, 'keystone', graph));
  });
});

test('repair preserves each patch path and operation', async () => {
  await withRepository(async (root, graph) => {
    const roadmap = await planned(root, graph);
    const changedOperation = candidate(graph);
    changedOperation.patches[1] = { path: 'src/contracts/new.json', baseHash: 'bogus', content: contract };
    await rejected(() => repair(root, roadmap, 'keystone', changedOperation, graph));
    const changedPath = candidate(graph);
    changedPath.patches[1].path = 'src/contracts/other.json';
    await rejected(() => repair(root, roadmap, 'keystone', changedPath, graph));
    const valid = candidate(graph);
    valid.patches[1].content = '{"name":"repaired"}\n';
    assert.equal((await repair(root, roadmap, 'keystone', valid, graph)).accepted, true);
  });
});

test('a failed verification can be repaired without changing patch operations', async () => {
  await withRepository(async (root, graph) => {
    const proposal = candidate(graph, { verification: ['node fail.cjs'] });
    const roadmap = await planned(root, graph, { proposal });
    const failed = await checkSlice(root, roadmap, 'keystone', graph);
    assert.equal(failed.pass, false);
    assert.equal(failed.verification[0].pass, false);
    const fixed = candidate(graph, { verification: ['node pass.cjs'] });
    assert.equal((await repair(root, roadmap, 'keystone', fixed, graph)).accepted, true);
    const passed = await checkSlice(root, roadmap, 'keystone', graph);
    assert.equal(passed.pass, true, JSON.stringify(passed));
    assert.equal((await review(root, roadmap, 'keystone', graph)).integrity.matches, true);
  }, { extraFiles: {
    'fail.cjs': 'process.exit(1);\n',
    'pass.cjs': 'process.exit(0);\n',
  } });
});

test('a changed created file after failed verification blocks a repaired retry', async () => {
  await withRepository(async (root, graph) => {
    const proposal = candidate(graph, { verification: ['node fail.cjs'] });
    const roadmap = await planned(root, graph, { proposal });
    const failed = await checkSlice(root, roadmap, 'keystone', graph);
    assert.equal(failed.pass, false);
    await writeFile(join(failed.worktree, 'src/contracts/new.json'), '{"name":"unexplained-edit"}\n');
    const fixed = candidate(graph, { verification: ['node pass.cjs'] });
    assert.equal((await repair(root, roadmap, 'keystone', fixed, graph)).accepted, true);
    await rejected(() => checkSlice(root, roadmap, 'keystone', graph));
  }, { extraFiles: {
    'fail.cjs': 'process.exit(1);\n',
    'pass.cjs': 'process.exit(0);\n',
  } });
});

test('verification cannot leave undeclared generated files in a passing worktree', async () => {
  await withRepository(async (root, graph) => {
    const proposal = candidate(graph, { verification: ['node generate.cjs'] });
    const roadmap = await planned(root, graph, { proposal });
    await rejected(() => checkSlice(root, roadmap, 'keystone', graph));
  }, { extraFiles: { 'generate.cjs': "require('node:fs').writeFileSync('generated.json', '{}\\n');\n" } });
});

test('declared verification output appears in the reviewed change set', async () => {
  await withRepository(async (root, graph) => {
    const proposal = candidate(graph, { verification: ['node generate.cjs'] });
    const roadmap = await planned(root, graph, {
      createScope: ['src/contracts/new.json', 'src/selectors/new.ts', 'src/generated.json'], proposal,
    });
    const passed = await checkSlice(root, roadmap, 'keystone', graph);
    assert.equal(passed.pass, true, JSON.stringify(passed));
    const reviewed = await review(root, roadmap, 'keystone', graph);
    assert.equal(reviewed.integrity.matches, true);
    assert.ok(reviewed.changeSet.some((change) => change.path === 'src/generated.json'),
      JSON.stringify(reviewed.changeSet));
    assert.equal((await approve(root, roadmap, 'keystone', graph)).status, 'approved');
  }, { extraFiles: { 'generate.cjs': "require('node:fs').writeFileSync('src/generated.json', '{}\\n');\n" } });
});

test('editing the saved proposal after a passing check invalidates review and approval', async () => {
  await withRepository(async (root, graph) => {
    const roadmap = await planned(root, graph);
    const passed = await checkSlice(root, roadmap, 'keystone', graph);
    assert.equal(passed.pass, true, JSON.stringify(passed));
    const proposalPath = join(root, '.blocks/roadmaps', roadmap, 'keystone.proposal.json');
    const saved = JSON.parse(await readFile(proposalPath, 'utf8'));
    saved.patches[0].content = 'export const value: number = 3;\n';
    await writeFile(proposalPath, JSON.stringify(saved, null, 2) + '\n');
    const reviewed = await review(root, roadmap, 'keystone', graph);
    assert.equal(reviewed.integrity.matches, false, JSON.stringify(reviewed.integrity));
    await assert.rejects(approve(root, roadmap, 'keystone', graph));
  });
});

test('a symlinked managed worktree cannot redirect recheck writes into the source checkout', async () => {
  await withRepository(async (root, graph) => {
    const roadmap = await planned(root, graph);
    const passed = await checkSlice(root, roadmap, 'keystone', graph);
    assert.equal(passed.pass, true, JSON.stringify(passed));
    const worktree = passed.worktree;
    await rename(worktree, `${worktree}.saved`);
    await symlink(root, worktree, 'dir');
    const sourceBefore = await readFile(join(root, 'src/consumer.ts'), 'utf8');
    const originalManifest = join(root, '.blocks/manifests/keystone.json');
    await assert.rejects(readFile(originalManifest, 'utf8'), { code: 'ENOENT' });
    await rejected(() => checkSlice(root, roadmap, 'keystone', graph));
    assert.equal(await readFile(join(root, 'src/consumer.ts'), 'utf8'), sourceBefore);
    await assert.rejects(readFile(originalManifest, 'utf8'), { code: 'ENOENT' });
  });
});

test('review exposes and approval rejects changes made after a passing check', async (t) => {
  const mutations = [
    ['extra untracked file', async (worktree) => writeFile(join(worktree, 'extra.txt'), 'late\n')],
    ['tracked file outside scope', async (worktree) => writeFile(join(worktree, 'README.md'), 'late\n')],
    ['replacement content', async (worktree) => writeFile(join(worktree, 'src/consumer.ts'), 'export const value = 9;\n')],
    ['created content', async (worktree) => writeFile(join(worktree, 'src/contracts/new.json'), '{}\n')],
    ['created file mode', async (worktree) => chmod(join(worktree, 'src/selectors/new.ts'), 0o755)],
    ['created file symlink', async (worktree) => {
      await rm(join(worktree, 'src/contracts/new.json'));
      await symlink('../consumer.ts', join(worktree, 'src/contracts/new.json'));
      assert.equal((await lstat(join(worktree, 'src/contracts/new.json'))).isSymbolicLink(), true);
    }],
    ['created file deletion', async (worktree) => rm(join(worktree, 'src/contracts/new.json'))],
    ['manifest content', async (worktree) => writeFile(join(worktree, '.blocks/manifests/keystone.json'), '{}\n')],
    ['worktree HEAD', async (worktree) => {
      execFileSync('git', ['-C', worktree, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
        'commit', '--allow-empty', '-qm', 'moved head']);
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      await withRepository(async (root, graph) => {
        const roadmap = await planned(root, graph);
        const passed = await checkSlice(root, roadmap, 'keystone', graph);
        assert.equal(passed.pass, true, JSON.stringify(passed));
        await mutate(passed.worktree);
        const reviewed = await review(root, roadmap, 'keystone', graph);
        assert.equal(reviewed.integrity.matches, false, JSON.stringify(reviewed.integrity));
        if (name === 'extra untracked file' || name === 'tracked file outside scope') {
          const path = name === 'extra untracked file' ? 'extra.txt' : 'README.md';
          assert.ok(reviewed.changeSet.some((change) => change.path === path), JSON.stringify(reviewed.changeSet));
        }
        await assert.rejects(approve(root, roadmap, 'keystone', graph));
      }, { extraFiles: { 'README.md': 'Initial readme.\n' } });
    });
  }
});
