import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const harness = fileURLToPath(new URL('../scripts/live-editor-battle.mjs', import.meta.url));

test('live hook shim preserves native stdin and records actual PreToolUse envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'block-beaver-hook-shim-'));
  try {
    const log = join(root, 'invocations.jsonl');
    const event = { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', model: 'gpt-6.1-sol', cwd: root,
      tool_input: { command: '*** Begin Patch\n*** Add File: src/unowned.ts\n+export const value = 1;\n*** End Patch' } };
    const input = JSON.stringify(event) + '\n';
    const result = spawnSync(process.execPath, [harness, '--shim', 'block-beaver', 'hook-check', '--agent', 'codex', '--hook-id', 'block-beaver'], {
      input, encoding: 'utf8', env: { ...process.env, BLOCK_BEAVER_LIVE_LOG: log,
        BLOCK_BEAVER_LIVE_REAL: JSON.stringify([process.execPath, '-e', "process.stdin.pipe(process.stdout)", '--']) },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, input);
    const record = JSON.parse((await readFile(log, 'utf8')).trim());
    assert.deepEqual(record.nativeEvent, event);
    assert.equal(record.status, 0);
    assert.equal(record.stdout, input);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('harness rejects unsupported models and flags without launching an editor', () => {
  for (const args of [['codex', 'normal'], ['claude', 'normal', '--codex-hook-trust'], []]) {
    const result = spawnSync(process.execPath, [harness, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage: .* claude normal\|bypass\|failed\|drift/);
  }
});
