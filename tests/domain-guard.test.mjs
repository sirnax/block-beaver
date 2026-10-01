import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

test('shipped source contains no proof-of-concept vocabulary or registry paths', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const denylist = JSON.parse(await readFile(new URL('./fixtures/domain-denylist.json', import.meta.url), 'utf8'));
  assert.ok(denylist.length > 0 && denylist.every((value) => typeof value === 'string' && value.length > 0));
  const findings = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const source = await readFile(path, 'utf8');
        for (const token of denylist) if (source.includes(token)) findings.push(`${relative(root, path)}: ${token}`);
      }
    }
  }
  await Promise.all([visit(join(root, 'src')), visit(join(root, 'bin'))]);
  assert.deepEqual(findings, [], 'Move repository-specific vocabulary into target family config: ' + findings.join(', '));
});
