import { deepFreeze } from './schema.mjs';
export { s, isSchema, assertSchema, validate, coerce, read } from './schema.mjs';
export { coreManifestSchema, validateManifest } from './manifest.mjs';
export { createRegistry, compose, composeSafe, KernelError } from './registry.mjs';

function define(value,kind) {
  Object.defineProperty(value,Symbol.for(`block-beaver.${kind}`),{value:true,enumerable:false});
  return deepFreeze(value);
}
export function defineFamily(value) { return define(value,'family'); }
export function defineGenerator(value) { return define(value,'generator'); }
export function isFamily(value) { return !!value && value[Symbol.for('block-beaver.family')] === true; }
export function isGenerator(value) { return !!value && value[Symbol.for('block-beaver.generator')] === true; }
