import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export async function installationFixture(t) {
  const container = await mkdtemp(join(tmpdir(), 'block-beaver-install-'));
  const root = join(container, 'host');
  // Retries cover git's background maintenance still writing under .git/objects when a test ends.
  t.after(() => rm(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(root);
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/index.ts'), 'export const ready = true;\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'host', version: '1.0.0', private: true, main: 'src/index.ts' }) + '\n');
  return root;
}

export function packageRunner(root, calls = []) {
  return async (executable, args, options) => {
    calls.push({ executable, args, options });
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const version = args.find((arg) => arg.startsWith('block-beaver@'))?.slice('block-beaver@'.length);
    if (args.includes('uninstall') || args.includes('remove')) delete pkg.devDependencies?.['block-beaver'];
    else if (version) pkg.devDependencies = { ...pkg.devDependencies, 'block-beaver': version };
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    const pinned = pkg.devDependencies?.['block-beaver'];
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'host', lockfileVersion: 3, packages: { '': { devDependencies: pkg.devDependencies ?? {} }, ...(pinned ? { 'node_modules/block-beaver': { version: pinned } } : {}) } }, null, 2) + '\n');
    return { exitCode: 0 };
  };
}

export async function snapshot(root, prefix = '') {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path));
    else result[path] = await readFile(join(root, path), 'utf8');
  }
  return result;
}
