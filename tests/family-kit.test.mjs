import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runKit } from '../src/families/kit.mjs';
import { s } from '../src/kernel/index.mjs';

const value = (id = 'existing', extra = {}) => ({ id, family: 'sample', version: 1, name: id, description: id, rationale: 'Required purpose', implementation: {kind:'none'}, ...extra });
const family = { id: 'sample', floor: 2, fields: s.object({ parent: s.optional(s.string()) }), implementation: ['none','module'], links: [{field:'parent',to:'sample',kind:'uses'}], config: {manifests:'units/*.entry.ts'}, scaffold: {files:[{path:'units/{{id}}.entry.ts', template:'export default {{json.rationale}};\n'}, {path:'source/{{camelId}}.ts', template:'// {{pascalId}} {{name}}: {{description}}\n'}], manualSteps:['Perform the owner operation for {{id}}'] } };
const config = { schemaVersion:1, families:[family.config] };
const load = { families:[family], manifests:[{family:'sample',id:'existing',path:'units/existing.entry.ts',value:value()}], diagnostics:[] };
async function fixture(t) { const root = await mkdtemp(join(tmpdir(),'beaver-kit-')); t.after(() => rm(root,{recursive:true,force:true})); return root; }
const options = (extra = {}) => ({config, loadFamilies:async ({ paths = [] }) => {
  const copied = structuredClone(load);
  for (const path of paths.filter((path) => /^units\/.*\.entry\.ts$/.test(path) && path !== 'units/existing.entry.ts')) {
    const id = path.slice('units/'.length, -'.entry.ts'.length);
    copied.manifests.push({family:'sample',id,path,value:value(id)});
  }
  return copied;
}, planGeneration:async () => ({outputs:[],diagnostics:[]}), ...extra});

test('kit list and describe expose repo definitions and generic JSON', async (t) => {
  const root = await fixture(t);
  const listed = await runKit(root,'list',[],options());
  assert.deepEqual(listed.result.families,[{id:'sample',floor:2,count:1}]);
  assert.equal(listed.result.blocks[0].graphId,'block:sample:existing');
  const described = await runKit(root,'describe',['sample'],options());
  assert.equal(described.result.core.shape.rationale.min,1);
  assert.deepEqual(described.result.scaffold.files,['units/{{id}}.entry.ts','source/{{camelId}}.ts']);
  assert.equal(JSON.parse(JSON.stringify(described)).ok,true);
  assert.equal((await runKit(root,'describe',['absent'],options())).error.code,'family-unknown');
});

test('kit validates build links and runtime executable restrictions', async (t) => {
  const root = await fixture(t);
  const valid = await runKit(root,'validate',[],options({input:{manifest:value('new',{parent:'existing'})}}));
  assert.equal(valid.result.valid,true);
  const invalid = await runKit(root,'validate',[],options({input:{manifest:value('new',{parent:'missing'})}}));
  assert.equal(invalid.result.errors[0].code,'link-target-missing');
  const runtime = await runKit(root,'validate',[],options({input:{manifest:value('new',{implementation:{kind:'module',module:'./file'}}),mode:'runtime'}}));
  assert.equal(runtime.result.valid,false);
  assert.ok(runtime.result.errors.some((issue) => issue.code === 'runtime-module'));
  assert.equal((await runKit(root,'validate',[],options({input:{manifest:value(),mode:'oops'}}))).ok,false);
});

test('kit compose rejects shadowing and accepts runtime data', async (t) => {
  const root = await fixture(t);
  const composed = await runKit(root,'compose',[],options({input:{family:'sample',dynamic:[value('second')]}}));
  assert.deepEqual(composed.result.ids,['existing','second']);
  const collision = await runKit(root,'compose',[],options({input:{family:'sample',dynamic:[value()]}}));
  assert.equal(collision.error.code,'duplicate-id');
  assert.equal((await runKit(root,'compose',[],options({input:{family:'sample',dynamic:[value('new',{files:[]})]}}))).ok,false);
});

test('create writes every scaffold, generates, reloads and reports manual work', async (t) => {
  const root = await fixture(t);
  let calls = 0, generated = false;
  const opts = options({ input:{rationale:'Quote " and newline\n',name:'New name'}, loadFamilies: async () => {
    calls++;
    return calls === 1 ? structuredClone(load) : {...structuredClone(load),manifests:[...load.manifests,{family:'sample',id:'new-item',path:'units/new-item.entry.ts',value:value('new-item')}]};
  }, planGeneration: async (input) => { assert.ok(input.paths.includes('units/new-item.entry.ts')); return {outputs:[],diagnostics:[]}; }, applyGeneration: async () => { generated = true; return {written:['generated.ts'],diagnostics:[]}; } });
  const result = await runKit(root,'create',['sample','new-item'],opts);
  assert.equal(result.ok,true);
  assert.equal(generated,true);
  assert.equal(calls,3);
  assert.equal(await readFile(join(root,'units/new-item.entry.ts'),'utf8'),'export default "Quote \\" and newline\\n";\n');
  assert.match(await readFile(join(root,'source/newItem.ts'),'utf8'),/NewItem New name: New name/);
  assert.deepEqual(result.result.manualSteps,['Perform the owner operation for new-item']);
  assert.deepEqual(result.result.gen.written,['generated.ts']);
});

test('dry-run and collision preflight never write companion files', async (t) => {
  const root = await fixture(t);
  let snapshot;
  const opts = options({input:{rationale:'Reason'},dryRun:true,planGeneration:async ({root: virtualRoot, graph}) => {
    snapshot = virtualRoot;
    assert.notEqual(virtualRoot,root);
    assert.ok(graph.nodes.some((node) => node.id === 'block:sample:new'));
    assert.equal(await readFile(join(virtualRoot,'units/new.entry.ts'),'utf8'),'export default \"Reason\";\n');
    return {outputs:[{out:'generated/sample.ts',expected:'// generated\n',status:'missing',current:null},{out:'generated/fresh.ts',expected:'same',status:'fresh'}],diagnostics:[],cacheUpdate:{path:'.blocks/cache/generators.json',before:null,content:'{}\n'}};
  }});
  const dry = await runKit(root,'create',['sample','new'],opts);
  assert.equal(dry.ok,true);
  assert.deepEqual(dry.result.written.map((file) => file.path),['units/new.entry.ts','source/new.ts','generated/sample.ts','.blocks/cache/generators.json']);
  assert.deepEqual(dry.result.gen.written,['generated/sample.ts']);
  await assert.rejects(readFile(join(snapshot,'units/new.entry.ts')),{code:'ENOENT'});
  await assert.rejects(readFile(join(root,'generated/sample.ts')),{code:'ENOENT'});
  await assert.rejects(readFile(join(root,'.blocks/cache/generators.json')),{code:'ENOENT'});
  await assert.rejects(readFile(join(root,'units/new.entry.ts')),{code:'ENOENT'});
  await mkdir(join(root,'units'));
  await writeFile(join(root,'units/new.entry.ts'),'owner');
  for (const dryRun of [false,true]) {
    const collision = await runKit(root,'create',['sample','new'],{...opts,dryRun});
    assert.equal(collision.error.code,'create-exists');
    assert.deepEqual(collision.error.details.paths,['units/new.entry.ts']);
  }
  await assert.rejects(readFile(join(root,'source/new.ts')),{code:'ENOENT'});
});

test('create rejects unsafe paths, symlinks, unknown tokens and missing rationale', async (t) => {
  const root = await fixture(t);
  assert.equal((await runKit(root,'create',['sample','new'],options())).error.code,'manifest-schema');
  for (const path of ['../{{id}}.ts','/absolute/{{id}}.ts','.blocks/{{id}}.ts','{{unknown}}.ts']) {
    const changed = {...family,scaffold:{files:[{path,template:'x'}]}};
    const result = await runKit(root,'create',['sample','new'],options({input:{rationale:'Reason'},dryRun:true,loadFamilies:async () => ({...load,families:[changed]})}));
    assert.equal(result.ok,false);
  }
  const outside = await fixture(t);
  await symlink(outside,join(root,'units'));
  assert.equal((await runKit(root,'create',['sample','new'],options({input:{rationale:'Reason'},dryRun:true}))).error.code,'output-unsafe');
});

test('generation failures roll back created files and never pretend manual steps happened', async (t) => {
  const root = await fixture(t);
  const result = await runKit(root,'create',['sample','new'],options({input:{rationale:'Reason'},planGeneration:async () => ({diagnostics:[{severity:'error',code:'output-collision'}]})}));
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'generator-failed');
  assert.deepEqual(result.error.details.written,[]);
  assert.equal(result.error.details.rolledBack,true);
  await assert.rejects(readFile(join(root,'units/new.entry.ts')),{code:'ENOENT'});
  await assert.rejects(readFile(join(root,'source/new.ts')),{code:'ENOENT'});
});

test('real loader validates proposed scaffolds in dry-run and generators see family blocks', async (t) => {
  const root = await fixture(t);
  const configured = {schemaVersion:1,families:[{id:'sample',contract:'sample.family.ts',manifests:'units/*.entry.ts'}]};
  const definition = {id:'sample',fields:{type:'object',shape:{}},implementation:['none'],scaffold:{files:[{path:'units/{{id}}.entry.ts',template:'export default {id: {{json.id}}, family: {{json.family}}, version: 1, name: {{json.name}}, description: {{json.description}}, rationale: {{json.rationale}}, implementation: {kind: "none"}};\n'}],manualSteps:['Review {{id}}']}};
  await writeFile(join(root,'sample.family.ts'), `import {defineFamily} from 'block-beaver/kernel';\nexport default defineFamily(${JSON.stringify(definition)});\n`);
  const response = await runKit(root,'create',['sample','new'],{config:configured,input:{rationale:'A useful purpose'},dryRun:true,planGeneration:async ({graph,root: snapshot}) => {
    assert.equal(graph.root,snapshot);
    assert.ok(graph.nodes.some((node) => node.id === 'block:sample:new'));
    assert.equal(graph.families[0].count,1);
    return {outputs:[{out:'.blocks/index.json',expected:'[]\n',status:'missing',current:null}],diagnostics:[]};
  }});
  assert.equal(response.ok,true,JSON.stringify(response));
  assert.deepEqual(response.result.written.map((item) => item.path),['units/new.entry.ts','.blocks/index.json']);
  await assert.rejects(readFile(join(root,'units/new.entry.ts')),{code:'ENOENT'});
  definition.scaffold.files[0].template = 'export default {id: "wrong"};\n';
  await writeFile(join(root,'sample.family.ts'),`import {defineFamily} from 'block-beaver/kernel';\nexport default defineFamily(${JSON.stringify(definition)});\n`);
  const invalid = await runKit(root,'create',['sample','new'],{config:configured,input:{rationale:'Reason'},dryRun:true,planGeneration:async () => {throw new Error('Invalid manifest reached generation');}});
  assert.equal(invalid.ok,false);
  assert.equal(invalid.error.code,'manifest-schema');
  await assert.rejects(readFile(join(root,'units/new.entry.ts')),{code:'ENOENT'});
});

test('informational diagnostics do not fail kit commands', async (t) => {
  const root = await fixture(t);
  const result = await runKit(root,'list',[],options({loadFamilies:async () => ({...load,diagnostics:[{severity:'info',code:'note',message:'Information'}]})}));
  assert.equal(result.ok,true);
});

test('real create and dry-run include registry, custom generation, history and registered view exports', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root,'.blocks'));
  const configured = {schemaVersion:1,families:[{id:'sample',contract:'sample.family.ts',manifests:'units/*.entry.ts',registry:{out:'generated/sample.ts'},generators:['count.generator.ts']}]};
  const definition = {id:'sample',fields:{type:'object',shape:{}},implementation:['none'],generators:['registry','index','history'],scaffold:{files:[{path:'units/{{id}}.entry.ts',template:'export default {id: {{json.id}}, family: {{json.family}}, version: 1, name: {{json.name}}, description: {{json.description}}, rationale: {{json.rationale}}, implementation: {kind: "none"}};\n'}],manualSteps:['Review {{id}}']}};
  await writeFile(join(root,'.blocks/config.json'),JSON.stringify(configured));
  await writeFile(join(root,'.blocks/view-exports.json'),JSON.stringify([{path:'generated/view.mjs',format:'module'}]));
  await writeFile(join(root,'sample.family.ts'),`import {defineFamily} from 'block-beaver/kernel';\nexport default defineFamily(${JSON.stringify(definition)});\n`);
  await writeFile(join(root,'count.generator.ts'),`import {defineGenerator} from 'block-beaver/kernel';\nexport default defineGenerator({out:'generated/count.json',inputs:['units/*.entry.ts'],generate(ctx) {return JSON.stringify({count:ctx.graph.nodes.filter(n=>n.kind==='block' && n.family==='sample').length});}});\n`);
  const options = {input:{rationale:'A useful purpose'}};
  const dry = await runKit(root,'create',['sample','new'],{...options,dryRun:true});
  assert.equal(dry.ok,true,JSON.stringify(dry));
  const planned = dry.result.written.map((item) => item.path);
  for (const path of ['units/new.entry.ts','generated/sample.ts','.blocks/index.json','generated/count.json','.blocks/history.json','generated/view.mjs','.blocks/cache/generators.json']) assert.ok(planned.includes(path),path);
  for (const path of planned) await assert.rejects(readFile(join(root,path)),{code:'ENOENT'});
  const created = await runKit(root,'create',['sample','new'],options);
  assert.equal(created.ok,true,JSON.stringify(created));
  assert.deepEqual(created.result.written,dry.result.written);
  assert.deepEqual(created.result.gen.written,dry.result.gen.written);
  assert.deepEqual(JSON.parse(await readFile(join(root,'generated/count.json'),'utf8')),{count:1});
  assert.equal(JSON.parse(await readFile(join(root,'.blocks/index.json'),'utf8'))[0].id,'new');
  assert.match(await readFile(join(root,'generated/sample.ts'),'utf8'),/sampleRegistry/);
  assert.match(await readFile(join(root,'generated/view.mjs'),'utf8'),/BLOCK_BEAVER_VIEW/);
  assert.ok(created.result.gen.written.includes('generated/view.mjs'));
  const {generateProject} = await import('../src/families/commands.mjs');
  const checked = await generateProject(root,{check:true});
  assert.equal(checked.ok,true,JSON.stringify(checked));
});

test('shape-invalid history becomes a named diagnostic during dry-run without target writes', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root,'.blocks'));
  const text = '{"entries":{}}';
  await writeFile(join(root,'.blocks/history.json'),text);
  const result = await runKit(root,'create',['sample','new'],options({input:{rationale:'Reason'},dryRun:true}));
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'manifest-schema');
  assert.ok(result.error.details.diagnostics.some((item) => item.code === 'history-invalid' && item.file === '.blocks/history.json'));
  assert.equal(await readFile(join(root,'.blocks/history.json'),'utf8'),text);
  await assert.rejects(readFile(join(root,'units/new.entry.ts')),{code:'ENOENT'});
});

test('kit describe and validate carry implementation arms and data kinds', async (t) => {
  const root = await fixture(t);
  const arms = { ...family, implementation: ['none','module','plan'], dataKinds: ['plan'], implementationFields: { module: s.object({ loading: s.optional(s.enum(['eager','lazy'])) }), plan: s.object({ steps: s.integer() }) } };
  const withArms = options({ loadFamilies: async () => structuredClone({ ...load, families: [arms] }) });
  const described = await runKit(root,'describe',['sample'],withArms);
  assert.deepEqual(described.result.dataKinds,['plan']);
  assert.equal(described.result.implementationFields.plan.shape.steps.type,'number');
  const plain = await runKit(root,'describe',['sample'],options());
  assert.deepEqual([plain.result.dataKinds,plain.result.implementationFields],[[],{}]);
  const valid = await runKit(root,'validate',[],{ ...withArms, input: { manifest: value('new',{implementation:{kind:'plan',steps:1}}), mode: 'runtime' } });
  assert.equal(valid.result.valid,true);
  const bad = await runKit(root,'validate',[],{ ...withArms, input: { manifest: value('new',{implementation:{kind:'module',module:'./a',loading:'soon'}}) } });
  assert.deepEqual(bad.result.errors.map((issue) => issue.path),['$.implementation.loading']);
});

test('kit validation does not look up targets for join links', async (t) => {
  const root = await fixture(t);
  const joined = { ...family, links: [{ field: 'parent', to: 'sample', match: 'parent', kind: 'joins' }] };
  const run = (parent) => runKit(root,'validate',[],options({ loadFamilies: async () => ({ ...load, families: [joined] }), input: { manifest: value('new', { parent }) } }));
  assert.equal((await run('nothing-has-this')).result.valid, true);
  assert.equal((await runKit(root,'validate',[],options({ input: { manifest: value('new', { parent: 'nothing-has-this' }) } }))).result.valid, false);
});
