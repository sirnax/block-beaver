# Block Beaver families layer plan (C)

**Status:** Ready for implementation planning after B's release gate. C is deliberately not being implemented before B completes. This document records the proposed slice boundary and contracts from the agreed [v0.2 design](2026-10-01-block-beaver-v0.2-design.md).

## Purpose

Let an adopting repository define typed block families as data, validate and load their manifests, generate deterministic derived files, and view family floors without putting any domain vocabulary into Block Beaver. The base graph and file-boundary workflow remain useful when no families are configured.

## Current code and integration points

- `src/project-model.mjs` is the source for app ownership, compiler options and resolution introduced by A. C must resolve implementation module specifiers with that model's resolver and preserve home-app ownership.
- `src/scanner.mjs`, `src/adapter.mjs` and `src/block-map.mjs` currently scan and render local and TeaCake registries. The TeaCake-specific recognition in `src/adapter.mjs` is temporary and must be removed when C ships; generic family loading becomes the sole path.
- `src/view.mjs` exports the pure `prepareView` serving helper. The family map must retain the one-document, nonce and host-header contracts already defined there.
- `src/contracts.mjs` validates Block Beaver's current local-block schema. Family manifests have their own schema and must not make local-block fields such as `files` or `dependencies` mandatory for every family.
- `bin/block-beaver.mjs` is a command dispatcher. C adds `gen`, `history import`, and JSON-in/JSON-out `kit` commands; behavior should live in focused modules, not accumulate in the dispatcher.
- `package.json` currently exports `.` and `./view`. C adds stable public entry points for `block-beaver/kernel` and `block-beaver/eslint` while preserving those exports. The kernel must have no runtime dependencies or I/O.

## Proposed block boundary

Treat C as several reviewable slices with one integration owner for graph/view/config shared files:

| Slice | Owned responsibilities / likely files | Connections |
| --- | --- | --- |
| C1 family config, loader and validation | New `src/families/` modules for family definitions, manifests, JSON-purity checks, links and implementation resolution; project config parsing integration | A project model/resolver; graph block/link nodes; audit's manifest-valid and discovery checks |
| C2 generation and history | New generator runner and history modules; CLI dispatch for `gen` and `history import`; generated output metadata integration | Family loader; deterministic input hashes; graph generated-file marker; `.blocks/cache/`; config output paths |
| C3 kernel and kit | New kernel entry module and focused schema/registry/manifest modules; new kit command module; package exports | Family contract types and JSON schemas; loader; scaffold and generator APIs |
| C4 family map and removal of adapter | `src/block-map.mjs`, `src/adapter.mjs`, `src/app.js`, `index.html`, `styles.css` as actual presentation changes require | Generic family graph; A app/folder grouping; typed links; history snapshots; existing view export/nonce contract |
| C5 opt-in lint | New `eslint` export/package files as needed | Family IDs, generated/allowed-file config, baseline ratchet from B |

The owner should keep C1/C2 contracts stable before parallel implementation. C4 owns the shared graph/view integration. Changes to the local console must also be checked with a representative configured-family graph. C5 can proceed independently after the family ID contract is fixed.

## Contracts to implement

### Configuration and family contract

- `.blocks/config.json` may omit `families`; omission means base-layer behavior and no family loading or floors.
- If present, `families` is the only ordered family list. `id` identifies the family; `contract` resolves to a TS-family definition module; `manifests` is a repo-chosen glob. Order is the visual floor order. No family IDs, suffixes, or directories are assumed.
- A family definition carries its own schema fields, allowed implementation kinds, typed links, requested built-in generators, optional map title/blurb, optional scaffold, and optional validation check. Define public helper surface (`defineFamily`, schema DSL) without making repository-specific semantics implicit.
- Core manifest fields are `id`, `family`, `version`, `name`, `description`, and required nonempty `rationale`. Other fields are defined by the family schema. Reject duplicate family IDs and invalid config paths/globs with diagnostics naming the field/file.

### Loader and manifest validation

- Contracts, manifests and custom generators load as TS through the resolver from A. Relative extensionless imports and aliases must follow the importing file's home app compiler options. Respect optional `loader` fallback if configured.
- Node type stripping supports `.ts`, `.mts`, `.cts`; explicitly reject `.tsx` and syntax Node cannot strip with an error naming the first offending file and rule. Force ESM interpretation independent of host package `type`.
- A manifest module has exactly one export; its ID matches the basename under the configured manifest glob, its family equals the family currently loaded, and `implementation.kind` is allowed by the family. JSON stringify/parse must succeed, proving the value contains only pure serializable data. Run optional family check after structural validation.
- Convert each configured link's `field` path (including `[]` array segments) into typed graph edges. Every target must exist; unknown target family/ID and malformed field paths are errors. Resolve `implementation.module` with A's home-app resolver and represent that target as the implementation edge. Add optional `files` to the file boundary. Feed family blocks into the existing coverage and undeclared-link audit rules.
- A manifest-pattern-matching folder not claimed by any configured family is a discovery error. Errors should identify the config, family, manifest or link path precisely.

### Generator and history contract

- `gen` writes outputs; `gen --check` is read-only and reports every stale or missing output, suitable for B's `family-drift` audit rule. Output content and ordering are deterministic.
- Built-in `registry` emits a typed read-only module importing only `block-beaver/kernel` and that family's manifests. Output path is config-owned; export naming follows documented default with optional family `exportName`.
- Built-in `index` writes `.blocks/index.json`, a versioned array ordered by family config order and then manifest ID.
- Built-in `history` appends a UTC-dated entry only when a manifest hash changes. Label is config `history.label` or `--label`; never infer it from other documents. History import takes an explicit old-key to `family:id` map, preserves every imported date/label, and refuses unless replay equals the current block set.
- Custom generators declare output and real input globs. Context exposes read-only family manifests, project graph, config and resolver. Cache input hashes under ignored `.blocks/cache/`; skip unchanged inputs. Fixed deterministic ordering; duplicate output claims are errors. All outputs get a generated/do-not-edit header and scanner generated marker.
- The design has not specified cache invalidation format, generator error shape, history entry schema, or how checked-in history is reconciled with old entries; settle these before implementation and record them here.

### Kernel and kit contract

- `block-beaver/kernel` exports the schema DSL, strict `validate`, lenient `coerce` (apply defaults while retaining unknown keys), `createRegistry`, `compose(static, dynamic)` and `validateManifest(manifest, { mode })`.
- Registry composition must reject duplicate IDs; dynamic entries cannot shadow static entries and static entries cannot shadow each other. `validateManifest` in runtime mode rejects executable `kind: 'module'`. Kernel is dependency-free, I/O-free, tree-shakable and size-budgeted; CLI/package version matches it.
- Schema DSL must serialize to JSON (no closures in compiled schema representation). Keep diagnostics machine-readable and stable enough for CLI and kit callers; final exact return shape is an owner decision.
- Kit commands accept JSON inputs and return JSON outputs: `list`, `describe <family>`, `validate`, `compose`, `create <family> <id>`. Create renders manifest and companion templates, reports manual steps, supports `--dry-run`, and invokes generation after writes. Validate paths against repo root and preserve owner files: the exact overwrite policy needs an owner decision.

### Map contract

- With no families configured, preserve the existing base map. With families, render one isometric floor per family in config order using configured title/blurb, typed links colored by link kind, ordinary source slabs grouped by A app and folder, and a history slider.
- Do not embed individual families or field meanings. Skin CSS and tokens come from config; labels, colors and browser-storage keys must not bake in a proof-of-concept app's vocabulary or identity. Retain single-document HTML, CSP nonce placeholders, host-header slot, and module export behavior.
- Family graph/view test fixtures must include zero, one and multiple families, and a non-default family vocabulary. Verify local console Blocks view using a representative manifest after integration.

## Required fixtures and public-seam acceptance

Use disposable Git repositories for commands that write `.blocks/` state. Keep fixture family vocabulary invented for tests and avoid proof-of-concept domain names/paths.

- Config with zero, one and several families; arbitrary manifest paths/suffixes; two distinct families with their own fields/link kinds; unclaimed matching folder; invalid IDs and duplicate IDs.
- TS loader matrix: extensionless relative contract import; tsconfig alias; package `type` absent and present; `.tsx`; non-strippable enum/namespace/parameter property; configured fallback loader; diagnostics identify the failing file.
- Manifest validation: export count, filename/id match, family mismatch, forbidden implementation kind, JSON round-trip rejection of function/cycle, optional check pass/fail, missing link target, nested array link path, cross-app implementation target, optional extra files in file boundary.
- Generator checks: clean generation twice is byte-stable; `--check` catches missing and modified outputs without writing; real-glob cache hit/miss; deterministic order; collision failure; generated marker; registry/index output contract; history changed/unchanged manifests and UTC; import mapping preservation and replay mismatch refusal.
- Kernel: defaults and unknown-key behavior for validate/coerce; registry uniqueness and composition collisions; build accepts module while runtime rejects it; no I/O/dependency import; package subpath import; size budget.
- Kit: every command's JSON input/output; describe/validate/compose behavior; multi-file scaffold; manual steps; `--dry-run` writes nothing; create paths safe and existing owner content handling as decided; create followed by generation.
- Map/view: floor order and custom labels, link-kind coloring, ordinary file slabs and app grouping, history scrubber, no family config baseline, skin tokens, self-contained output/CSP/header/module requirements, deterministic generation.
- Domain guard: denylist fixture contains proof-of-concept family IDs, fields and paths. Scan Block Beaver-owned source/config/templates/CLI/docs implementation-facing fixtures and fail on occurrences; keep the denylist itself as the documented exception. Avoid putting denied vocabulary into generic tests beyond the fixture.
- Adoption check: adapt a disposable existing-family-system fixture with manifests unchanged; compare generated registry semantics against its pre-migration registry.
- Run focused tests for changed contracts, then repository `npm run check` and CI matrix. C ships only after B's live-editor release gate and C's own checks pass. Do not publish from this plan; A-C are locally authorized.

## Decisions to settle before C implementation

1. **Family manifest exact shape:** design describes `implementation.kind` and `.module` but does not give the complete object schema or how `none` is represented.
2. **Link resolution semantics:** specify scalar and array path extraction, whether duplicate links collapse, and whether target IDs are `family:id` or another canonical form.
3. **Schema DSL API:** define supported primitives/combinators, optional/default/null behavior, coercion diagnostics and JSON serialization format. Keep this generic and domain-neutral.
4. **Registry generated type shape:** define import form, readonly guarantees, export default/name, and behavior with empty family; retain custom generator escape hatch.
5. **History format:** version the entry/index/replay structures, define identity/hash canonicalization and how import interacts with already existing history.
6. **Custom generator trust boundary:** generators execute repository code. Specify invocation permissions/environment, determinism expectations, cache corruption recovery, and whether `gen --check` may execute them (presumably yes, but read-only outputs).
7. **`kit create` collision policy:** choose fail-if-exists by default vs explicit force/merge; dry-run must predict the same result.
8. **Skin loading/security:** define whether CSS is inlined and how tokens map to custom properties while preserving CSP and safe output.
9. **`no-block-id-literal` semantics:** define the source scan rules, generated/allowed path config, baseline shape and false-positive escape hatch.
10. **Graph format compatibility:** define family node IDs and graph schema/version changes without breaking existing local-block IDs, adapter consumers or A's `graph.json` v2.

## Completion record

- 2026-10-01: Plan prepared from the agreed design and current interfaces. Implementation intentionally waits for B's gate. Parent agent owns the overall ROADMAP and integration schedule.
