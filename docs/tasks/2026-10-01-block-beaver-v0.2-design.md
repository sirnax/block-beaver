# Block Beaver v0.2 design: multi-app projects, install and upgrades, families

**Status:** design agreed with the owner on 2026-10-01. Not yet planned or implemented.
Each sub-project below gets its own implementation plan, in order: A, then B, then C.
E is a direction for later versions, not a design.

## Why

Block Beaver is meant to be the reusable, public form of the block method: software
built from bricks with clear isolation and declared relationships. A private application
served as its proof of concept. Using the method there showed four gaps that stop Block
Beaver from being adopted reliably elsewhere:

1. **Multi-app repositories are misread.** `@/` is hard-coded to `<root>/src/`, and
   tsconfig is never read. So `paths` aliases, per-app overrides, project references
   and workspace packages produce wrong edges or no edges.
2. **No reliable way to enable the method and keep it enabled.** Install writes
   instruction text, but it adds no skill, no agent hooks, no commit or CI gate (those
   exist only on the unmerged `codex/block-compliance` branch) and no version stamp.
3. **No upgrade path.** A repo that installed an older version only improves if someone
   re-runs setup by hand, and nothing migrates its files.
4. **No typed families.** The proof of concept's strongest guarantees came from typed
   block families: a manifest is the source of truth, and codegen derives registries
   from it, with `--check` blocking drift. Block Beaver has only file-boundary blocks.

## Principles

- **Two layers, both in Block Beaver.**
  - The **base layer** is file-boundary governance: the map, scopes, proposals,
    worktree checks and audit. Every repo gets it.
  - The **families layer** adds typed, repo-defined families (manifest → codegen →
    check). It is optional.
- **Block Beaver ships no domain.** It has no built-in family names, fields, link kinds,
  folder layout, file suffixes, access levels, events, themes or fonts. Everything
  domain-shaped is supplied by the repo through config. A guard test enforces this
  (see C.3).
- **Compiler-accurate, not pattern-accurate.** Module resolution uses TypeScript's own
  resolver, so Block Beaver follows the same rules the compiler does.
- **Fail soft in the session, fail hard at the gate.** Agents get guidance, never a
  stall, by default. Commit and CI are where things are blocked. The strength is set
  per repo.
- **Upgrades are explicit and enforced.** A repo knows when it is behind, and it cannot
  merge a half-applied upgrade.
- **The owner's edits always win.** Detection and upgrades never silently overwrite
  owner-authored config or text.

---

## Sub-project A: project model and multi-app scanning

### A.1 Config and file ownership

`.blocks/config.json` is committed and versioned. It is written automatically on first
run and can be edited by hand.

```json
{
  "schemaVersion": 1,
  "apps": [
    { "id": "web",    "root": ".",           "tsconfig": "tsconfig.json",             "source": "detected" },
    { "id": "admin",  "root": "apps/admin",  "tsconfig": "apps/admin/tsconfig.json",  "source": "detected" },
    { "id": "worker", "root": "worker",      "tsconfig": "worker/tsconfig.json",      "source": "config", "entries": ["worker/index.ts"] }
  ],
  "ignore": ["scripts/archive/**"]
}
```

**Detection** finds apps from three sources:
- the workspace declarations: `pnpm-workspace.yaml`, or `workspaces` in package.json
  for npm and yarn;
- every `tsconfig.json` that includes files (pure `extends` bases are skipped);
- the repository root, when it has source files of its own.

App ids default to the folder name and can be renamed.

**The owner's entries win.**
- An entry the owner edited or added is marked `"source": "config"`, and detection never
  changes it.
- Detection only adds newly found apps. Apps that have disappeared are *reported*, not
  removed.
- `block-beaver detect` prints the proposed changes; `--write` applies them.

**Ownership:**
- A file's home app is the app whose parsed tsconfig includes it. If more than one app
  includes it, the deepest root wins.
- Files that no app includes (scripts, tests, tooling) go into a visible
  **outside apps** group. They are never dropped.

`schemaVersion` is the hook that B's upgrade migrations use.

### A.2 Resolution, cross-app links and "used by"

**Resolution per app.**
- Each app's tsconfig is parsed with `ts.parseJsonConfigFileContent`, following
  `extends`, `baseUrl`, `paths` and `references`.
- Each app gets one `ts.createModuleResolutionCache`.
- Every import is resolved with `ts.resolveModuleName`, using **the home app's** compiler
  options. So an alias that a nested app overrides resolves to the nested app's file, not
  the root's.
- Imports of workspace packages that resolve through `node_modules` symlinks are mapped
  back to their source paths in the repo.

**What gets resolved:**
- static `import` statements;
- `export … from` re-exports;
- literal `import("…")`;
- literal `require("…")`.

Literal dynamic imports were a known gap in the keystone work.

**Graph changes.**
- Every file node carries `app`.
- An edge whose two ends sit in different apps carries `crossApp: true`.
- Third-party packages stay out of the graph, but each app's package list is recorded.

**Entry points and `usedBy`.** Entry points are detected for each app:
- Next.js `app/` and `pages/` route files, plus `middleware` or `proxy`;
- package.json `main`, `bin` and `exports`;
- the `main` declared by wrangler or a similar worker config;
- any `entries` listed in the config.

Walking the graph from each app's entry points gives every file `usedBy: [appId…]`.
Files that no entry point reaches are reported as **unreachable**.

**The resolution report.** Every import that can't be resolved is listed per app, with
file and line. The scan summary shows the count, and the map shows a warning badge. A
misread becomes visible instead of silently disappearing.

### A.3 Map and console

The generated view (`.blocks/view/index.html`) and the live console both gain an
**app level above folders**:

- **One area per app,** with a heading showing its file and block counts. The outside
  apps group is its own area.
- **Folders are grouped relative to each app's root,** so a nested app's `app/`, `lib/`
  and `components/` appear separately instead of collapsing into one entry.
- **A used-by chip** (`web · admin`) on any file or block used by more than one app.
- **Cross-app links** are drawn in their own line style. Clicking one shows its source
  line, as with any other edge.
- **An app filter** (all, one app, or only cross-app links) next to search.
- **A health badge per app** for unresolved imports, unreachable files and tsconfig
  errors. It opens the resolution report.

`graph.json` moves to `schemaVersion: 2`, which adds a top-level
`apps: [{ id, root, entries, counts, health }]`. Single-app repos look the same as today.

### A.4 Errors, performance and testing

**Errors fail soft per app.**
- If an app's tsconfig is unreadable or invalid, that app falls back to the root's
  options, gets `health: "error"`, and is named in the report. The scan carries on.
- A config entry that points at a missing root or tsconfig gets a message naming the
  field.
- `--strict` turns these problems into a non-zero exit. CI uses it (see B).
- The existing 20,000-file limit and path-safety rules are unchanged.

**Performance.**
- Each app's tsconfig is parsed once per scan, with one resolution cache per app.
- The existing incremental rescan re-resolves only changed files and the files that
  import them.
- Scan time on a real multi-app repo (about 1,300 files across 3 apps) is measured by a
  benchmark test and kept within the same order of time as today's single-root scan.

**Tests** use `node:test` with disposable Git fixtures. Fixtures:
1. a root app that lends its `src/` to a nested app, which has its own alias and an
   override of a root alias, plus a worker with its own tsconfig;
2. a pnpm workspace with a `packages/ui` that uses `exports`;
3. npm and yarn workspaces;
4. tsconfig `extends` chains and project references;
5. a single-app repo, to prove the output is unchanged.

The tests assert:
- each file's owner;
- the exact resolved target of each import;
- `crossApp` flags and `usedBy`;
- unreachable files and resolution-report entries;
- that detection never overwrites owner entries;
- the `graph.json` v2 shape.

**Removed:** the hard-coded `@/` → `src/` rule in `src/plugins/js-ts-react.mjs`.

---

## Sub-project B: install, agent integration and upgrades

### B.1 Distribution and install

Block Beaver is **published to npm** and pinned as an **exact devDependency**. The
version then lives in the lockfile, CI uses the same one as the laptop, and
Dependabot or Renovate propose upgrades.

`npx block-beaver install` runs these steps. Every step is safe to re-run.

1. **Pin.** Add `block-beaver` as a devDependency with the repo's own package manager
   (pnpm, npm, yarn or bun), detected from the lockfile.
2. **Config.** Run A's detection and write `.blocks/config.json` with:
   - `"blockBeaver": "<version>"`, the version stamp;
   - `"enforcement": { "agents": "guide", "gate": "audit" }`. The `agents` setting can
     be `"guide"` or `"block"`.
3. **Agents.** For each detected agent, or those named with
   `--agents claude,codex,cursor,copilot`:
   - add a marked section to `CLAUDE.md`, `AGENTS.md`, the Cursor rule and the Copilot
     instructions;
   - install a **skill** at `.claude/skills/block-beaver/`, plus the Codex equivalent;
   - add **PreToolUse hooks** to `.claude/settings.json` and `.codex/hooks.json`. Each hook
     calls `block-beaver hook-check`, so the logic lives in the versioned CLI and not in a
     shell snippet copied into each repo.
4. **Git and CI.**
   - Add a pre-commit step running `block-beaver audit --staged`. It is chained into
     Husky, lefthook or `.git/hooks`, whichever the repo uses, and never replaces what
     is already there.
   - Add a CI step that runs `block-beaver audit --base <merge-base> --strict`, either as
     a reusable GitHub Action (`sirnax/block-beaver@v1`) or a GitLab template.
5. **Workspace.** Write `.blocks/WORKFLOW.md` and `.blocks/.gitignore`, run a first scan
   and write the view.

`--dry-run` lists every file it would touch, with diffs. `block-beaver uninstall` removes
the managed sections, hooks and devDependency, and asks before deleting `.blocks/`.

### B.2 Upgrades that reach existing repos

**Detection.**
- Dependabot or Renovate opens the version-bump PR.
- That PR's CI runs audit. Audit rule `managed-current` **fails** if the managed files on
  disk differ from what the new version would write, with a message like:
  "installed files are from 0.3.0, package is 0.4.0 — run `block-beaver upgrade`".
- So a half-applied upgrade cannot merge.

**`block-beaver upgrade`** runs three steps:
1. **Config migrations.** Ordered, pure functions, each tested with fixtures, move the
   config from `schemaVersion` N to N+1 one step at a time. A migration is never edited
   once it has shipped.
2. **Managed files are re-rendered:** marked sections, the skill folder, hook entries
   (found by id and *replaced*, never appended), the CI step and WORKFLOW.md.
3. **Data migrations.** Manifests, `graph.json` and roadmap files move forward through
   their own `schemaVersion` migrations. C's family manifests use the same mechanism.

Running `upgrade` twice changes nothing the second time. `--dry-run` shows the diff first.

**Local edits survive.**
- Each managed section has a **managed part** (`block-beaver:start` … `block-beaver:end`)
  and an optional **local part** directly after it
  (`block-beaver:local:start` … `block-beaver:local:end`). Block Beaver never touches the
  local part.
- Each managed part records a hash of what Block Beaver last wrote. If someone has edited
  inside a managed part, `upgrade` stops and shows the diff instead of overwriting, unless
  it is given `--force`.

**Releases** follow semver. Migrations ship only in minor and major releases, and a major
release lists its breaking changes in the CHANGELOG.

### B.3 Skill, hook-check and audit

**The skill** teaches the workflow:
1. inspect the owning block before changing anything;
2. stay inside that block's files;
3. declare any new link between blocks;
4. propose and check new blocks;
5. run `audit` before finishing.

Detailed reference material lives in `references/`, which the skill loads only when
needed.

**`hook-check`** is silent when it has nothing useful to say, fails open on any error,
and gives up after 500 ms. It adds context in these cases:

- **Reading or editing a file:** which block owns it, that block's dependencies and the
  blocks that depend on it, and whether the file is used by more than one app.
- **Creating a file outside every block:** a reminder to place it in a block or to record
  an exception.
- **A `git commit`:** a reminder to run `audit --staged` first.
- **`enforcement.agents: "block"`:** the edit is denied, with the reason and the command to
  record an exception.

**`block-beaver audit`** is the hard gate. Each rule has a stable id:

| Rule | Fails when |
|---|---|
| `managed-current` | Installed files don't match the package version |
| `config-valid` | The config has a schema error |
| `manifest-valid` | A manifest has a schema error, a missing file or an unknown dependency |
| `view-fresh` | The map or graph is out of date with the source |
| `undeclared-link` | A file in block X imports from block Y, and X doesn't list Y as a dependency |
| `coverage-ratchet` | The number of source files outside every block goes up |
| `resolution-ratchet` | The number of unresolved imports goes up (only with `--strict`) |
| `exception-valid` | An exception in `.blocks/exceptions/` has no reason, or names paths that no longer exist |
| `family-drift` (C) | Generated family outputs are out of date |

Ratchet counts are stored in `.blocks/baseline.json`.
- An existing repo starts from wherever it is today.
- Lowering a count is always allowed.
- Raising a count needs a recorded exception.

**Reuse.** B builds on the unmerged `codex/block-compliance` branch and doesn't redo it.
That branch already has `audit`, `integrate`, `exception`, receipts, a pre-commit hook,
CI templates and the live-editor test.

**Tests:**
- Install runs twice with no change the second time, across these fixtures:
  - package managers: pnpm, npm, yarn and bun;
  - hook managers: Husky, lefthook and bare `.git/hooks`.
- **Golden upgrade tests:** fixtures made by installing earlier versions are upgraded to
  the current version and must match a fresh install.
- The local part is preserved, and upgrade refuses when a managed part has been edited.
- Every audit rule has a fixture that passes and one that fails.
- The live-editor test, which runs real agent CLIs through the normal, bypass, failed and
  drift cases, is a **release gate**.

---

## Sub-project C: families layer

**Scope:** the build side, plus a small runtime kit. Block Beaver owns:
- family definitions;
- manifest loading and validation;
- codegen with `--check`;
- history;
- the kit;
- the map's family floors.

It also ships `block-beaver/kernel`, a small runtime package that generated code imports.
Domain runtime stays in each repo: brokers, access levels, event buses, renderers and
hosts.

### C.1 Defining families

Block Beaver **ships no families**. A repo with no `families` entry in its config uses
only the base layer.

The config lists each family **once**. That list is the only list, and its order is the
floor order on the map, from bottom to top. Paths and suffixes are whatever the repo
chooses.

```json
"families": [
  { "id": "service",  "contract": "blocks/service.family.ts",  "manifests": "blocks/services/*.ts" },
  { "id": "endpoint", "contract": "blocks/endpoint.family.ts", "manifests": "blocks/endpoints/*.ts" }
]
```

A contract is a TypeScript module that declares its own fields and link kinds:

```ts
export default defineFamily({
  id: 'endpoint',
  fields: s.object({ method: s.enum(['GET', 'POST']), service: s.string() }),
  implementation: ['module', 'none'],
  links: [{ field: 'service', to: 'service', kind: 'served-by' }],
  generators: ['registry'],
  map: { title: 'Endpoints', blurb: 'Public HTTP entry points.' },
  // optional: scaffold (a template for `kit create`), check (extra family validation)
});
```

**Core fields.** Block Beaver adds only the method's own core fields: `id`, `family`,
`version`, `name`, `description`, and a **required `rationale`**. Every block must say why
it exists.

**Loading rules.** A manifest is rejected unless:
- its module has exactly one export;
- `id` matches the file name;
- `family` matches the family it was loaded for;
- its implementation kind is one the family allows;
- it survives a JSON round trip, which proves it is pure data with no functions, clients
  or closures;
- the family's optional `check()` passes.

**Links are data.**
- Each `links` entry makes a typed edge between blocks.
- A link to a block that doesn't exist is an error.
- `field` paths accept `[]` for arrays (for example `routes[].handler`).

**Discovery is checked.** A folder that matches a manifest pattern but belongs to no
configured family fails audit.

**The two layers join.** A family block's file boundary is its resolved
`implementation.module` plus an optional `files` list. So typed blocks also take part in
`undeclared-link` and coverage.

**Module specifiers** in `implementation.module` are resolved with A's resolver, using the
home app's options, so any alias works.

**Loading TypeScript.** Contracts and manifests are loaded with Node's built-in type
stripping (Node 22.18+ and 24), plus a resolve hook backed by A's resolver. No `tsx`
dependency is needed. Contracts must use TypeScript syntax that can be stripped, and audit
names any file that doesn't.

### C.2 Codegen, check and history

- **`block-beaver gen`** writes every generated output. `gen --check` writes nothing and
  lists stale outputs. Audit runs it as the `family-drift` rule.
- **Built-in generators,** each used only when a family asks for it:
  - **`registry`** writes a typed, read-only registry module per family. It imports only
    `block-beaver/kernel` and that family's manifests, and its output path is set in
    config.
  - **`index`** writes `.blocks/index.json`, all manifests as JSON, for tools, agents and
    the map.
  - **`history`** appends to `.blocks/history.json`. An entry is added only when a
    manifest's hash changes. Dates are UTC. The label comes from `history.label` in the
    config or from `gen --label "…"`, never from parsing another document.
- **Custom generators** live in the repo and are referenced from a family or from config:

  ```ts
  export default defineGenerator({
    out: 'src/generated/endpoint-routes.ts',
    inputs: ['blocks/endpoints/*.ts'],
    generate: (ctx) => render(ctx.manifests('endpoint')),
  });
  ```

  - `ctx` gives read-only access to manifests by family, A's project graph, the config and
    the resolver.
  - `inputs` are real globs. Their hashes are cached in `.blocks/cache/` (gitignored), and
    a generator whose inputs haven't changed is skipped.
  - Every output starts with a "generated by block-beaver from …, do not edit" header, and
    the scanner marks those files as generated.
  - Generators run in a fixed order. Two generators that claim the same output file is an
    error.

### C.3 Runtime kernel, kit, map floors, lint and tests

**`block-beaver/kernel`** is the only Block Beaver runtime code an app ships. It contains:
- the schema DSL (`s.*`), which serialises to JSON;
- `validate` (strict) and `coerce` (lenient: applies defaults and keeps unknown keys);
- `createRegistry` and `compose(static, dynamic)`, which never let one block shadow
  another;
- `validateManifest(m, { mode: 'build' | 'runtime' })`. Runtime mode rejects
  `kind: 'module'`, so blocks created at run time can never name executable code.

It has no dependencies, no I/O and no framework code. It is tree-shakable, carries a size
budget checked in Block Beaver's CI, and shares its version number with the CLI.

**The kit** (`block-beaver kit <command>`) takes JSON in and gives JSON out, for agents and
scripts. Commands:
- `list`
- `describe <family>`
- `validate`
- `compose`
- `create <family> <id>`, which writes a manifest from the family's `scaffold` template
  and then runs `gen`.

**Map floors.** When families are configured, the view adds an isometric map:
- one floor per family, in config order, using each family's `map` text;
- links coloured by kind;
- grey slabs for ordinary code, grouped by app and folder using A's ownership;
- a history slider.

The default look is Block Beaver's own. A repo can supply a **skin**:
`"map": { "skin": "path/to/skin.css", "tokens": { … } }`. The map hard-codes no titles or
fonts, and its browser-storage keys use the repo's name.

**Lint** (`block-beaver/eslint`, opt-in):
- `no-block-id-literal` flags a family's ids written as plain strings outside generated or
  allowed files.
- Its allowed counts sit in `.blocks/baseline.json` and can only go down.

**Tests:**
- fixtures with zero, one and several families;
- custom generators: caching, ordering and output collisions;
- `--check` catching drift;
- history appending and replaying, with UTC dates;
- runtime mode refusing `module`;
- the JSON round trip refusing functions;
- the kernel size budget;
- **a domain guard test** that fails if Block Beaver's source contains the
  proof-of-concept repo's family names, fields or paths. The denylist lives in a test
  fixture.

**Adoption check.** An existing repo with a hand-built family system must be able to move
onto C with its manifests unchanged and with generated registries semantically equal to
before. Each adopting repo designs that move in its own repository.

**Removed when C ships:** the special-case registry adapter in `src/adapter.mjs`. Every
repo, including the proof of concept, declares its families through config.

---

## E: direction for later versions (theory, not a design)

**Rules for everything in E:**
- It is built only from what A–C provide: the project graph and its apps; blocks with file
  boundaries and declared links; the versioned config and its migrations; audit rule ids;
  and the propose → check in a worktree → approve workflow.
- Each feature ships as an **opt-in minor release**. Its config key arrives through
  `upgrade` switched off, and a repo turns it on.
- Each item gets its own design when it is pulled in.

**E1 · Scopes for agents and models ("block leases").**
- A scope names the blocks an agent may write and the blocks it may read, for example
  `{ "id": "lane-payments", "write": ["block:service:payments*"], "read": ["*"] }`.
- An orchestrator starts each agent in its own worktree with
  `BLOCK_BEAVER_SCOPE=<id>`. In `block` mode, `hook-check` denies writes outside that
  lease, and audit checks that the branch stayed inside it.
- Scopes can be tied to a model, for example "small models may only touch test blocks".
- This is the mechanism for parallel agent lanes enforced by tooling.

**E2 · Visual editing from the map.** The map becomes a way to *create proposals*, never a
way to edit directly. From the map you can:
- draw a link, which proposes a new dependency;
- drag files into a block;
- create a block from a scaffold;
- bump a block's version.

Each action produces the same proposal JSON as the existing workflow, and that proposal
then goes through check and approve.

**E3 · CI split by block.**
- `block-beaver affected --base <sha>` lists the blocks touched plus every block that
  depends on them. CI turns that list into a job matrix that runs each affected block's
  `verification` commands.
- Blocks with tags (for example `tags: ["security"]`) trigger heavier suites only when they
  are touched: security, end-to-end, bundle.
- A full nightly run stays as the safety net, so splitting never reduces what gets tested.

**E4 · MCP server.** The kit and graph queries ("owner", "depends on", "used by",
"affected") available to any agent over MCP.

**E5 · Ecosystem.**
- Shareable family packs (`@block-beaver/family-*`). They are always installed by choice
  and never bundled.
- Languages beyond JS/TS through the existing scanner plugin interface.

## Order and gates

1. **A:** project model, resolver, multi-app view. Release `0.2.0`. It changes the graph
   format, which is why it is a minor release.
2. **B:** npm publishing, install, upgrade, skill, hooks and audit. Release `0.3.0`.
3. **C:** families, codegen, kernel, kit and map floors. Release `0.4.0`.

Each sub-project must pass its own tests, `npm run check`, the CI matrix and the
live-editor release gate (from B onwards) before release. No time estimates are recorded
here.
