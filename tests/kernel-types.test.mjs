import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

test('kernel declarations infer family schemas and registry literal ids', () => {
  const file = fileURLToPath(new URL('../src/kernel/type-fixture.ts',import.meta.url));
  const source = `
    import {s, type Infer, type ManifestOf, defineFamily, createRegistry, validate} from 'block-beaver/kernel';
    const schema = s.object({state:s.enum(['open','closed']), label:s.optional(s.string()), values:s.array(s.integer()), nullable:s.nullable(s.string())});
    const value: Infer<typeof schema> = {state:'open',values:[1],nullable:null};
    s.withDefault(s.string(),'default');
    s.withDefault(s.nullable(s.integer()),null);
    // @ts-expect-error defaults must match the schema's inferred type
    s.withDefault(s.string(),5);
    // @ts-expect-error defaults must preserve enum constraints
    s.withDefault(s.enum(['open','closed']),'other');
    // @ts-expect-error enum inference must preserve its literal union
    const wrong: Infer<typeof schema> = {state:'other',values:[],nullable:'yes'};
    const family = defineFamily({id:'service',fields:s.object({port:s.integer()}),implementation:['none']});
    const m: ManifestOf<typeof family> = {id:'a',family:'service',version:1,name:'a',description:'a',rationale:'a',implementation:{kind:'none'},port:80};
    // @ts-expect-error required family fields survive inference
    const absent: ManifestOf<typeof family> = {id:'a',family:'service',version:1,name:'a',description:'a',rationale:'a',implementation:{kind:'none'}};
    const registry = createRegistry('service',[{...m,id:'a'},{...m,id:'b'}] as const);
    type Id = (typeof registry)['all'][number]['id'];
    const id: Id = 'a';
    // @ts-expect-error registry retains the authored id union
    const badId: Id = 'c';
    // @ts-expect-error registry values are deeply readonly
    registry.all[0].implementation.kind = 'none';
    const result = validate(schema,{});
    if (result.valid) { const state: 'open'|'closed' = result.value.state; }
  `;
  const options = {strict:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler};
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host); const exists = host.fileExists.bind(host);
  host.readFile = path => path === file ? source : read(path);
  host.fileExists = path => path === file || exists(path);
  const program = ts.createProgram([file],options,host);
  const errors = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(errors.map(d=>`${d.file?.getLineAndCharacterOfPosition(d.start ?? 0).line}: ${ts.flattenDiagnosticMessageText(d.messageText,'\n')}`),[]);
});
