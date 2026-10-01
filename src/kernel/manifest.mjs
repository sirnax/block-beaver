import { deepFreeze, validate } from './schema.mjs';

// Pure initialization lets bundlers discard unused schemas while keeping exports immutable.
export const coreManifestSchema = /* @__PURE__ */ deepFreeze({
  type: 'object', shape: {
    id: {type:'string',min:1,pattern:'^[A-Za-z0-9][A-Za-z0-9._-]*$'},
    family: {type:'string',min:1,pattern:'^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$'},
    version: {type:'union',options:[{type:'number',integer:true,min:1},{type:'string',min:1}]},
    name: {type:'string',min:1}, description: {type:'string',min:1}, rationale: {type:'string',min:1},
    implementation: {type:'union',options:[{type:'object',shape:{kind:{type:'literal',value:'module'},module:{type:'string',min:1}}},{type:'object',shape:{kind:{type:'literal',value:'none'}}}]},
    files: {type:'array',items:{type:'string',min:1},optional:true}
  }
});

export function validateManifest(manifest, {mode = 'build', family} = {}) {
  if (!['build','runtime'].includes(mode)) throw new TypeError('Manifest mode must be build or runtime');
  const schema = family ? {type:'object',shape:{...family.fields.shape,...coreManifestSchema.shape},unknown:family.fields.unknown} : coreManifestSchema;
  // Leave unknown unset instead of adding undefined to the JSON schema.
  if (schema.unknown === undefined) delete schema.unknown;
  const result = validate(schema,manifest);
  if (result.errors.some(error => error.code === 'not-json')) return result;
  const errors = [...result.errors];
  if (manifest && typeof manifest === 'object') {
    if (family && manifest.family !== family.id) errors.push({path:'$.family',code:'literal',message:`Expected family ${family.id}`});
    if (family && manifest.implementation && !family.implementation.includes(manifest.implementation.kind)) errors.push({path:'$.implementation.kind',code:'enum',message:'Implementation kind is not allowed by this family'});
    if (mode === 'runtime' && manifest.implementation?.kind === 'module') errors.push({path:'$.implementation',code:'runtime-module',message:'Runtime manifests cannot name modules'});
    if (mode === 'runtime' && Object.hasOwn(manifest,'files')) errors.push({path:'$.files',code:'runtime-files',message:'Runtime manifests cannot name files'});
  }
  return errors.length ? {valid:false,value:undefined,errors} : result;
}
