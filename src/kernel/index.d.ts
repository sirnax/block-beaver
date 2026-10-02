export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Mod = { optional?: true; nullable?: true; default?: Json; description?: string };
export type Node = Mod & (
  | {type:'string'; min?:number; max?:number; pattern?:string}
  | {type:'number'; integer?:true; min?:number; max?:number}
  | {type:'boolean'} | {type:'literal'; value:string|number|boolean|null} | {type:'enum'; values:readonly string[]}
  | {type:'array';items:Node;min?:number;max?:number;unique?:true}
  | {type:'object';shape:Readonly<Record<string,Node>>;unknown?:'reject'|'allow'}
  | {type:'record';values:Node} | {type:'union';options:readonly Node[]} | {type:'unknown'});
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type OptionalKeys<S extends Record<string,Node>> = { [K in keyof S]: S[K] extends {optional:true} ? K : never }[keyof S];
type ObjectValue<S extends Record<string,Node>> = { [K in Exclude<keyof S,OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> };
type Value<S extends Node> = S extends {type:'string'} ? string : S extends {type:'number'} ? number : S extends {type:'boolean'} ? boolean
  : S extends {type:'literal';value:infer V} ? V : S extends {type:'enum';values:readonly (infer V)[]} ? V
  : S extends {type:'array';items:infer I extends Node} ? Infer<I>[] : S extends {type:'object';shape:infer O extends Record<string,Node>} ? ObjectValue<O>
  : S extends {type:'record';values:infer V extends Node} ? Record<string,Infer<V>> : S extends {type:'union';options:readonly (infer O extends Node)[]} ? Infer<O> : unknown;
export type Infer<S extends Node> = Node extends S ? unknown : Value<S> | (S extends {nullable:true} ? null : never);
type Options = Mod & {min?:number;max?:number};
export declare const s: {
  string<const O extends Options & {pattern?:string} = {}>(options?:O): Readonly<{type:'string'} & NoInfer<O>>;
  number<const O extends Options = {}>(options?:O): Readonly<{type:'number'} & NoInfer<O>>;
  integer<const O extends Options = {}>(options?:O): Readonly<{type:'number';integer:true} & NoInfer<O>>;
  boolean<const O extends Mod = {}>(options?:O): Readonly<{type:'boolean'} & NoInfer<O>>;
  literal<const V extends string|number|boolean|null,const O extends Mod = {}>(value:V,options?:O): Readonly<{type:'literal';value:V} & NoInfer<O>>;
  enum<const V extends readonly string[],const O extends Mod = {}>(values:V,options?:O): Readonly<{type:'enum';values:V} & NoInfer<O>>;
  array<const N extends Node,const O extends Options & {unique?:true} = {}>(items:N,options?:O): Readonly<{type:'array';items:N} & NoInfer<O>>;
  object<const S extends Record<string,Node>,const O extends Mod & {unknown?:'reject'|'allow'} = {}>(shape:S,options?:O): Readonly<{type:'object';shape:S} & NoInfer<O>>;
  record<const N extends Node,const O extends Mod = {}>(values:N,options?:O): Readonly<{type:'record';values:N} & NoInfer<O>>;
  union<const N extends readonly Node[],const O extends Mod = {}>(options:N,mods?:O): Readonly<{type:'union';options:N} & NoInfer<O>>;
  unknown<const O extends Mod = {}>(options?:O): Readonly<{type:'unknown'} & NoInfer<O>>;
  optional<const N extends Node>(schema:N): Readonly<N & {optional:true}>;
  nullable<const N extends Node>(schema:N): Readonly<N & {nullable:true}>;
  withDefault<const N extends Node>(schema:N,value:NoInfer<Infer<N>> & Json): Readonly<N & {optional:true;default:Json}>;
  describe<const N extends Node>(schema:N,description:string): Readonly<N & {description:string}>;
};
export type Issue = {path:string;code:'type'|'required'|'unknown-key'|'enum'|'literal'|'min'|'max'|'pattern'|'integer'|'unique'|'union'|'not-json'|'runtime-module'|'runtime-files';message:string};
export type Result<T> = {valid:true;value:T;errors:[]} | {valid:false;value:undefined;errors:Issue[]};
export declare function isSchema(value:unknown): value is Node;
export declare function assertSchema(value:unknown): Node;
export declare function validate<const S extends Node>(schema:S,value:unknown): Result<Infer<S>>;
export declare function coerce<const S extends Node>(schema:S,value:unknown): Result<Infer<S>>;
export type CoreManifest = {id:string;family:string;version:number|string;name:string;description:string;rationale:string;implementation:{kind:'module';module:string}|{kind:'none'};files?:readonly string[]};
type ObjectNode = Extract<Node,{type:'object'}>;
export type FamilyDefinition = {id:string;fields:ObjectNode;implementation:readonly string[];
  /** Extra data-only implementation kinds (kebab-case, not module/none); each must also be listed in `implementation`. */
  dataKinds?:readonly string[];
  /** Per-arm extra fields merged into that arm (`module`, `none` or a data kind); core keys `kind` and `module` cannot be redeclared. */
  implementationFields?:Readonly<Record<string,ObjectNode>>;
  links?:readonly {field:string;to:string|readonly string[];kind:string}[];generators?:readonly ('registry'|'index'|'history')[];
  map?:{title?:string;blurb?:string};scaffold?:{files:readonly {path:string;template:string}[];manualSteps?:readonly string[]};
  check?:(manifest:CoreManifest & Record<string,unknown>,ctx:{family:string;get(ref:string):unknown}) => readonly {path:string;message:string;code?:string}[] | void;
  checkAll?:(manifests:readonly (CoreManifest & Record<string,unknown>)[],ctx:SetCheckContext) => SetCheckIssues | Promise<SetCheckIssues>;};
/** Context for a family's `checkAll` and for config-level `checks` modules (default export `(ctx) => issues`). */
export type SetCheckContext = {families:readonly {id:string}[];get(ref:string):unknown;all(familyId:string):readonly (CoreManifest & Record<string,unknown>)[]};
export type SetCheckIssues = readonly {message:string;block?:string;field?:string;path?:string;code?:string}[] | void;
type ImplementationOf<F extends FamilyDefinition> = F['implementation'][number] extends infer K ? K extends string
  ? {kind:K} & (K extends 'module' ? {module:string} : unknown) & (F['implementationFields'] extends infer R ? K extends keyof R ? R[K] extends ObjectNode ? Infer<R[K]> : unknown : unknown : unknown) : never : never;
export type ManifestOf<F extends FamilyDefinition> = Omit<CoreManifest,'implementation'> & {family:F['id'];implementation:ImplementationOf<F>} & Infer<F['fields']>;
export type GeneratorContext = {config:unknown;families:readonly unknown[];manifests(familyId:string):readonly CoreManifest[];blocks():readonly CoreManifest[];graph:unknown;resolve(from:string,spec:string):unknown;label:string|null};
export type GeneratorDefinition = {out:string;inputs:readonly string[];cache?:boolean;generate(ctx:GeneratorContext):string|Promise<string>};
export declare function defineFamily<const F extends FamilyDefinition>(definition:F): DeepReadonly<F>;
export declare function defineGenerator<const G extends GeneratorDefinition>(definition:G): DeepReadonly<G>;
export declare function isFamily(value:unknown): value is FamilyDefinition;
export declare function isGenerator(value:unknown): value is GeneratorDefinition;
export declare const coreManifestSchema: DeepReadonly<Extract<Node,{type:'object'}>>;
export declare function validateManifest<F extends FamilyDefinition = FamilyDefinition>(manifest:unknown,options?:{mode?:'build'|'runtime';family?:F}): Result<ManifestOf<F>>;
export type Registry<M extends {id:string;family:string}> = Readonly<{family:string;all:readonly DeepReadonly<M>[];byId:Readonly<Record<M['id'],DeepReadonly<M>>>;get(id:string):DeepReadonly<M>|undefined;has(id:string):id is M['id']}>;
export declare class KernelError extends Error {code:string;details:unknown;constructor(code:string,message:string,details?:unknown);}
export declare function createRegistry<const M extends {id:string;family:string}>(family:string,manifests:readonly M[]): Registry<M>;
export declare function compose<M extends {id:string;family:string}>(base:Registry<M>,dynamic:readonly unknown[],options?:{family?:FamilyDefinition}): Registry<M|CoreManifest>;
