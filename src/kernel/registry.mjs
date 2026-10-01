import { deepFreeze } from './schema.mjs';
import { validateManifest } from './manifest.mjs';

export class KernelError extends Error {
  constructor(code,message,details) { super(message); this.name = 'KernelError'; this.code = code; this.details = details; }
}
export function createRegistry(family,manifests) {
  const all = [...manifests].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byId = Object.create(null);
  for (const manifest of all) {
    if (manifest.family !== family) throw new KernelError('family-mismatch',`Manifest ${manifest.id} belongs to ${manifest.family}, expected ${family}`,{id:manifest.id,family:manifest.family,expected:family});
    if (Object.hasOwn(byId,manifest.id)) throw new KernelError('duplicate-id',`Duplicate manifest ${manifest.id}`,{family,id:manifest.id});
    byId[manifest.id] = deepFreeze(manifest);
  }
  return deepFreeze({family,all,byId,get(id) { return byId[id]; },has(id) { return Object.hasOwn(byId,id); }});
}
export function compose(base,dynamic,{family} = {}) {
  for (const manifest of dynamic) {
    const result = validateManifest(manifest,{mode:'runtime',family});
    if (!result.valid) throw new KernelError('manifest-invalid','Invalid runtime manifest',{errors:result.errors});
  }
  return createRegistry(base.family,[...base.all,...dynamic]);
}
