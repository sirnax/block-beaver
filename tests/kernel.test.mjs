import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { checkKernelBudget, KERNEL_GZIP_BUDGET } from '../scripts/kernel-budget.mjs';
import { s, validate, coerce, isSchema, assertSchema, defineFamily, defineGenerator, isFamily, isGenerator, coreManifestSchema, validateManifest, createRegistry, compose, KernelError } from '../src/kernel/index.mjs';

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
  const available = spawnSync('esbuild',['--version'],{encoding:'utf8'});
  if (available.error?.code === 'ENOENT') { t.skip('esbuild unavailable; install esbuild to run the bundle acceptance check'); return; }
  assert.equal(available.status,0,available.stderr);
  const cwd = fileURLToPath(new URL('../',import.meta.url));
  function bundle(source) {
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
