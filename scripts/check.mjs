import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

for (const path of ['server.mjs', 'worker.mjs', ...await sourceFiles('bin'), ...await sourceFiles('src'), ...await sourceFiles('scripts'), ...await sourceFiles('tests')]) {
  execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
}
execFileSync(process.execPath, ['--test'], { stdio: 'inherit' });
