# C families layer: interface contract for independent workers

This is a read-only design pass; I made no edits. I read `AGENTS.md`, design §C, `families-plan.md`, and A's `src/project-model.mjs`, `migrations.mjs`, `audit-rules.mjs`, `adapter.mjs`, `scanner.mjs` and `contracts.mjs`. I adopted all of your proposed decisions. Where you left a choice open, I made it below, with a short reason.

## 0. Shared conventions (every worker)

- **Graph IDs:** `block:<family>:<id>`. The user-facing reference is `<family>:<id>`. `local` is a reserved family ID, because `block:local:*` already exists.
- **Family ID** uses the existing kebab-case `idPattern`.
- **Block ID** must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`: no `:`, `/` or spaces. This is loose so adopted manifests don't have to change.
- **Block ID comes from the file name.** It is whatever the **last single `*`** (not `**`) in the family's `manifests` glob matched. For example, `blocks/services/*.service.ts` turns `auth.service.ts` into `auth`.
- **Paths** are repo-relative POSIX strings. They must stay inside the repo and pass `writeProjectFiles` safety.
- Family source paths are repository-chosen; managed working directories remain excluded.**
- **Sorting is always by code-unit order (`a < b`), never `localeCompare`.** That is a determinism trap.
- **One diagnostic shape across C:**
  ```ts
  type Diagnostic = { rule: 'config-valid'|'manifest-valid'|'family-drift'; code: string; severity: 'error'|'warning';
    message: string; file?: string; family?: string; block?: string /* family:id */; field?: string /* $.a[0].b */; link?: string };
  ```
  Kernel issues use `$`-rooted paths (`$.routes[2].handler`), matching `contracts.mjs`.
- **Stable codes**, grouped by area:

  | Area | Codes |
  |---|---|
  | Config | `family-duplicate`, `family-id-invalid`, `family-id-reserved`, `family-path-invalid`, `family-glob-invalid`, `registry-out-missing` |
  | Loader | `loader-node-version`, `loader-package-missing`, `loader-timeout`, `tsx-unsupported`, `non-strippable-syntax`, `unresolved-import`, `load-failed` |
  | Contract | `contract-default-missing`, `contract-invalid`, `contract-id-mismatch`, `contract-reserved-field`, `link-path-invalid`, `link-target-family` |
  | Manifest | `manifest-export-count`, `manifest-id-mismatch`, `manifest-family-mismatch`, `manifest-not-json`, `manifest-schema`, `implementation-kind-forbidden`, `implementation-unresolved`, `implementation-external`, `file-missing`, `block-duplicate`, `family-check-failed`, `link-value-invalid`, `link-target-missing`, `family-unclaimed` |
  | Generation | `generator-invalid`, `generator-failed`, `output-collision`, `output-unsafe`, `output-conflict`, `output-stale`, `output-missing`, `history-stale` |
  | History import | `import-invalid`, `import-unmapped-key`, `import-date-order`, `import-history-exists`, `import-replay-mismatch` |
  | Kit | `create-exists`, `scaffold-token-unknown` |

## 1. Config additions

All additions are optional, so config `schemaVersion` stays 1 and no migration is needed.

```jsonc
"families": [{ "id": "…", "contract": "x.family.ts", "manifests": "glob",
               "registry"?: { "out": "path.ts", "exportName"?: "…", "importExtension"?: "" | ".js" | ".ts" },  // default ""
               "generators"?: ["path/to/gen.ts"] }],
"generators"?: ["path/to/gen.ts"],      // custom generators that belong to no family
"history"?: { "label"?: "…" },
"loader"?: "<bare package name>",
"map"?: { "skin"?: "path.css", "tokens"?: { "<kebab>": "<css value>" } }
```

- **Contracts list built-in generators only** (`registry | index | history`). Custom generator paths live in config, so loading a contract never depends on another file.
- **`registry.out` is required** if the contract asks for `registry`.
- Typed registry output paths must end in `.ts`, `.mts`, or `.cts`; declaration-file paths are rejected. `importExtension` controls the specifier emitted for manifest imports and is limited to `""`, `.js`, or `.ts`.

## 2. Kernel: `block-beaver/kernel`

Files: `src/kernel/{index,schema,registry,manifest}.mjs` plus a hand-written `index.d.ts`.

- **Schema nodes are plain frozen JSON objects** built by functions. There is no method chaining, because chained objects carry a prototype and fail the deep-equality round trip.
  ```ts
  type Mod = { optional?: true; nullable?: true; default?: Json; description?: string };
  type Node = Mod & ({type:'string',min?,max?,pattern?:string /* 'u' flag */} | {type:'number',integer?:true,min?,max?}
    | {type:'boolean'} | {type:'literal',value:string|number|boolean|null} | {type:'enum',values:string[]}
    | {type:'array',items:Node,min?,max?,unique?:true} | {type:'object',shape:Record<string,Node>,unknown?:'reject'|'allow'}
    | {type:'record',values:Node} | {type:'union',options:Node[]} | {type:'unknown'});
  ```
- **Builders:** `s.string`, `s.number`, `s.integer`, `s.boolean`, `s.literal`, `s.enum`, `s.array`, `s.object`, `s.record`, `s.union`, `s.unknown`, `s.optional`, `s.nullable`, `s.withDefault` (implies optional) and `s.describe`.
- **Schema checks:** `isSchema(x)` and `assertSchema(x)`. A malformed schema or bad regex throws a `TypeError`. That is a programmer error, not a data error.
- **One public data-check API.** `validate`, `coerce` and `validateManifest` all return the same shape and **never throw on data**:
  ```ts
  type Issue = { path: string; code: 'type'|'required'|'unknown-key'|'enum'|'literal'|'min'|'max'|'pattern'|'integer'|'unique'|'union'|'not-json'|'runtime-module'|'runtime-files'; message: string };
  type Result<T> = { valid: true; value: T; errors: [] } | { valid: false; value: undefined; errors: Issue[] };
  validate(schema, value): Result   // strict: unknown keys rejected unless unknown:'allow'; defaults NOT inserted; value === input
  coerce(schema, value): Result     // lenient: returns a new copy, deep-clones defaults in, keeps unknown keys; no type conversion
  ```
  - `undefined` anywhere counts as `not-json`.
  - For `union`, the first matching option wins.
  - Errors come out depth-first in schema key order, followed by unknown keys in sorted order.
- **Manifests:**
  ```ts
  coreManifestSchema   // id, family, version (positive integer | non-empty string), name, description, rationale (non-empty), implementation, files?
  validateManifest(m, { mode: 'build'|'runtime', family?: FamilyDefinition }): Result
  ```
  - `implementation` is `{kind:'module', module:string}` or `{kind:'none'}`.
  - `files` is optional, top-level and a `string[]`.
  - Family fields sit **at the top level** of the manifest.
  - Runtime mode rejects `kind:'module'` **and** `files`. Both name code, and the design says runtime blocks must never do that.
  - Passing `family` adds the family's field schema plus the allowed-kinds check.
- **Registries.** These throw `KernelError {code, details}`, because breaking them is a constructor invariant, not a data check. The kit wraps the throw into JSON.
  ```ts
  type Registry<M> = Readonly<{ family: string; all: readonly DeepReadonly<M>[] /* sorted by id */; byId: Readonly<Record<M['id'], DeepReadonly<M>>> /* null prototype */;
                                get(id: string): DeepReadonly<M> | undefined; has(id: string): id is M['id'] }>;
  createRegistry<const M>(family: string, manifests: readonly M[]): Registry<M>            // codes: duplicate-id, family-mismatch; deep-freezes
  compose<M>(base: Registry<M>, dynamic: readonly unknown[], opts?: { family?: FamilyDefinition }): Registry<M>
      // each dynamic entry must pass runtime validateManifest; any id collision with base or another dynamic entry → duplicate-id
  ```
- **Authoring helpers:**
  - `defineFamily(def)` and `defineGenerator(def)` return the same object, deep-frozen, with a non-enumerable brand: `Symbol.for('block-beaver.family')` or `Symbol.for('block-beaver.generator')`.
  - `Symbol.for` matters because it keeps the brand valid across copies of the kernel.
  - Neither helper validates anything; the loader does that.
  - Types exported: `Infer<S>`, `ManifestOf<F>` and `DeepReadonly`.
- **Constraints:**
  - No `node:` or package imports; relative imports only.
  - Avoid top-level runtime work. A `/* @__PURE__ */`-annotated frozen schema initializer is allowed and must remain removable when exports are unused, as verified by the tree-shaking check. `defineFamily` and `defineGenerator` return deep-frozen values.
  - Size budget: total gzip of `src/kernel/*.mjs` ≤ **6 KiB**, enforced in `scripts/check.mjs`.

## 3. Authoring contracts

```ts
defineFamily({ id, fields: ObjectNode, implementation: readonly ('module'|'none')[] /* required, non-empty */,
  links?: readonly { field: string /* a.b[].c */; to: string | readonly string[] /* family ids */; kind: string /* kebab */ }[],
  generators?: readonly ('registry'|'index'|'history')[], map?: { title?: string; blurb?: string },
  scaffold?: { files: readonly { path: string; template: string }[]; manualSteps?: readonly string[] },
  check?: (m, ctx: { family: string; get(ref: string): unknown | undefined }) => readonly { path: string; message: string; code?: string }[] | void })
defineGenerator({ out: string, inputs: readonly string[] /* non-empty */, cache?: boolean /* default true */, generate(ctx): string | Promise<string> })
```

**Module rules:**
- **Contract:** must have a branded `default` export. Named exports are allowed. Field names may not reuse the core keys.
- **Link field paths** must walk the schema, with `[]` exactly where the schema has arrays. A `to` family must be configured.
- **Manifest:** exactly **one runtime export**, under any name. Type-only exports disappear when types are stripped, so they don't count. The loader records `exportName` so the registry can import it correctly.
- **Generator:** must have a branded `default` export.

## 4. TypeScript loader

Files: `src/families/{config,glob,loader,load-worker,hooks,canonical}.mjs`.

### Decision: run every load in a one-shot child process, not in-process hooks

`fork(load-worker.mjs, { execArgv: [...], serialization: 'advanced', cwd: root })`. Each child loads, validates, optionally runs generators, replies once and exits.

**Why not register hooks, deregister them, and bust the cache in-process:**
- Hooks are process-wide while registered, so concurrent host imports (server, watch) would go through them.
- Node has no ESM cache eviction. Busting with `?v=` has to be carried down to every import underneath, and it leaks a module instance on every edit in a long watch session.
- Custom `generate()` functions that call `import()` lazily break once the hooks are removed.

**What the child process gives:**
- Nothing leaks into the parent.
- Freshness is guaranteed, and concurrent scans are safe.
- The `loader` fallback becomes just a different `execArgv`.

### Child setup

- **`execArgv` is set explicitly**, so the parent's `--test` and similar flags are not inherited. It contains `--disable-warning=ExperimentalWarning`, plus `--import <resolved loader URL>` in fallback mode.
- **Env:** inherited, minus `NODE_TEST_CONTEXT`.
- **Timeout:** 120 s, then kill and report `loader-timeout`.
- **Child stdout/stderr are captured and never forwarded.** The kit's JSON output must stay clean. A truncated tail is attached to `load-failed`.

### Hooks (built-in mode only)

The child calls `module.registerHooks` after building its own `loadProjectModel(root, { paths, writeConfig: false })`. It must get the parent's exact `paths` list so file ownership comes out the same.

- **Resolve hook:**
  - Fires only when the parent is a repo file outside `node_modules`.
  - `block-beaver/kernel` maps to the CLI's own kernel URL, so there is one kernel instance and fixtures need no `node_modules`.
  - Otherwise it calls `resolveImport(relParent, spec, { mode: 'import' })`:
    - `{path}` returns the file URL. A `.tsx` target is `tsx-unsupported`, naming both the file and its importer.
    - `{external}` (packages, and in-repo JSON) goes to `nextResolve`.
    - `{error}` is `unresolved-import`.
- **Load hook:**
  - Applies to repo `.ts`, `.mts` and `.cts` files.
  - Reads the source and returns `{ format: 'module-typescript', source, shortCircuit: true }`, which forces ESM whatever `"type"` says.
  - Maps Node's `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` to `non-strippable-syntax`, naming the file.
  - Records every repo file it loads into `loadedFiles`.
  - **Acceptance:** the test matrix on Node 22.18 and 24 must prove `module-typescript` is accepted from `registerHooks`. If it isn't, fall back to `module.stripTypeScriptTypes` plus `format: 'module'`.
- **Node checks:** the child checks `module.registerHooks` and `process.features.typescript`, and reports `loader-node-version` if either is missing. `engines` is raised to `>=22.18` in C.

### Fallback mode

- No Block Beaver hooks are registered.
- The `loader` package is resolved from the repo root; if it isn't found, the result is `loader-package-missing`.
- The kernel comes from the repo's own `node_modules`, which B's exact pin guarantees.
- Test with a fixture loader package in fixture `node_modules`. No `tsx` dependency.

### Import order inside the child

1. Contracts, in config order.
2. Manifests, sorted by path.
3. Generators.

Each failure is isolated as a diagnostic, and loading continues.

The child performs:
- the export rules from §3;
- the JSON round trip: `isDeepStrictEqual(JSON.parse(JSON.stringify(v)), v)`, where a cycle throws and counts as `manifest-not-json`;
- the ID/file-name and family checks;
- kernel `validateManifest(build, family)`;
- the allowed-kinds check;
- then `check()`, after all manifests are loaded.

### Parent API

```ts
parseFamiliesConfig(config): { families: FamilyConfig[]; generators: string[]; diagnostics }
loadFamilies({ root, config, paths, resolutionSignature, fileHashes /* path→hash from graph */,
               generate?: { keys: string[]; graph; label: string|null } }): Promise<FamilyLoadResult>
type FamilyLoadResult = { key: string; families: FamilyInfo[] /* JSON copy of the definition minus check, hasCheck, config entry, floor index */;
  manifests: { family; id; ref; graphId; path; exportName; value; hash }[]; generators: GeneratorInfo[] /* {key,source:'builtin'|'custom',family?,path?,out,inputs,cache,closureHash} */;
  loadedFiles: string[]; fileHashes: Record<string, string>; diagnostics: Diagnostic[]; outputs?: ({ key; content } | { key; diagnostic })[] };

`fileHashes` is additive metadata for parent graph/generator integration; it reports SHA-256 hashes of the exact source bytes read by the loader child. Existing callers may ignore it. Cache eligibility is internal to the loader and is not part of the public result.
```

**Freshness cache:**
- The key is a sha256 over: protocol version, CLI version, `process.version`, the families/generators/loader config, `resolutionSignature`, the files matched by the globs, and content hashes of (previous `loadedFiles` ∪ glob matches).
- Results are cached per root, and loads already in flight are shared by key.
- A load with `generate` always spawns a child.

**Wire protocol (one message each way):**
- To the child: `{ protocol: 1, root, paths, config, kernelUrl, generate? }`.
- Back to the parent: `FamilyLoadResult` without `key`.

`canonical.mjs` exports:
- `canonicalJson(v)`: keys sorted recursively, no whitespace;
- `manifestHash(v)`: `'sha256:<hex>'`.

## 5. Validation in the parent, links and graph attach

File: `src/families/graph.mjs`. Everything here is pure except `project.resolveImport`.

```ts
extractLinks(family: FamilyInfo, manifest): { links: { field: string /* concrete $.path */; target: string /* graphId */; kind }[]; diagnostics }
attachFamilies(graph, { load: FamilyLoadResult, project, history?: HistoryDoc }): graph   // mutates, like attachLocalRegistry
findUnclaimed(families: FamilyConfig[], filePaths: string[]): Diagnostic[]
```

**Link values:**
- `null` or a missing value creates no edge.
- A bare `id` is allowed only when `to` names a single family. `family:id` must name a family listed in `to`.
- Any other type is `link-value-invalid`.
- A leaf that is an array but isn't marked `[]` in the path is an error.
- Duplicate `(from, to, kind)` edges collapse into one, carrying a sorted `fields[]`.
- A missing target is `link-target-missing`.

**Implementation:**
- Resolved with `resolveImport(manifestPath, module, { mode: 'import' })`, relative to the manifest file and using **the manifest's home app**.
- A package target is `implementation-external`.
- A target that isn't a graph file is `implementation-unresolved`.
- Every entry in `files[]` must be a graph file node; otherwise `file-missing`.

**Block node:** `{ id, kind: 'block', family, floor, name, description, manifest, path, dependencies: sorted unique link targets }`. The existing `attachAppMetadata` then sets `app` and `usedBy`.

**Edges:**
- `implemented-by` links only to the resolved module and each optional `files[]` entry, matching the design boundary. Manifest file nodes carry `familyRole: "manifest"` and `owningBlock` metadata for agent context without widening implementation ownership.
- Link edges: `{ from, to, kind, link: true, fields, evidence: { file: manifestPath, line: 1, column: 1, text: 'field → ref' } }`.

**File nodes:** contract and generator files get `familyRole: 'contract' | 'generator'`.

**Graph-level keys:**
- `families: [{ id, floor, title, blurb, linkKinds, count }]`
- `history: [{ date, label, blocks: graphId[] }]`

`graph.json` stays at **`schemaVersion: 2`**. These keys are optional and additive.

**Discovery check:** take the last static directory segment before the first wildcard in each manifest glob and replace it with `*`. For example, `blocks/services/*.ts` becomes the shape `blocks/*/*.ts`. A file that matches a shape but no family glob is `family-unclaimed`, reported against its folder. Globs with no such segment are exempt.

**`glob.mjs`** has its own matcher: `*`, `**`, `?`, `{a,b}` alternatives, character classes, and `!` negation. It walks the repo with the scanner's standard exclusions and the 20,000-file limit.

## 6. Generators, cache, history and import

Files: `src/families/{generate,builtin-generators,cache,history,commands}.mjs`.

```ts
planGeneration({ root, config, graph, paths, label, now?, extraOutputs? /* {key,out,render():string}[] — the integration owner wires the view module here */, loadFamilies? /* injectable */ }): Promise<Plan>
type Plan = { outputs: { key; out; expected: string; current: string|null; status: 'fresh'|'stale'|'missing'|'conflict'|'cached' }[]; diagnostics; cacheUpdate };
applyGeneration(root, plan): Promise<{ written: string[]; diagnostics }>   // through writeProjectFiles with `before` preconditions; also writes the cache
checkGeneration(plan): Diagnostic[]                                        // family-drift; writes nothing, including the cache
```

**Order is fixed:**
1. `registry` per family, in config order;
2. `index`;
3. custom generators per family, in family order;
4. top-level custom generators;
5. extra outputs;
6. `history` last.

Generators never see each other's output. Two claims on the same `out` is `output-collision`, and both claimants are named.

**Generator context** is deep-frozen and contains:
- `config`;
- `families`;
- `manifests(familyId)`;
- `blocks()`;
- `graph`;
- `resolve(from, spec)`, which is A's `resolveImport`;
- `label`.

There is no clock, to keep output deterministic.

**Headers** are added by the runner, never by the generator. The text is `generated by block-beaver from <inputs globs>; do not edit`:
- `//` style for JS and TS family extensions;
- `/* */` for CSS;
- `<!-- -->` for `.md` and `.html`;
- **none for `.json`**;
- anything else is `output-unsafe`.

**Content normalisation:** LF line endings and a trailing newline.

**Overwriting:** an existing headered target that lacks the header is `output-conflict`. JSON outputs explicitly claimed by config (the index and configured JSON custom-generator outputs) may be overwritten intentionally. Other JSON files are not implicitly writable. Reserved paths, including `.git`, `node_modules`, and `.blocks/cache/`, are rejected before generation.

**Registry output:**

```ts
import { createRegistry } from 'block-beaver/kernel';
import m0 from './…/a';            // or `import { name as m0 }`; extension from importExtension
export const endpointRegistry = createRegistry('endpoint', [m0, …] as const);  // `<camelFamily>Registry`, or exportName
export type EndpointManifest = (typeof endpointRegistry)['all'][number];
export type EndpointId = EndpointManifest['id'];
```

An empty family emits `[] as const`.

**`.blocks/index.json`:**
- A **bare JSON array of the manifests exactly as authored**.
- Ordered by family config order, then by ID.
- Written as `JSON.stringify(…, null, 2) + '\n'`.
- Contract name: **index v1**. The array stays unwrapped: a breaking change ships a new file (`index.v2.json`) next to v1 for one major release.
- The index is regenerated, never migrated. So `migrations.mjs`'s `index` kind must be removed or special-cased, because `validateDocument` rejects arrays.

**Cache file `.blocks/cache/generators.json`:**
- Shape: `{ schemaVersion: 1, blockBeaver, entries: { [key]: { inputsHash, outHash } } }`.
- `inputsHash` = sha256 of (CLI version, generator `closureHash`, `out`, and sorted `[path, contentHash]` pairs for the input glob matches).
- Skip a generator only when `inputsHash` matches **and** the file on disk hashes to `outHash`.
- Invalid JSON or the wrong version is treated as an empty cache, with no error.
- Built-in generators are never cached. `cache: false` turns caching off for a custom generator.

**History file `.blocks/history.json`:**

```json
{ "schemaVersion": 1, "entries": [ { "date": "2026-10-01T12:00:00Z", "label": "…" | null, "source": "gen" | "import",
  "changes": [ { "op": "upsert", "block": "fam:id", "hash": "sha256:…" | null }, { "op": "delete", "block": "fam:id" } ] } ] }
```

- An entry is **one gen run**. Its changes are sorted by block reference.
- An entry is appended only if replaying the history gives a different block-to-hash map from the current one.
- The stored date is UTC with seconds precision. Imported date-only values (`YYYY-MM-DD`) are accepted.
- Under `--check`, a needed append is reported as `history-stale`.

```ts
readHistory(text|null), replayHistory(doc), appendHistory(doc, current: Map<ref,hash>, { label, now }),
historySnapshots(doc), importHistory(source, mapping, current, existing)
```

**History import** (`history import <file> --map <map.json> [--dry-run]`):
- Source format: `{ schemaVersion: 1, entries: [{ date, label?, changes: [{ op, key }] }] }`. The repo converts its old file into this format itself.
- Map format: `{ oldKey: "fam:id" }`. A key that isn't mapped is refused.
- Dates must not go backwards.
- The import is refused if history already has entries.
- Replay must end at **exactly** the current set of blocks.
- On success, the final `upsert` of each surviving block gets the block's current hash. Without that, the next `gen` would append a no-op entry for every block. Every imported date and label is kept.

## 7. Kit and scaffolds

Files: `src/families/{kit,scaffold}.mjs`.

**Invocation:** `block-beaver kit <cmd> [args] [--json '<json>' | --json -]`. Output is `{ ok: true, result } | { ok: false, error: { code, message, details? } }` with exit 0 on success, 2 for a kit error before target writes, or 1 if scaffold files were written but generation or reload failed, and nothing else on stdout.

| Command | Input | Result |
|---|---|---|
| `list` | `{ family? }` | `{ families: [{ id, floor, count }], blocks: [{ ref, graphId, family, name }] }` |
| `describe <family>` | none | `{ kernelSchemaVersion: 1, id, fields, core, implementation, links, generators, map, scaffold: { files: [path], manualSteps } }` |
| `validate` | `{ manifest, family?, mode? }` | `Result`, plus link and target checks in build mode |
| `compose` | `{ family, dynamic: [] }` | `{ family, ids, dynamic }`, or `duplicate-id` |
| `create <family> <id>` | `{ name?, description?, rationale /* required */ }`, plus `--dry-run` | `{ written: [{ path, bytes }], manualSteps, gen }` |

**Scaffold tokens:** `{{id}}`, `{{family}}`, `{{camelId}}`, `{{pascalId}}`, `{{name}}`, `{{description}}`, `{{rationale}}`, plus a JSON-quoted `{{json.<token>}}` form. Any other token is `scaffold-token-unknown`.

**Defaults:** `name` defaults to the ID; `description` defaults to `name`.

**`create` checks:**
- The rendered manifest path must match the family glob, and the ID must equal the glob's captured part.
- **If any target exists, nothing is written** (`create-exists`, listing every path). There is no `--force`.
- `--dry-run` runs the identical checks and returns the same result, including failures.
- Writes are all-or-nothing, using `before: null`.
- Then `planGeneration` + `applyGeneration` run, and a reload validates the new manifest. If gen fails, the files stay, `ok` is false, and the exit code is 1.

## 8. Map floors (C4, integration owner)

- **Inputs:** `graph.families`, block `floor`, link edges and `graph.history`. Nothing domain-specific is hard-coded.
- **Link colour:** a fixed palette, indexed by a hash of the kind string. A token `link-<kind>` overrides it.
- **Skin:**
  - The CSS is read and inlined into a nonce-bearing `<style>`.
  - Reject it if it contains `</style`, `@import`, or `url(` that isn't `data:`.
  - Each token becomes `--bb-<name>: value`, with a kebab-case name. Values containing `; { } < >` or `url(` are rejected.
- **Storage keys:** `block-beaver:<sanitised repo basename>:…`.
- **Also part of C4:** removing `attachTeacakeRegistry` and `runTeacakeKit`.

## 9. Lint: `block-beaver/eslint` (C5)

- Shipped as a flat-config plugin `{ rules: { 'no-block-id-literal' }, configs: { recommended } }`. It does not import `eslint`.
- **Data source:** reads `.blocks/index.json` and `.blocks/config.json` synchronously, cached by mtime.
- **What it flags:** string literals, and template literals without expressions, that equal:
  - a qualified `fam:id` or `block:fam:id` (always); or
  - a bare ID, but only for families listed in the `bareIds` option, with `minBareLength` defaulting to 3.
- **Skipped files:** generated-header files, manifest, contract and generator files, and files matching `allow` globs.
- **Baseline:** `.blocks/baseline.json` → `lint['no-block-id-literal'][file] = count`. The rule reports only beyond the allowed count. With `reportUnusedBaseline`, it also says when a file's count could be lowered.
- **Escape hatch:** the standard `eslint-disable-next-line` comment.

## 10. Integration-owned changes (wait for B, since B lanes touch these files)

- `package.json`:
  - exports `./kernel` (with `types`) and `./eslint`;
  - `engines` raised to `>=22.18`.
- `scripts/check.mjs`: the kernel size budget.
- `bin/block-beaver.mjs`: dispatch for `gen`, `history`, `kit` and `lint` into `families/commands.mjs` and `kit.mjs`.
- `scanner.mjs`: add `scanProject(root, opts) → { graph, project }`. `scanRepository` stays unchanged.
- `block-map.mjs` `updateProject`: call `loadFamilies` → `attachFamilies` in place of the TeaCake adapter.
- `audit-rules.mjs`:
  - undeclared-link reads `node.dependencies ?? manifest.dependencies`;
  - `auditCounts` excludes files that are `generated` or have a `familyRole`;
  - a new `familyDiagnostics` parameter feeds `manifest-valid` and `config-valid`.
- `migrations.mjs`: handle `index` as in §6.
- B's `.blocks/.gitignore` template must ignore `cache/` and must not ignore `index.json` or `history.json`.
- Optional speed-up: a `loadProjectModel` option that skips detection when it is handed a config, which cuts child start-up time.

## 11. Worker slices, dependencies and public-seam tests

| Worker | Owns | Depends on | Tests (public seams) |
|---|---|---|---|
| W1 kernel | `src/kernel/*`, `tests/kernel.test.mjs` | none | validate vs coerce (defaults, unknown keys), every Issue code, schema JSON round trip, registry and compose collisions, runtime refuses `module` and `files`, no non-relative imports, subpath import |
| W2a loader | `src/families/{config,glob,loader,load-worker,hooks,canonical}.mjs` | W1 interface | the loader matrix in the plan (extensionless, alias via home app, `type` absent or present, `.tsx`, enum/namespace/parameter property, fallback loader), export rules, JSON purity incl. cycles, freshness reload after an edit, concurrent dedupe, no hooks left in the parent |
| W2b graph | `src/families/graph.mjs` | W1, plus the W2a result shape (use fixtures) | nested `[]` links, bare vs qualified refs, missing target, cross-app implementation, `files` boundary, `family-unclaimed`, duplicates |
| W3 gen/history | `src/families/{generate,builtin-generators,cache,history,commands}.mjs` | inject `loadFamilies` | byte-stable second run, `--check` missing or modified with no writes, cache hit/miss/corruption, ordering, collision, headers, registry and index golden files, history append/no-op/UTC, import mapping, replay mismatch, existing-history refusal |
| W4 kit | `src/families/{kit,scaffold}.mjs` | inject W2a and W3 | every command's JSON, multi-file scaffold, manual steps, dry-run parity, `create-exists`, gen after create |
| W5 map | `block-map.mjs`, `app.js`, `index.html`, `styles.css`, `adapter.mjs` | §5 graph keys (use a fixture graph) | zero, one and several families, floor order and labels, link colours, skin and tokens, CSP, header slot, module export, history slider; check the console Blocks view |
| W6 lint | `src/eslint/*` | the index v1 contract | flagged and skipped cases, baseline suppression |
| Integration | §10 files, plus `tests/domain-guard.test.mjs` and the denylist fixture (the orchestrator supplies the proof-of-concept vocabulary) | after B lands | `npm run check` and the adoption fixture |

W1, W2a, W5 and W6 can start now. W2b, W3 and W4 can start against injected fakes.

## 12. Major traps

1. **The parent process never imports repo TypeScript.** That includes `kit list` and the server. Every load goes through the child.
2. **`fork` copies the parent's `execArgv` and env by default.** Without explicit settings, `--test` or `NODE_OPTIONS=--no-experimental-strip-types` silently break the child.
3. **Ownership must match:** the child must get the same `paths`. A file missing from `paths` resolves with the root's options, so a nested app's aliases quietly fail.
4. **A's resolver returns `{external}` for in-repo `.json`.** Pass those to `nextResolve`; don't treat them as errors. A `.js` specifier that points at a `.ts` file works only through the resolve hook, so fallback loaders may differ. Document that.
5. **`undefined` fails JSON purity**, so manifests must leave optional keys out. Also, `createRegistry` deep-freezes imported manifest objects inside the host app.
6. **`localeCompare`, `Date.now()` and object-key order from `Object.keys` on records all break determinism.** Use code-unit order, an injected `now`, and canonical JSON for hashes.
7. **History merge conflicts:** two branches that both append will conflict in `history.json`. After the merge, `gen` appends a reconciling entry. Don't use sequence numbers.
8. **Without the `auditCounts` change**, contracts and generated registries inflate the coverage ratchet the first time C runs.
9. **The kernel can't contain `Symbol.for`-at-top-level side effects** or freeze calls. Create brands lazily inside the `define*` functions.
