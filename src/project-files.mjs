import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

async function projectPath(root, relative) {
  if (!relative || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid integration path.');
  const base = await realpath(root);
  let path = base;
  for (const [index, part] of relative.split('/').entries()) {
    path = join(path, part);
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw new Error(`Integration path is a symlink: ${relative}`);
      if (index < relative.split('/').length - 1 && !entry.isDirectory()) throw new Error(`Integration parent is not a directory: ${relative}`);
      if (index === relative.split('/').length - 1 && (!entry.isFile() || entry.nlink !== 1)) throw new Error(`Integration path is not an independent regular file: ${relative}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { base, path: resolve(base, relative) };
}

export async function readProjectFile(root, relative) {
  const { path } = await projectPath(root, relative);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await handle.readFile('utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

/** Preflight all outputs before writing; compare existing bytes before replacing them. */
export async function writeProjectFiles(root, files) {
  for (const file of files) {
    const current = await readProjectFile(root, file.path);
    if (current !== file.before) throw new Error(`File changed during integration: ${file.path}`);
  }
  const changed = [];
  for (const file of files) {
    if (file.before === file.content) continue;
    const { base, path } = await projectPath(root, file.path);
    if (file.content === null) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || await handle.readFile('utf8') !== file.before) throw new Error(`File changed during integration: ${file.path}`);
        const current = await lstat(path);
        if (current.ino !== info.ino || current.dev !== info.dev) throw new Error(`File changed during integration: ${file.path}`);
        await unlink(path);
        changed.push(file.path);
      } finally { await handle.close(); }
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    if (await realpath(dirname(path)) !== dirname(path)) throw new Error(`Integration parent changed: ${file.path}`);
    const flags = file.before === null ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW : constants.O_RDWR | constants.O_NOFOLLOW;
    const handle = await open(join(base, file.path), flags, 0o644);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error(`Unsafe integration file: ${file.path}`);
      if (file.before !== null && await handle.readFile('utf8') !== file.before) throw new Error(`File changed during integration: ${file.path}`);
      const bytes = Buffer.from(file.content);
      let offset = 0;
      while (offset < bytes.length) offset += (await handle.write(bytes, offset, bytes.length - offset, offset)).bytesWritten;
      await handle.truncate(bytes.length);
      changed.push(file.path);
    } finally { await handle.close(); }
  }
  return changed;
}
