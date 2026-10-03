# Changelog

All notable user visible changes are recorded here. Releases follow semantic versioning. Before 1.0, behavior and graph contracts may change between minor versions.

## Unreleased

- No additional changes recorded.

## 0.8.0 — 2026-10-03

0.8.0 fixes what finishing the adoption of an existing family system exposed:
- the runtime kernel can no longer take a live app down;
- the map no longer marks registry-consumed blocks unused;
- scans honour `.gitignore`;
- agent guidance knows about families;
- `kit create` can replace a project scaffolder;
- a narrower `--agents` install cleans up after itself.

Upgrading from 0.7.0 is `block-beaver upgrade`. See the [0.8.0 plan](docs/tasks/2026-10-03-block-beaver-0.8.0-plan.md).

**Compatibility notes**

- **Map views change bytes.** The map controls use new colour tokens, map text turns ligatures off, and the folder rail shows 20 rows by default. Re-export any registered view module (`view --format module`, or `gen`) and commit the result.
  - The tokens are `--bb-control-surface`, `--bb-control-border`, `--bb-control-text`, `--bb-control-hover` and `--bb-panel-surface`. Each falls back to the previous colour.
  - Rows beyond the rail limit sit behind a `<details>` "Show all N folders".
- **Working-tree scans honour `.gitignore`.**
  - Inside a Git work tree, scans read tracked files plus untracked files that are not ignored. Gitignored files leave the graph, so working-tree and staged audits agree.
  - Config `ignore` entries added only to hide build output can be removed.
  - Outside Git, the scan walks the directory as before.
  - The `maxFiles` limit now counts only the files that are kept.
- **Fewer unresolved imports.** Imports that resolve to a registered view export or a gitignored file are no longer reported as unresolved. Resolution counts can therefore drop, and `upgrade` may lower `.blocks/baseline.json`.
- **Managed guidance changes only where families are configured.**
  - Projects with `families` get a "Typed families" section inside the managed regions of the agent instructions, `WORKFLOW.md` and the agent skill. `upgrade` rewrites those regions once.
  - Without `families`, every managed byte is unchanged.
  - Until `upgrade` runs after a families config change, `audit` reports the `managed-families-stale` warning instead of failing.
- **Either dependency placement is current.** `managed-current` accepts the exact `block-beaver` pin in `dependencies` or `devDependencies`. A plain `install` still pins it as a devDependency.
- **New audit warning.** `runtime-import-dev-dependency` appears when non-test code imports `block-beaver`, `block-beaver/kernel` or `block-beaver/view` at runtime while the package is only a devDependency. Generated registries count as non-test code.
  - The audit still passes.
  - `audit --format summary` adds ", 1 warning" to its pass line.
- **Narrower `--agents` removes files.** An explicit `--agents` list that drops a recorded agent now removes that agent's managed files and hook entries. An edited managed section is a conflict, as for `uninstall`. Auto-detection never removes anything.
- **`kit create` is all-or-nothing.** If `gen` or the reload fails after scaffolding, every created file is deleted and every updated file restored. Before, the scaffold files were left behind. The CLI exits 2 instead of 1.
- **Graph schema and kernel.**
  - `graph.json` stays at schema 2.
  - `codeReach` entries gain `evidence` only for the new `via: 'registry'`.
  - `coerce`, `validate`, `compose` and `createRegistry` behave as before by default.
- **New codes.** `managed-families-stale`, `runtime-import-dev-dependency`, `unmanaged-left`, `scaffold-plan-failed`, `scaffold-stale` and `scaffold-update-missing`.

**Changes**

- Contract `map.reach: 'registry'` counts every block of a family as reached when an ordinary, non-generated file imports its `registry.out`. Those `codeReach` entries carry import evidence. Contract `map.unused: false` keeps a family's blocks off the unused list. A `map.bindings` entry `{ family, call, argKey }` matches `call({ argKey: 'id' })`. (#47)
- Imports of a registered view export, or of a gitignored file, no longer count as unresolved, so they no longer raise the resolution ratchet. (#48)
- Working-tree scans, family file discovery and the project inventory read the same Git file set, so gitignored build output no longer makes the staged audit call the view stale. (#49)
- Agent guidance knows about families.
  - With `families` configured, the managed agent instructions, `WORKFLOW.md` and skill gain a section with:
    - a table of families;
    - "add a block = add one manifest";
    - `block-beaver gen` (not only `update`) and a warning never to hand-edit generated outputs;
    - the `kit` commands;
    - a PR-review note when receipts are optional.
  - `update` adds a `hint` when family outputs are stale.
  
  (#50)
- `kit create` can replace a project scaffolder.
  - Contracts may define `scaffold.plan(input, { all, entries, readFile, id, family })`, which returns created files, `updates` to existing files (each guarded by a `before` sha256) and `manualSteps`.
  - `kit create` takes `--input JSON` or `--input-file PATH` and validates the planned manifest against the family schema and its `check` before writing.
  - `--dry-run` shows creates and update diffs.
  
  (#51)
- The family map gets control and panel colour tokens, turns ligatures off (the broken "fi"), and adds a `map.railLimit` (default 20) with the remaining folders behind `<details>`.
  - Config `view.title`, `view.eyebrow`, `view.heading` and `view.intro` set the page text.
  - `block-beaver/view` ships TypeScript types.
  
  (#52)
- `gen` and `gen --check` take `--format summary`, which prints one line on success and one line per failing output otherwise. Adopted outputs also report `bodyIdenticalIgnoringLeadingComment`. The README notes how pnpm's `minimumReleaseAge` interacts with upgrading. (#53)
- Tracking issue for the 0.8.0 goal. (#54)
- The runtime kernel is safe to use in a live app.
  - `composeSafe(base, dynamic, { family, order })` returns `{ registry, rejected }` instead of throwing on an invalid or duplicate dynamic manifest.
  - `read(schema, value)` always returns a value plus a list of `repairs`.
  - `createRegistry(family, manifests, { order: 'input' })` keeps input order.
  - An unknown `implementation` key on a data kind now names `implementationFields.<kind>`.
  - `install --runtime` pins `block-beaver` under `dependencies`, and `upgrade` keeps the existing placement.
  
  (#55)
- `install --agents` with a narrower list removes the dropped agents' managed files and hooks. It reports `removed`, and `unmanaged-left` warnings for files it leaves. `install --check` exits 2 when anything would change. (#56)

## 0.7.0 — 2026-10-02

0.7.0 takes the next steps in adopting an existing family system: join links, per-family grouping, generator entries, taking over existing outputs, region outputs, history label modules, a map-only view export, and a one-line audit output for hooks and CI. Upgrading from 0.6.x is `block-beaver upgrade`. See the [0.7.0 plan](docs/tasks/2026-10-02-block-beaver-0.7.0-plan.md).

**Compatibility notes**

- **Hook and CI bytes change.** The managed pre-commit runs `audit --staged --format summary --root .`, lefthook does the same, and the managed GitHub and GitLab CI jobs run `audit --base merge-base --strict --format summary`. `upgrade` rewrites these hash-verified managed regions once, with no conflict; hand-edited regions still conflict. Besides the version stamps, `upgrade` also rewrites the managed `WORKFLOW.md` and the agent skill reference, which gain paragraphs on the one-line audit output, `gen --adopt` and restoring imported outputs.
- **Other new keys are optional.** The new keys are link `match`, contract `map.group`, generator `region`, config `history.label` as `{ module }` and config `view.detail`. Leaving them out keeps 0.6.0 output bytes identical.
- **Graph schema.** `graph.json` stays at schema 2.
- **New codes.** `output-required-for-load`, `adopt-not-claimed`, `region-missing`, `region-duplicate`, `history-label-invalid` and `view-too-large`. `output-required-for-load` replaces `unresolved-import` when the missing file is a known claimed output, and the `output-conflict` message now mentions `gen --adopt`.
- **`gen` arguments.** `gen` with stray positional arguments now fails with a usage error. Only `--adopt` takes paths.
- **View exports registry.** `.blocks/view-exports.json` entries may carry `detail`. It is written only when the detail is not `full`, so existing entries keep their bytes.
- **Generator cache.** A generator's cache context now includes each manifest's path and export name, and the cache records each generator's `out`. Every cached generator therefore re-runs once after upgrading.

- **The family map is redrawn.** Blocks are isometric bricks on floor plates in an exploded tower, as in the original design, instead of flat tiles. The `data-*` hooks, element ids, the `map.skins` toggle and `graph.json` are unchanged, but the rendered map, the console view and exported view modules all change their bytes. Re-export any registered view module with `view --format module`, or run `gen`, and commit the result. Skin CSS that targeted `.family-block-slab` or the old `Ordinary code` slabs needs updating to the brick classes.

**Changes**

- The family map draws Lego-style bricks in an exploded tower with floor tags, link-count risers, a rail of ordinary code, per-family colours (`family-<id>` tokens), zoom, fit, pan and a history Play button. (#30)
- Links can join on values: `{ field, to, match, kind }` adds an edge to every manifest of the target family whose `match` path shares a primitive value with the source field. The edges are ordinary link edges. (#36)
- A contract's `map.group` groups blocks on the map by a field with a joiner, an `empty` fallback and a `{value}` format. It takes precedence over config `map.groupBy`. (#37)
- `gen --adopt [PATH…]` takes over existing outputs that have no Block Beaver header, reports `status: "adopted"` and `bodyIdentical`, and works with `--dry-run`. Loading fails with `output-required-for-load` when a contract or check imports a deleted generated output; restore it with `git restore` instead of deleting it. (#38)
- A generator with `region` owns the text between marker lines in a file and leaves the rest untouched. Missing or duplicate markers write nothing. (#39)
- `history.label` can name a module that computes the label when an entry is appended. `--label` still overrides it. (#40)
- Generators get `ctx.entries(family?)`, read-only `{ ref, family, id, path, exportName, hash, value }` records in `ctx.manifests` order. (#41)
- `view --format module --detail map` embeds only what the family map draws, about 4% of the full size on a 174-block, 1800-file synthetic graph. `--max-bytes N` fails with `view-too-large`, and `view.detail` sets the default for new exports. (#42)
- `audit --format summary` prints one line on a pass, and a short list of errors with their fixes on a failure. The managed hooks and CI use it. (#43)
- Tracking issue for the 0.7.0 adoption goal. (#44)

## 0.6.0 — 2026-10-02

0.6.0 lets a project with its own hand-built typed block system move onto Block Beaver families. Manifest data stays unchanged, JSON outputs stay byte-identical, and no map features are lost. Upgrading from 0.5.x is `block-beaver upgrade`. See the [0.6.0 plan](docs/tasks/2026-10-02-block-beaver-0.6.0-plan.md).

**Compatibility notes**

- **New config keys are optional.** The new keys are `checks`, per-family `exclude`, `map.floors`, `map.groupBy`, `map.skins` and `map.bindings`. Leaving them out keeps 0.5.1 behaviour, and `upgrade` adds none of them.
- **Graph additions.** `graph.json` stays at schema 2. Family projects gain three additive fields: `codeReach`, `unused`, and `gone` on each history snapshot. Graphs of projects without families are unchanged.
- **New rule and code.**
  - The `family-valid` rule reports set-wide checks.
  - `gen` can now report `generator-unstable` under `family-drift`.
  - `family-unclaimed` strays under `fixtures`, `__fixtures__`, `test` or `tests` folders are now warnings, not errors.
- **Staged view checks.** Staged and range audits regenerate a gitignored, uncommitted view inside the snapshot instead of comparing the working copy. A committed view, and a working-tree `audit`, are still compared against the files on disk. Hook and CI bytes are unchanged.
- **`upgrade` changes.**
  - It may lower counts in `.blocks/baseline.json`; it never raises them.
  - The managed `WORKFLOW.md` and agent skill reference gain a paragraph on the staged view and on lowering the baseline, so `upgrade` rewrites those managed files.
- **Floor order direction.** `map.floors` lists floors top first, the order the map already draws `families`. This deliberately differs from the "bottom to top" wording in #29, to keep existing maps unchanged.
- **Kernel types.** `FamilyDefinition.implementation` is now `readonly string[]`, and `ManifestOf` derives implementation arms from the family. `check`, `checkAll` and generator callbacks keep their 0.5.1 parameter types. A family with `dataKinds` can annotate a callback parameter with the new `LoadedManifest` type to compare its data kinds.

**Changes**

- Families can add fields to implementation arms (`implementationFields`) and declare data-only kinds (`dataKinds`) that runtime mode accepts. Errors name the selected arm's field. (#27)
- `checkAll` on a family contract and config-level `checks` modules express whole-set and cross-family rules, reported under `family-valid` in `audit` and `gen --check`. (#28)
- `map.floors` sets the map floor order independently of the index, registry and `ctx.blocks()` order. (#29)
- The map shows which ordinary code reaches each block, through imports or `map.bindings` registry calls. It also marks unused blocks, keeps removed blocks as "gone" bricks in the history slider, groups blocks within a floor by `map.groupBy`, and offers several skins (`map.skins`) with a remembered toggle. (#30)
- `family-unclaimed` honours the config `ignore` list and per-family `exclude`, and `ignore` also keeps files from loading as manifests. (#31)
- `gen` repeats until outputs stop changing (at most three passes), so manifests that import generated outputs settle in one run. (#32)
- The managed pre-commit passes after a source edit without a manual `update`. The new `block-beaver baseline --lower` command, which `upgrade` also runs, records lower ratchet counts. (#26)

## 0.5.1 — 2026-10-01

Fixes from use of 0.5.0 (#21–#24). Upgrading from 0.5.0 is `block-beaver upgrade`. #21 can damage the host repository, so every 0.5.0 user who works in linked Git worktrees should upgrade.

**Recovery for #21:** if a commit in a linked worktree left every checkout reporting `fatal: this operation must be run in a work tree`, run `git config core.bare false` in the main repository.

**Compatibility notes**
- Managed Claude and Codex hooks now run `node node_modules/block-beaver/bin/block-beaver.mjs hook-check …` instead of a package-manager command. Yarn Plug'n'Play projects keep `yarn exec`. `upgrade` rewrites 0.5.0 hook entries, including installs without `.blocks/managed-files.json`. The path is relative, so editors must run hooks from the project root, as before; when they don't, the hook fails open.
- Git hook and CI commands are unchanged.

- Fix staged audits in linked worktrees: snapshot Git commands no longer inherit the hook's `GIT_DIR` and `GIT_INDEX_FILE`, which made `git init` rewrite the host repository with `core.bare = true` and aborted the commit (#21).
- Run managed agent hooks without package-manager startup, which took 0.5–0.9 s of the hooks' 1 s timeout under `pnpm exec` (#22).
- Editing `.blocks/config.json` after install no longer makes the managed setup exception stale. The edit follows the active receipts level: an advisory under `optional` and `off`, and evidence required under `required`. `config-valid` still checks its contents (#23).
- Managed paths that Git ignores, such as a fully ignored `.claude/`, are local-only in staged and range audits. They now produce an `ignored-managed-local` advisory instead of failing `managed-current` on every commit. The `ignored-target` install warning explains this and names `--fix-ignores` (#24).

## 0.5.0 — 2026-10-01

Fixes from the first real use of 0.4.0 (#14–#18). Upgrading from 0.4.0 is `block-beaver upgrade`.

**Compatibility notes**
- New installs write `enforcement.receipts: "optional"`. Configs without the key keep today's behavior, which is `required`. The stricter of the base revision's level and the audited tree's level applies, so one commit cannot loosen the gate and pass under its own new rules.
- Resolution report entries gain `category` (`module` or `asset`), and scan summaries and app health gain `missingAssets`. `unresolvedImports` is still the total, so `--strict` and the resolution ratchet behave as before.
- Managed CI now uses `actions/checkout@v7`, `actions/setup-node@v7` and the repository's Node version (`.nvmrc`, `.node-version`, `engines.node`, then 24). `upgrade` rewrites the managed CI region. Unmarked 0.1.x files are still adopted.

- Fix truncated piped JSON: every command now flushes stdout before exiting, so large `audit`, `install --dry-run` and other reports parse intact (#14).
- Make the managed CI job use the repository's Node version and current action majors, and warn (`ci-node-below-minimum`) when it is below 22 (#15).
- Resolve bare package asset imports such as `reactflow/dist/style.css` through `node_modules` and package `exports`; real misses are reported with the `asset` category and counted separately (#16).
- Record a managed-setup exception from `install` and `upgrade`, so a fresh install passes its own audit and the first commit goes through the pre-commit hook (#17).
- Add `enforcement.receipts` (`required`, `optional`, `off`) so a repository can adopt the structural gate before mandatory review receipts. Invalid evidence and review that went stale against the change in hand still fail under `optional`; under `off` the review requirement is skipped but invalid evidence still fails. Install and upgrade results report the active level (#18).
- Pin CodeQL `init` and `analyze` to the same 4.38.2 commit and group their Dependabot updates so they cannot drift apart again.

## 0.4.0 — 2026-10-01

Versions 0.2.0 and 0.3.0 were local development versions and were never published. The upgrade path from the previous GitHub release, 0.1.1, is directly to 0.4.0.

**Breaking changes:** the generated graph contract is now schema version 2, with app ownership and reachability data. The minimum supported Node.js version is 22.18.0; Node 24 and 26 are also supported. Consumers that read graph JSON or run Block Beaver on Node 22 before 22.18 must update.

- Add optional, project-defined typed families, TypeScript contract and manifest loading, family graph links and map floors; expose `block-beaver/kernel`, JSON kit commands, `gen --check`, history import, and the opt-in `block-beaver/eslint` rule. No domain family is bundled.
- Add multi-app detection and owner-controlled `.blocks/config.json`, compiler-based resolution, graph schema 2 ownership and reachability, cross-app links, app filters and health reports.
- Add `install`, `upgrade`, `uninstall` and `audit` workflows with managed editor instructions, native hooks, Git hooks, CI setup, versioned migrations, stable audit rules and configurable coverage, resolution and lint ratchets.
- Add strict scan diagnostics, incremental scanning, deterministic view module export with pure nonce/header helper, and generated maps with automatic refresh through `block-beaver start`; add `init` and `update` for setup and offline regeneration.
- Show declared local block dependencies as evidenced connections in the scanned graph and local Blocks view.
- Support explicitly scoped file creation in roadmaps and agent requests, with safe `op: "create"` patches alongside existing replacements.
- Preserve CRLF managed files and track workspace runtime dependencies through Windows junctions; bind reviewed filesystem permissions separately from portable Git receipt modes.
- Bind review and approval to the complete verified worktree snapshot, including declared generated files and the `.blocks` manifest; reject out-of-scope or post-check changes.
- Keep repair within the same implementation paths and patch operations while allowing content fixes.

## 0.1.1 — 2026-09-20

- Remove a separate file metadata check before reading local console assets, closing the file system race reported by CodeQL.

## 0.1.0 — 2026-09-20

- Add JS, TS, and React source scanning with evidence linked relationships.
- Add local browser graph explorer and read only previews.
- Add bounded roadmap proposals, checks in isolated worktrees, decisions, and event replay.
- Add agent protocol and authenticated local worker.
- Add the public project page, Apache-2.0 license, contributor and security guidance, CI, dependency audit, secret scanning, CodeQL, and tag based GitHub releases.
- Restrict local HTTP requests to loopback hosts and matching browser origins.
