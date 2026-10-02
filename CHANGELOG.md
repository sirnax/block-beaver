# Changelog

All notable user visible changes are recorded here. Releases follow semantic versioning. Before 1.0, behavior and graph contracts may change between minor versions.

## Unreleased

- No additional changes recorded.

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
