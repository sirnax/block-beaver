import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { checkKernelBudget, KERNEL_GZIP_BUDGET } from '../scripts/kernel-budget.mjs';
import { s, validate, coerce, isSchema, assertSchema, defineFamily, defineGenerator, isFamily, isGenerator, coreManifestSchema, validateManifest, createRegistry, compose, composeSafe, read, KernelError } from '../src/kernel/index.mjs';

const manifest = (id='one',extra={}) => ({id,family:'service',version:1,name:id,description:'Description',rationale:'Independent behavior',implementation:{kind:'none'},...extra});

test('kernel acceptance gate enforces its gzip budget and dependency boundary', async () => {
  const actual = await checkKernelBudget();
  assert.ok(actual.gzipBytes <= KERNEL_GZIP_BUDGET);
  const directory = await mkdtemp(join(tmpdir(),'block-beaver-kernel-budget-'));
  try {
    const file = join(directory,'index.mjs');
    await writeFile(file,"import 'node:fs';");
    await assert.rejects(checkKernelBudget(directory),/dependency-free kernel/);
    await writeFile(file,`// ${randomBytes(KERNEL_GZIP_BUDGET * 2).toString('hex')}\n`);
    await assert.rejects(checkKernelBudget(directory),/gzip budget exceeded/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('package kernel subpath exposes the runtime without importing CLI dependencies', async () => {
  const kernel = await import('block-beaver/kernel');
  assert.equal(kernel.createRegistry,createRegistry);
  assert.equal(kernel.validateManifest,validateManifest);
});

test('bundlers discard unused schema exports while keeping registry behavior', async t => {
  let esbuild;
  try { esbuild = createRequire(import.meta.url)('esbuild'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  const available = spawnSync('esbuild',['--version'],{encoding:'utf8'});
  if (!esbuild && available.error?.code === 'ENOENT') {
    assert.notEqual(process.env.BLOCK_BEAVER_REQUIRE_ESBUILD, '1', 'CI requires installed esbuild for the bundle acceptance check');
    t.skip('esbuild unavailable; install esbuild to run the bundle acceptance check'); return;
  }
  if (!esbuild) assert.equal(available.status,0,available.stderr);
  const cwd = fileURLToPath(new URL('../',import.meta.url));
  function bundle(source) {
    if (esbuild) return esbuild.buildSync({ stdin: { contents: source, resolveDir: cwd }, bundle: true, format: 'esm', platform: 'neutral', treeShaking: true, minify: true, write: false }).outputFiles[0].text;
    const result = spawnSync('esbuild',['--bundle','--format=esm','--platform=neutral','--tree-shaking=true','--minify'],{cwd,input:source,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return result.stdout;
  }
  assert.equal(bundle(`import {s, coreManifestSchema} from 'block-beaver/kernel';`).trim(),'');
  const output = bundle(`import {createRegistry} from 'block-beaver/kernel'; export const registry = createRegistry('service', [{id:'one',family:'service'}]);`);
  // Registry-only applications must not pay for the unused schema validators or
  // core manifest schema, even though those share source modules with deepFreeze.
  for (const marker of ['RegExp','Minimum is','Value must be plain JSON','Runtime manifests cannot','rationale']) assert.ok(!output.includes(marker),marker);
  const bundled = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
  assert.deepEqual(bundled.registry.all.map(m=>m.id),['one']);
  assert.ok(Object.isFrozen(bundled.registry.all));
});

test('schemas round-trip as frozen JSON; strict validation preserves identity and coercion copies defaults', () => {
  const schema = s.object({name:s.string({min:1}),enabled:s.withDefault(s.boolean(),true),settings:s.withDefault(s.record(s.string()),{label:'default'})});
  assert.deepEqual(JSON.parse(JSON.stringify(schema)),schema);
  assert.ok(Object.isFrozen(schema.shape.name));
  assert.ok(Object.isFrozen(coreManifestSchema.shape.implementation));
  const input = {name:'service'};
  assert.equal(validate(schema,input).value,input);
  assert.deepEqual(coerce(schema,input).value,{name:'service',enabled:true,settings:{label:'default'}});
  const first = coerce(schema,input).value; first.settings.label = 'changed';
  assert.equal(coerce(schema,input).value.settings.label,'default');
  assert.equal(validate(schema,{...input,z:1}).errors[0].code,'unknown-key');
  assert.deepEqual(coerce(schema,{...input,z:{a:1}}).value.z,{a:1});
  assert.equal(validate(s.object({}, {unknown:'allow'}),{x:1}).valid,true);
});

test('data failures return stable issue codes and depth-first paths', () => {
  const samples = [
    [s.string(),1,'type'],[s.object({a:s.string()}),{},'required'],[s.enum(['a']),'b','enum'],[s.literal('a'),'b','literal'],
    [s.string({min:2}),'a','min'],[s.array(s.boolean(),{max:1}),[true,false],'max'],[s.string({pattern:'^a$'}),'b','pattern'],
    [s.integer(),1.5,'integer'],[s.array(s.unknown(),{unique:true}),[{a:1,b:2},{b:2,a:1}],'unique'],[s.union([s.string(),s.boolean()]),1,'union'],
    [s.unknown(),{nested:undefined},'not-json']
  ];
  for (const [schema,value,code] of samples) {
    const result = validate(schema,value); assert.equal(result.valid,false); assert.equal(result.value,undefined); assert.equal(result.errors[0].code,code);
  }
  const result = validate(s.object({a:s.array(s.object({b:s.string()})),c:s.number()}),{a:[{b:3}],c:false,z:1,d:2});
  assert.deepEqual(result.errors.map(e => e.path),['$.a[0].b','$.c','$.d','$.z']);
  for (const value of [undefined,NaN,Infinity,()=>{},new Date(),[,,],{[Symbol()]:1}]) assert.equal(validate(s.unknown(),value).errors[0].code,'not-json');
  const cycle = {}; cycle.self = cycle; assert.equal(validate(s.unknown(),cycle).valid,false);
  const getter = Object.defineProperty({},'value',{enumerable:true,get() {throw new Error('data getter');}});
  assert.equal(validate(s.unknown(),getter).errors[0].code,'not-json');
  assert.equal(validate(s.nullable(s.string()),null).valid,true);
  assert.equal(coerce(s.union([s.object({a:s.withDefault(s.string(),'first')}),s.unknown()]),{}).value.a,'first');
});

test('malformed schemas are programmer errors', () => {
  assert.throws(() => s.withDefault(s.string(),undefined),TypeError);
  assert.throws(() => s.withDefault(s.string(),5),/Default does not match its schema/);
  assert.throws(() => s.withDefault(s.integer({min:1}),0),TypeError);
  assert.throws(() => s.withDefault(s.object({name:s.string()}),{}),TypeError);
  assert.throws(() => s.string({default:5}),TypeError);
  const invalidDefault = {type:'string',optional:true,default:5};
  assert.equal(isSchema(invalidDefault),false);
  assert.throws(() => coerce({type:'object',shape:{name:invalidDefault}},{}),TypeError);
  const valid = s.object({state:s.withDefault(s.enum(['open','closed']),'open'),value:s.withDefault(s.nullable(s.integer()),null)});
  assert.deepEqual(coerce(valid,{}).value,{state:'open',value:null});
  for (const schema of [{type:'wat'},{type:'string',pattern:'['},{type:'array'},{type:'number',min:2,max:1},{type:'boolean',nullable:false},{type:'enum',values:[]}]) {
    assert.equal(isSchema(schema),false); assert.throws(() => assertSchema(schema),TypeError); assert.throws(() => validate(schema,null),TypeError);
  }
});

test('authoring helpers preserve identity with non-enumerable shared brands', () => {
  const family = {id:'service',fields:s.object({port:s.integer()}),implementation:['none']};
  assert.equal(defineFamily(family),family); assert.ok(isFamily(family)); assert.equal(family[Symbol.for('block-beaver.family')],true);
  assert.ok(Object.isFrozen(family.implementation)); assert.equal(Object.getOwnPropertyDescriptor(family,Symbol.for('block-beaver.family')).enumerable,false);
  const generator = defineGenerator({out:'registry.ts',inputs:['*.ts'],generate:()=>''}); assert.ok(isGenerator(generator));
  assert.equal(isFamily({}),false); assert.equal(isGenerator(null),false);
});

test('manifest validation requires core rationale, family fields and runtime boundaries', () => {
  assert.equal(validateManifest(manifest()).valid,true);
  const noRationale = manifest(); delete noRationale.rationale;
  assert.equal(validateManifest(noRationale).errors[0].path,'$.rationale');
  const family = defineFamily({id:'service',fields:s.object({port:s.integer()}),implementation:['none']});
  assert.equal(validateManifest(manifest('one',{port:80}),{family}).valid,true);
  assert.equal(validateManifest(manifest(),{family}).errors[0].path,'$.port');
  assert.equal(validateManifest(manifest('one',{implementation:{kind:'module',module:'./a.ts'},files:[]}),{mode:'runtime'}).errors.map(e=>e.code).join(','),'runtime-module,runtime-files');
  assert.equal(validateManifest(manifest('one',{version:0})).valid,false);
  assert.equal(validateManifest(manifest('one',{implementation:{kind:'none',module:'hidden'}})).valid,false);
});

test('registries sort, deep-freeze and refuse collisions and mixed families', () => {
  const registry = createRegistry('service',[manifest('z'),manifest('A'),manifest('a')]);
  assert.deepEqual(registry.all.map(m=>m.id),['A','a','z']); assert.equal(Object.getPrototypeOf(registry.byId),null);
  assert.equal(registry.get('a'),registry.byId.a); assert.ok(registry.has('a')); assert.equal(registry.get('absent'),undefined);
  assert.ok(Object.isFrozen(registry.all[0].implementation)); assert.ok(Object.isFrozen(registry));
  assert.throws(()=>createRegistry('service',[manifest(),manifest()]),e=>e instanceof KernelError && e.code==='duplicate-id');
  assert.throws(()=>createRegistry('other',[manifest()]),{code:'family-mismatch'});
  assert.deepEqual(compose(registry,[manifest('dynamic')]).all.map(m=>m.id),['A','a','dynamic','z']);
  assert.throws(()=>compose(registry,[manifest('a')]),{code:'duplicate-id'});
  assert.throws(()=>compose(registry,[manifest('new'),manifest('new')]),{code:'duplicate-id'});
  assert.throws(()=>compose(registry,[manifest('new',{files:[]})]),{code:'manifest-invalid'});
  assert.throws(()=>compose(registry,[manifest('new',{implementation:{kind:'module',module:'./x'}})]),{code:'manifest-invalid'});
});

test('the public kernel export supports CommonJS fallback loaders', () => {
  const kernel = createRequire(import.meta.url)('block-beaver/kernel');
  assert.equal(typeof kernel.defineFamily, 'function');
  assert.equal(typeof kernel.defineGenerator, 'function');
  assert.equal(typeof kernel.validateManifest, 'function');
  const result = kernel.validateManifest({ id: 'fixture', family: 'sample', version: 1, name: 'Fixture', description: 'Runtime fixture', rationale: 'Verify the require condition', implementation: { kind: 'none' } }, { mode: 'runtime' });
  assert.equal(result.valid, true);
});

test('implementation arms accept declared fields, select by kind and name the failing field', () => {
  const family = defineFamily({id:'service',fields:s.object({}),implementation:['module','none','plan'],dataKinds:['plan'],implementationFields:{
    module:s.object({export:s.optional(s.string()),loading:s.optional(s.enum(['eager','lazy']))}),plan:s.object({steps:s.integer()}),none:s.object({note:s.optional(s.string())})}});
  const check = (implementation,options = {}) => validateManifest(manifest('one',{implementation}),{family,...options});
  const paths = result => result.errors.map(e => `${e.path}:${e.code}`);
  assert.equal(check({kind:'module',module:'@/x',export:'X',loading:'eager'}).valid,true);
  assert.equal(check({kind:'module',module:'@/x'}).valid,true);
  assert.deepEqual(paths(check({kind:'module',module:'@/x',loading:'sometimes'})),['$.implementation.loading:enum']);
  assert.deepEqual(paths(check({kind:'module',module:'@/x',extra:1})),['$.implementation.extra:unknown-key']);
  assert.deepEqual(paths(check({kind:'module',export:'X'})),['$.implementation.module:required']);
  assert.deepEqual(paths(check({kind:'module',module:''})),['$.implementation.module:min']);
  assert.deepEqual(paths(check({kind:'none',export:'X'})),['$.implementation.export:unknown-key']);
  assert.equal(check({kind:'none',note:'n'}).valid,true);
  assert.deepEqual(paths(check({kind:'unheard'})),['$.implementation.kind:enum']);
  assert.deepEqual(paths(check({})),['$.implementation.kind:required']);
  assert.equal(paths(check('plan'))[0],'$.implementation:type');
  // Declared data kinds validate in both modes; module stays forbidden at runtime.
  for (const mode of ['build','runtime']) {
    assert.equal(check({kind:'plan',steps:2},{mode}).valid,true);
    assert.deepEqual(paths(check({kind:'plan'},{mode})),['$.implementation.steps:required']);
  }
  assert.deepEqual(paths(check({kind:'module',module:'@/x',loading:'lazy'},{mode:'runtime'})),['$.implementation:runtime-module']);
  assert.deepEqual(paths(check({kind:'plan',steps:2,module:'@/x'})),['$.implementation.module:unknown-key']);
});

test('implementation kinds need a declared arm and a family permission', () => {
  const closed = defineFamily({id:'service',fields:s.object({}),implementation:['none','plan']});
  assert.deepEqual(validateManifest(manifest('one',{implementation:{kind:'plan'}}),{family:closed}).errors.map(e => e.path),['$.implementation.kind']);
  const unlisted = defineFamily({id:'service',fields:s.object({}),implementation:['none'],dataKinds:['plan']});
  assert.deepEqual(validateManifest(manifest('one',{implementation:{kind:'plan'}}),{family:unlisted}).errors.map(e => `${e.path}:${e.code}`),['$.implementation.kind:enum']);
  assert.equal(validateManifest(manifest('one',{implementation:{kind:'module',module:'./a'}}),{family:closed}).errors.length,1);
});

test('core keys win over family-declared arm fields and families without arms match 0.5.1', () => {
  const sneaky = defineFamily({id:'service',fields:s.object({}),implementation:['module'],implementationFields:{module:s.object({module:s.optional(s.string()),kind:s.optional(s.string())})}});
  assert.equal(validateManifest(manifest('one',{implementation:{kind:'module'}}),{family:sneaky}).errors[0].path,'$.implementation.module');
  assert.equal(validateManifest(manifest('one',{implementation:{kind:'module',module:'./a'}}),{family:sneaky}).valid,true);
  const plain = defineFamily({id:'service',fields:s.object({}),implementation:['none','module']});
  assert.equal(validateManifest(manifest('one',{implementation:{kind:'module',module:'./a',loading:'eager'}}),{family:plain}).errors[0].path,'$.implementation.loading');
  assert.equal(validateManifest(manifest('one',{implementation:{kind:'module',module:'./a'}}),{family:plain}).valid,true);
  assert.equal(validateManifest(manifest('one',{implementation:{kind:'module',module:'./a',loading:'eager'}})).errors[0].path,'$.implementation.loading');
});

test('createRegistry keeps input order on request and still sorts by default', () => {
  const input = [manifest('b'),manifest('a')];
  assert.deepEqual(createRegistry('service',input,{order:'input'}).all.map(m=>m.id),['b','a']);
  assert.deepEqual(createRegistry('service',input,{order:'sorted'}).all.map(m=>m.id),['a','b']);
  assert.deepEqual(createRegistry('service',input).all.map(m=>m.id),['a','b']);
  assert.throws(()=>createRegistry('service',[manifest('a'),manifest('a')],{order:'input'}),{code:'duplicate-id'});
});

test('composeSafe keeps valid manifests and reports rejected ones without throwing', () => {
  const base = createRegistry('service',[manifest('b')]);
  const bad = manifest('bad',{files:[]});
  const { registry, rejected } = composeSafe(base,[manifest('x'),bad,null,manifest('b'),manifest('x'),manifest('other',{family:'else'}),manifest('y')]);
  assert.deepEqual(registry.all.map(m=>m.id),['b','x','y']);
  assert.deepEqual(rejected.map(r=>[r.index,r.id,r.errors[0].code]),[[1,'bad','runtime-files'],[2,undefined,'type'],[3,'b','duplicate-id'],[4,'x','duplicate-id'],[5,'other','family-mismatch']]);
  assert.ok(!('id' in rejected[1]));
  assert.deepEqual(composeSafe(base,[manifest('b'),manifest('a')],{order:'input'}).registry.all.map(m=>m.id),['b','a']);
  assert.deepEqual(composeSafe(base,[]).rejected,[]);
  assert.throws(()=>compose(base,[manifest('x'),bad]),{code:'manifest-invalid'});
});

test('read never fails: defaults, kept unknown keys, field-level repairs', () => {
  const schema = s.object({name:s.withDefault(s.string(),'anon'),tags:s.withDefault(s.array(s.string()),[]),count:s.optional(s.integer()),must:s.string(),
    nested:s.optional(s.object({level:s.withDefault(s.integer(),1)})),mode:s.withDefault(s.enum(['a','b']),'a')});
  const out = read(schema,{name:5,tags:'x',count:'many',extra:true,mode:'z'});
  assert.deepEqual(out.value,{name:'anon',tags:[],nested:{level:1},mode:'a',extra:true});
  assert.deepEqual(out.repairs.map(r=>`${r.path}:${r.code}`),['$.name:type','$.tags:type','$.count:type','$.must:required','$.mode:enum']);
  assert.ok(out.repairs.every(r=>typeof r.message==='string'));
  const clean = read(schema,{must:'m',name:'n'});
  assert.deepEqual(clean.repairs,[]); assert.deepEqual(clean.value,{name:'n',tags:[],nested:{level:1},mode:'a',must:'m'});
  assert.deepEqual(read(s.object({a:s.optional(s.string())}),{}).value,{});
  assert.deepEqual(read(s.array(s.integer()),[1,'x',2]).value,[1,2]);
  assert.deepEqual(read(s.array(s.integer(),{min:2}),[1]).repairs.map(r=>r.code),['min']);
  assert.deepEqual(read(s.union([s.string(),s.integer()]),true).repairs.map(r=>r.code),['union']);
  assert.deepEqual(read(s.record(s.integer()),{a:1,b:'x'}).value,{a:1});
  assert.deepEqual(read(s.object({n:s.nullable(s.string())}),{n:null}).value,{n:null});
});

test('read handles non-object and non-JSON roots and leaves coerce and validate strict', () => {
  const schema = s.object({a:s.withDefault(s.integer(),3)});
  for (const bad of [null,undefined,'x',5,[1]]) assert.deepEqual(read(schema,bad).value,{a:3});
  assert.equal(read(schema,null).repairs[0].code,'type');
  assert.deepEqual(read(s.string(),5).value,null);
  assert.deepEqual(read(s.withDefault(s.string(),'d'),5).value,'d');
  const circular = {}; circular.self = circular;
  assert.deepEqual(read(schema,circular),{value:{a:3},repairs:[{path:'$.self',code:'not-json',message:'Value must be plain JSON'}]});
  assert.throws(()=>read({type:'nope'},{}),TypeError);
  assert.equal(coerce(schema,null).valid,false);
  assert.equal(validate(schema,{a:'x'}).valid,false);
});

test('unknown implementation keys on a data kind name implementationFields as the fix', () => {
  const family = defineFamily({id:'service',fields:s.object({}),implementation:['none','plan'],dataKinds:['plan']});
  const result = validateManifest(manifest('one',{implementation:{kind:'plan',plan:{}}}),{family,mode:'runtime'});
  assert.equal(result.errors[0].code,'unknown-key');
  assert.match(result.errors[0].message,/declare `plan` in implementationFields\.plan/);
  const declared = defineFamily({...family,implementationFields:{plan:s.object({plan:s.object({})})}});
  assert.equal(validateManifest(manifest('one',{implementation:{kind:'plan',plan:{}}}),{family:declared,mode:'runtime'}).valid,true);
  const none = validateManifest(manifest('one',{implementation:{kind:'none',x:1}}),{family});
  assert.equal(none.errors[0].message,'Unknown key');
});
