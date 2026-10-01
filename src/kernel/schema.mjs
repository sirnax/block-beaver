export function deepFreeze(value, seen = new Set()) {
  if (value && (typeof value === 'object' || typeof value === 'function') && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    Object.freeze(value);
  }
  return value;
}

function jsonIssue(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return null;
  if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return path;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key === 'symbol') || keys.some(key => {
    if (Array.isArray(value) && key === 'length') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    return !descriptor.enumerable || !Object.hasOwn(descriptor,'value');
  }) || (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((key,i) => key !== String(i))))) return path;
  for (const key of Object.keys(value)) {
    const bad = jsonIssue(value[key], Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, seen);
    if (bad) return bad;
  }
  seen.delete(value);
  return null;
}

export function assertSchema(schema) {
  const seen = new Set();
  function check(n) {
    if (!n || typeof n !== 'object' || Array.isArray(n) || seen.has(n)) throw new TypeError('Invalid schema node');
    seen.add(n);
    const fields = { string: ['min','max','pattern'], number: ['integer','min','max'], boolean: [], literal: ['value'], enum: ['values'], array: ['items','min','max','unique'], object: ['shape','unknown'], record: ['values'], union: ['options'], unknown: [] };
    if (!Object.hasOwn(fields, n.type)) throw new TypeError('Unknown schema type');
    const allowed = ['type','optional','nullable','default','description', ...fields[n.type]];
    if (Object.keys(n).some(k => !allowed.includes(k))) throw new TypeError('Unknown schema property');
    for (const k of ['optional','nullable','integer','unique']) if (Object.hasOwn(n,k) && n[k] !== true) throw new TypeError(`Invalid ${k}`);
    if (Object.hasOwn(n,'description') && typeof n.description !== 'string') throw new TypeError('Invalid description');
    if (Object.hasOwn(n,'default') && jsonIssue(n.default)) throw new TypeError('Default must be JSON');
    for (const k of ['min','max']) if (Object.hasOwn(n,k) && (typeof n[k] !== 'number' || !Number.isFinite(n[k]) || (n.type !== 'number' && (!Number.isInteger(n[k]) || n[k] < 0)))) throw new TypeError(`Invalid ${k}`);
    if (n.min > n.max) throw new TypeError('min exceeds max');
    if (Object.hasOwn(n,'pattern')) { if (typeof n.pattern !== 'string') throw new TypeError('Invalid pattern'); try { new RegExp(n.pattern,'u'); } catch { throw new TypeError('Invalid pattern'); } }
    if (n.type === 'literal' && (!Object.hasOwn(n,'value') || (n.value !== null && !['string','number','boolean'].includes(typeof n.value)) || jsonIssue(n.value))) throw new TypeError('Invalid literal');
    if (n.type === 'enum' && (!Array.isArray(n.values) || !n.values.length || n.values.some(v => typeof v !== 'string') || new Set(n.values).size !== n.values.length)) throw new TypeError('Invalid enum');
    if (n.type === 'object') {
      if (!n.shape || typeof n.shape !== 'object' || Array.isArray(n.shape)) throw new TypeError('Invalid shape');
      if (n.unknown !== undefined && !['reject','allow'].includes(n.unknown)) throw new TypeError('Invalid unknown policy');
      Object.values(n.shape).forEach(check);
    }
    if (n.type === 'array') check(n.items);
    if (n.type === 'record') check(n.values);
    if (n.type === 'union') { if (!Array.isArray(n.options) || !n.options.length) throw new TypeError('Invalid union'); n.options.forEach(check); }
    if (Object.hasOwn(n,'default') && !run(n,n.default,false,false).valid) throw new TypeError('Default does not match its schema');
    seen.delete(n);
  }
  if (jsonIssue(schema)) throw new TypeError('Schema must be JSON');
  check(schema);
  return schema;
}
export function isSchema(schema) { try { assertSchema(schema); return true; } catch { return false; } }
function node(type, options = {}) { const value = { type, ...options }; assertSchema(value); return deepFreeze(value); }
export const s = {
  string: options => node('string',options), number: options => node('number',options), integer: options => node('number',{...options, integer:true}),
  boolean: options => node('boolean',options), literal: (value,options) => node('literal',{...options,value}), enum: (values,options) => node('enum',{...options,values:[...values]}),
  array: (items,options) => node('array',{...options,items}), object: (shape,options) => node('object',{...options,shape:{...shape}}),
  record: (values,options) => node('record',{...options,values}), union: (options,mods) => node('union',{...mods,options:[...options]}), unknown: options => node('unknown',options),
  optional: schema => node(schema.type,{...schema,optional:true}), nullable: schema => node(schema.type,{...schema,nullable:true}),
  withDefault: (schema,value) => { if (jsonIssue(value)) throw new TypeError('Default must be JSON'); return node(schema.type,{...schema,optional:true,default:clone(value)}); }, describe: (schema,description) => node(schema.type,{...schema,description})
};
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function run(schema,value,lenient,checkSchema = true) {
  if (checkSchema) assertSchema(schema);
  const errors = [];
  const issue = (path,code,message) => errors.push({path,code,message});
  let bad;
  try { bad = jsonIssue(value); } catch { bad = '$'; }
  if (bad) return {valid:false,value:undefined,errors:[{path:bad,code:'not-json',message:'Value must be plain JSON'}]};
  function visit(n,v,path,missing = false) {
    if (missing) {
      if (lenient && Object.hasOwn(n,'default')) return clone(n.default);
      if (!n.optional) issue(path,'required','Value is required');
      return undefined;
    }
    if (v === null && n.nullable) return null;
    if (n.type === 'union') {
      for (const option of n.options) {
        const start = errors.length;
        const result = visit(option,v,path);
        if (errors.length === start) return result;
        errors.splice(start);
      }
      issue(path,'union','Value does not match any union option'); return v;
    }
    if (n.type === 'unknown') return lenient ? clone(v) : v;
    if (n.type === 'literal') { if (v !== n.value) issue(path,'literal','Value does not match literal'); return v; }
    if (n.type === 'enum') { if (!n.values.includes(v)) issue(path,'enum','Value is not in enum'); return v; }
    const matches = n.type === 'array' ? Array.isArray(v) : ['object','record'].includes(n.type) ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === n.type;
    if (!matches) { issue(path,'type',`Expected ${n.type}`); return v; }
    const size = n.type === 'string' || n.type === 'array' ? v.length : v;
    if (n.min !== undefined && size < n.min) issue(path,'min',`Minimum is ${n.min}`);
    if (n.max !== undefined && size > n.max) issue(path,'max',`Maximum is ${n.max}`);
    if (n.type === 'string' && n.pattern && !new RegExp(n.pattern,'u').test(v)) issue(path,'pattern','Value does not match pattern');
    if (n.type === 'number' && n.integer && !Number.isInteger(v)) issue(path,'integer','Expected an integer');
    if (n.type === 'array') {
      const out = v.map((item,i) => visit(n.items,item,`${path}[${i}]`));
      if (n.unique && new Set(v.map(item => canonical(item))).size !== v.length) issue(path,'unique','Array items must be unique');
      return lenient ? out : v;
    }
    if (n.type === 'object' || n.type === 'record') {
      const out = {};
      const shape = n.type === 'record' ? Object.fromEntries(Object.keys(v).sort().map(k => [k,n.values])) : n.shape;
      for (const key of Object.keys(shape)) {
        const present = Object.hasOwn(v,key);
        const item = visit(shape[key],v[key],`${path}.${key}`,!present);
        if (present || item !== undefined) Object.defineProperty(out,key,{value:item,enumerable:true,writable:true,configurable:true});
      }
      for (const key of Object.keys(v).filter(k => !Object.hasOwn(shape,k)).sort()) {
        if (!lenient && n.unknown !== 'allow') issue(`${path}.${key}`,'unknown-key','Unknown key');
        Object.defineProperty(out,key,{value:lenient ? clone(v[key]) : v[key],enumerable:true,writable:true,configurable:true});
      }
      return lenient ? out : v;
    }
    return v;
  }
  const output = visit(schema,value,'$');
  return errors.length ? {valid:false,value:undefined,errors} : {valid:true,value:output,errors:[]};
}
function canonical(v) { return JSON.stringify(v && typeof v === 'object' ? Array.isArray(v) ? v.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(v).sort().map(k => [k,JSON.parse(canonical(v[k]))])) : v); }
export function validate(schema,value) { return run(schema,value,false); }
export function coerce(schema,value) { return run(schema,value,true); }
