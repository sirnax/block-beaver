# Block Beaver 0.8.0 plan: fix what the finished adoption exposed (#47–#56)

## Context

0.7.0 finished adopting an existing family system (4 apps, 6 families, 174 manifests). Ten issues are open:

- **#47–#53, #55:** problems that adoption exposed.
- **#54:** the tracking issue for those.
- **#56:** a newer install bug found in TeaCake.

The goal is to fix all of them and release **0.8.0**:
- commit and push;
- merge the release PR to `main`;
- tag `v0.8.0` (the tag workflow creates the GitHub release);
- hand the user one `npm publish <tgz> --access public` command.

0.8.0 is a minor release because it adds kernel APIs, contract keys, config keys and CLI flags.

**Release rules (from #54):**
- Every issue gets a fixture that passes and one that fails.
- Projects that don't use the new keys keep identical graph and output bytes. The exceptions are listed under Compatibility below.
- `upgrade` from 0.7.0 rewrites only managed regions.
- #55 goes first.

**Starting point:** branch `release/0.8.0` (at `41aac5a`, pushed, clean) is cut from `main` and already carries the CLAUDE.md / sonnet-high chore commits.

## Working method

- Each slice is built in its own worktree on `feat/0.8.0-<slug>`, cut from the current `release/0.8.0` head.
- Well-scoped slices go to the `sonnet-high` sub-agent (`.claude/agents/sonnet-high.md`), each with a stated file boundary and acceptance tests.
- I'm the single integration owner. I merge each slice into `release/0.8.0` after review and `npm run check`, and resolve conflicts in the shared files: `src/cli.mjs`, `src/kernel/index.d.ts`, `src/families/config.mjs`, `src/families/load-worker.mjs`, README and CHANGELOG.
- I record the plan as `docs/tasks/2026-10-03-block-beaver-0.8.0-plan.md` (purpose / boundary / connections / acceptance per slice, in the 0.7.0 format) before editing.

## Slices

### Wave 1 (parallel; file sets don't overlap)

**K: runtime-safe kernel (#55 items 1, 2, 3 and 5)**
- **Files:**
  - `src/kernel/{registry,schema,manifest,index}.mjs`
  - `src/kernel/index.d.ts`
  - `tests/kernel.test.mjs` and `tests/kernel-types.test.mjs`
  - README "runtime kernel" and "Data-only kinds" sections
- **What changes:**
  - `createRegistry(family, manifests, { order: 'input' })` keeps the input order. The default still sorts, and the README now says so.
  - New `composeSafe(base, dynamic, { family, order })` returns `{ registry, rejected: [{ index, id?, errors }] }`. It never throws for invalid or duplicate dynamic manifests: a duplicate is rejected with `duplicate-id`.
  - New `read(schema, value)` returns `{ value, repairs: [{ path, code, message }] }` and never fails:
    - applies defaults, including nested defaults under missing parents;
    - keeps unknown keys;
    - replaces a wrong-typed field with its default, or drops it;
    - for `null` or non-JSON root input, returns the schema default or `{}` / `null`.
  - `coerce` and `validate` stay exactly as they are.
- **#55 item 5:**
  - In `validateManifest` (`src/kernel/manifest.mjs`, after line 29): when the kind is a data kind, an `unknown-key` under `$.implementation.` gets a message naming `implementationFields.<kind>`.
  - The README shows the `dataKinds` + `implementationFields` pair together.
- **Constraints:**
  - Stay under the 6 KiB gzip budget (`scripts/kernel-budget.mjs`; 4738/6144 now).
  - A registry-only import must not pull in the schema module. The bundler test at `tests/kernel.test.mjs:34` keeps passing, so `order` is handled inside `registry.mjs`, and `composeSafe` lives beside `compose`.

**S: scan file set (#49, #48, plus import records for #55 item 4)**
- **Files:**
  - `src/scanner.mjs`, `src/project-model.mjs` (`inventory`), `src/families/glob.mjs` (`discoverFiles`), `src/plugins/js-ts-react.mjs`
  - a small git listing helper (reusing `git()` from `src/compliance-git.mjs`)
  - `tests/scanner.test.mjs` and the multi-app scanner tests
- **#49 (gitignored files):**
  - Inside a git work tree, working-tree scans take their candidate set from `git ls-files -z --cached --others --exclude-standard`, intersected with the existing walk rules (skip set, dot-directories, `maxFiles`).
  - Config `ignore` and `!` re-includes still apply on top.
  - Outside git, including the staged-audit temp snapshot, the plain walk is used as today.
  - The same file set feeds `discoverFiles` and `inventory`, so working-tree and staged graphs match.
- **#48 (view exports):**
  - The scanner keeps a non-enumerable `excludedKnown` set: registered view exports (`.blocks/view-exports.json`) plus files present on disk but gitignored.
  - It passes the set into the plugin context. An import that resolves into the set gets no `resolutionReport` entry and no edge.
  - Files excluded by config `ignore` keep today's behaviour.
- **#55 item 4 support:**
  - Record, per file, the external package imports, keeping the subpath, the line and whether the import is type-only.
  - They go in a non-enumerable `graph.packageImports` (like `sourceText`), so `graph.json` bytes don't change.

**U: map skin, page text and view types (#52)**
- **Files:**
  - `src/families/map-render.mjs` (`FAMILY_MAP_CSS`, rail)
  - `src/block-map.mjs` (page CSS and page text)
  - `view.*` and `map.railLimit` in `src/families/config.mjs`
  - `src/view.d.ts` (new) and `package.json` `./view` exports
  - `tests/view-types.test.mjs` (new, copied from the kernel-types pattern), `tests/block-map.test.mjs`, `tests/family-map.test.mjs`
- **Changes:**
  - New tokens `--bb-control-surface`, `--bb-control-border`, `--bb-control-text` and `--bb-panel-surface`, with today's colours as fallbacks. They replace the literal colours in the zoom, history, evidence and skins controls and in the page's `input` / `select`.
  - `font-variant-ligatures: none` on map text.
  - New config keys `view.title`, `view.eyebrow`, `view.heading` and `view.intro`: plain text, HTML-escaped.
  - New `map.railLimit`, default 20. Rows beyond the limit sit in a `<details>` "Show all N folders", which needs no script under the CSP.
  - A `view.d.ts` covering `prepareView`, `VIEW_NONCE_PLACEHOLDER` and `VIEW_HOST_HEADER_SLOT`.

**G: gen output (#53)**
- **Files:**
  - the `gen` branch of `src/cli.mjs`
  - a `formatGenSummary` beside `src/audit-format.mjs`, reusing `clean` and `line`
  - `src/families/generate.mjs` (where adopt computes `bodyIdentical`, lines 53–60)
  - README upgrade section
  - tests mirroring `tests/audit-format.test.mjs` and the adoption tests
- **Changes:**
  - `gen` and `gen --check` accept `--format json|summary`. A pass prints one line. A failure prints one line per drifting or conflicting output, then exits 2.
  - Adopt reports both `bodyIdentical` (strict, unchanged) and `bodyIdenticalIgnoringLeadingComment`, which strips one leading comment block from each side.
  - The README gets a pnpm `minimumReleaseAge` upgrade note.

**I: narrowing `--agents` (#56)**
- **Files:**
  - `src/install.mjs` (`agentsFor`, `execute`)
  - `src/managed-files.mjs` (`nextHooks` pruning)
  - the install branch of `src/cli.mjs`
  - `tests/install.test.mjs` and `tests/uninstall.test.mjs`
- **Removing the dropped agent's files:**
  - When the explicit `--agents` list drops agents recorded in `.blocks/install.json`, `install` also plans `planManagedFiles({ agents: dropped, operation: 'uninstall' })` and the host uninstall for those agents, merged through `combine()`.
  - An edited managed section or hook is a conflict, and nothing is written. That follows the existing rule: conflicts stop the run unless `--force`.
- **Updating the records:**
  - `install.json` `paths` is recomputed instead of only ever growing.
  - `managed-files.json` `hooks` drops entries for removed agents.
  - Folders left empty are removed.
- **Reporting:**
  - The output gains `removed: [...]`.
  - Unmanaged files left inside a dropped agent's folders (for example `.codex/agents/*.toml`) are listed as `unmanaged-left` advisories and never deleted.
  - `--dry-run` shows the removals. `--check` is a new alias that exits 2 when anything would change.

### Wave 2 (after wave 1 merges)

**M: map reach (#47)**
- **Files:**
  - `src/families/graph.mjs` (`attachMapParity`, `bindingCalls`)
  - contract `map` validation in `src/families/load-worker.mjs`
  - `map.bindings` validation in `src/families/config.mjs`
  - `index.d.ts`
  - `tests/family-map.test.mjs` and `tests/map-parity-data.test.mjs`
- **Changes:**
  - New contract key `map.unused: false`: the family is never flagged unused.
  - New contract key `map.reach: 'registry'`: if any ordinary, non-generated file imports the family's `registry.out`, every block counts as reached, with `codeReach` evidence pointing at the importer.
  - New binding form `argKey`: `{ family, call, argKey }` matches `call({ [argKey]: 'literal' })`. A non-literal argument adds nothing and reports no error.
  - Defaults don't change, so graphs without these keys keep identical bytes.

**R: runtime dependency (#55 item 4)**
- **Files:**
  - `src/package-manager.mjs` (`planPackageChange`, `lockMatches`)
  - `src/install.mjs` (the check after the package-manager command)
  - `src/compliance.mjs` (`managed-current` and the new advisory)
  - `src/audit-rules.mjs`
  - `--runtime` added to the CLI's boolean `flags` set
  - `tests/package-manager.test.mjs`, `tests/audit-rules.test.mjs`, `tests/install.test.mjs`
- **Changes:**
  - `install --runtime` pins `block-beaver` exactly under `dependencies`.
  - `upgrade` keeps whichever placement already exists.
  - `managed-current` accepts either placement.
  - New warning advisory `runtime-import-dev-dependency` (the audit still passes):
    - it fires when a non-test file imports `block-beaver/kernel` or `block-beaver/view` at runtime, using S's `graph.packageImports`, while the package is a devDependency;
    - non-test files include generated registries, and type-only imports are excluded;
    - test files are identified by a new helper: `test`, `tests`, `__tests__` or `fixtures` folders, and `*.test.*` / `*.spec.*` names;
    - it lists the importing files and suggests `install --runtime` (or, if the app bundles it, that the warning can be ignored).

**A: agent guidance for families (#50)**
- **Files:**
  - `src/install-templates.mjs` (adds a rendered families section and keeps the previous bodies as legacy text)
  - `templates/block-workflow.md`, `templates/agent-skill/**`
  - `src/managed-files.mjs` (passes `config.families` into rendering)
  - `src/project-integration.mjs`
  - `managed-current` in `src/compliance.mjs`
  - the `update` branch of `src/cli.mjs`
  - `tests/install-templates.test.mjs` and `tests/upgrade.test.mjs`
- **When `families` is configured,** AGENTS.md, CLAUDE.md, the skill and WORKFLOW.md render a families section from config. It contains:
  - a table of each family's id, glob and contract;
  - "add a block = add one manifest; links are fields";
  - "run `block-beaver gen`, not only `update`";
  - "never hand-edit `gen` outputs";
  - the `kit` commands, with `kit create` only for families that have a scaffold;
  - a note that manifests are reviewed in the PR when `enforcement.receipts` is `optional` or `off`.
- **Without families,** the bytes are unchanged.
- **After a families config change,** `managed-current` reports a warning advisory ("run `block-beaver upgrade`") instead of failing the audit.
- **`update`** prints a "run block-beaver gen" hint when family outputs are stale. It reuses the read-only `planGeneration` / `checkGeneration` drift check from `compliance.mjs:401-414`, gated on `familyEnabled`.
- This slice changes managed guidance bytes, so the live editor gate is mandatory.

**C: computed scaffolds (#51)**
- **Files:**
  - `src/families/load-worker.mjs` (strips `scaffold.plan` like `check`, plus a new `message.scaffold` mode)
  - `src/families/loader.mjs` (passes the message through, no memo)
  - `src/families/scaffold.mjs`, `src/families/kit.mjs`
  - the `kit create` flags in `src/cli.mjs`
  - `index.d.ts`
  - `tests/family-kit.test.mjs` and `tests/kit-cli.test.mjs`
- **Merge order:** C merges after M, because both edit `load-worker.mjs` and `index.d.ts`.
- **`scaffold.plan`:**
  - Contracts get an optional `scaffold.plan(input, { all, entries, readFile })`.
  - It returns `{ files, updates: [{ path, content, before: 'sha256:…' }], manualSteps }`.
  - It runs in the load worker. `readFile` is guarded by `assertSafeSource`.
  - Static `files` templates keep working.
- **`kit create`:**
  - New flag `--input <json>` (or `--input-file`).
  - The planned manifest is validated against the family and its `check` before anything is written.
  - `--dry-run` shows creates and update diffs.
  - An update is refused if the file's hash no longer matches `before`.
  - Apply becomes truly all-or-nothing: if `gen` or reload fails, it restores updated files and deletes created ones. Today the scaffold files are left behind.

### Wave 3: integration and release
1. **Adoption fixture** (`tests/adoption.test.mjs`): extend it with registry reach, an `argKey` binding, a gitignored build file, an import of a view export under `audit --strict`, `gen --check --format summary`, a computed scaffold, and narrowing `--agents`.
2. **Compatibility check:** a test that a 0.7.0-shaped project with no new keys keeps identical `graph.json` and generated output bytes.
3. **Release candidate files:**
   - `package.json` and `package-lock.json` → `0.8.0`;
   - a `CHANGELOG.md` `## 0.8.0 — <date>` entry with Compatibility notes and `(#NN)` per change;
   - README, `cli.mjs` help text and `templates/block-workflow.md` updates;
   - `node scripts/release-notes.mjs v0.8.0 <scratch>/notes.md` must succeed.

## Compatibility notes (for the changelog)

- **Map views change bytes.** This comes from the #52 CSS tokens, ligatures, `<details>` rail and a default `railLimit` of 20. Re-export registered view modules (`view --format module`, or `gen`) and commit them.
- **Working-tree scans honour `.gitignore`** (#49). Graphs may lose gitignored files, and `ignore` entries added only as a workaround can be removed.
- **`upgrade` rewrites managed guidance only where families are configured** (#50).
- **`graph.json` stays at schema 2.** `coerce` and `compose` behave as before.

## Verification

- **Each slice:** focused `node --test tests/<file>.test.mjs`, then `npm run check` after each merge into `release/0.8.0`. That run covers the kernel budget and every test.
- **Packed tarball:** `npm pack` into the scratchpad, then install it into a disposable git repo and walk through:
  - `install --agents claude,codex`, then `install --agents claude`, with `--dry-run` first: codex files are removed, and an edited file conflicts;
  - `install --runtime`;
  - `audit` shows the runtime-import warning;
  - `gen --check --format summary` prints one line;
  - a gitignored build file followed by `audit --staged` passes;
  - a view-export import under `audit --strict` passes;
  - a computed `kit create` with `--dry-run`, then apply;
  - upgrade from 0.7.0 (install `block-beaver@0.7.0` from npm first) rewrites only managed regions;
  - `node -e` against `block-beaver/kernel` reproduces each #55 scenario: `composeSafe` with one bad manifest, `read` with wrong-typed fields, `order: 'input'`.
- **Browser check:** a dark skin on the exported map view under the strict nonce CSP. No white controls, "files" renders correctly, the custom title shows and there are no console violations. Uses Playwright MCP.
- **Live editor gate:** `node scripts/live-editor-battle.mjs claude {normal,bypass,failed,drift}`, all four passing on one candidate fingerprint, recorded in the task doc.
- **CI:** PR `release/0.8.0` → `main` with `Fixes #47` … `Fixes #56`. The full matrix must be green: Linux Node 22.18.0/22/24/26, macOS and Windows on 24, CodeQL and Gitleaks.

## Release sequence (per `docs/RELEASING.md` and the saved handoff preference)
1. Push `release/0.8.0` and open the release PR. Wait for green CI, then merge into `main`. The `Fixes` lines close #47–#56 on merge.
2. From merged `main`:
   - `npm pack --pack-destination <scratchpad>/release`
   - `npm publish <tgz> --dry-run --access public`
   - confirm the version and file list.
3. Hand the user: `npm whoami` (a sanity check), then exactly **`npm publish <scratchpad>/release/block-beaver-0.8.0.tgz --access public`**.
4. After the user confirms the publish:
   - check that `npm view block-beaver@0.8.0 dist.integrity` matches the tarball;
   - create and push an annotated `v0.8.0` tag at the merged release commit (`release.yml` creates the GitHub release);
   - verify the release and a fresh `npx block-beaver@0.8.0` install;
   - close any issue that is still open;
   - open a small docs PR recording the completed publication, as for 0.7.0.

## Release gate record

**Candidate.** `release/0.8.0` at `d914ab4` (PR #57). Every slice was built in a worktree on `feat/0.8.0-<slug>` by a Sonnet worker and reviewed and merged by the integration owner. The `sonnet-high` agent type was not loaded in the session, so workers ran as general-purpose agents on Sonnet with the same worker rules.

**Integration changes made during review**
- **U (#52):** config `view.*` and `map.railLimit` validated but never reached the renderer. `attachProjectRegistry` now passes them through, but only when they are set, so other graphs keep their bytes.
- **R (#55):** contracts and generators were skipped by guessing from filenames, which breaks when config puts them elsewhere. The check now uses the graph's `familyRole`.

**Checks**
- **Full check:** `BLOCK_BEAVER_REQUIRE_ESBUILD=1 npm run check` passed 618/618 tests on the commit before the last CodeQL fix. After that fix, `tests/kit-cli.test.mjs` passed 10/10, and CI covers the full matrix. Kernel gzip is 5545/6144. `node scripts/release-notes.mjs v0.8.0` passes.
- **Packed tarball:** packed from the candidate and installed into disposable git repositories. The exact `0.8.0` pin is simulated in the lockfile because the version is not on the registry yet. All 16 smoke checks pass:
  - `install --agents claude,codex`, then `--check` exits 2 before narrowing;
  - `--dry-run` lists `removed` and writes nothing;
  - narrowing to `claude` removes `.agents/` and `.codex/` and keeps owner text in `AGENTS.md`;
  - `--check` exits 0 afterwards;
  - the `runtime-import-dev-dependency` warning names `src/app/reg.ts:1` but not a type-only import or a test file;
  - a gitignored `out/bundle.ts` is absent from the scan and from `graph.json`;
  - staged and strict audits fail only with the expected `coverage-ratchet` for the deliberately undeclared smoke files;
  - an import of a view export raises no resolution finding;
  - `install --runtime` plans `npm install --save-prod --save-exact block-beaver@0.8.0`.
- **Upgrade from the published 0.7.0:** `upgrade` changes only the managed hash and version stamps in 14 files, and `audit` then passes.
- **Browser check:** Chromium, through `block-beaver start` under the strict nonce CSP, with dark `map.tokens` on a family project with 26 folders, a rail limit of 5 and custom page text:
  - no element has a computed white background;
  - the custom title, eyebrow, heading and escaped intro render;
  - "Show all 26 folders" expands;
  - ligatures are off;
  - the console has no errors or warnings.
- **Live editor gate:** `node scripts/live-editor-battle.mjs claude normal|bypass|failed|drift` all pass on head `d914ab4`, source fingerprint `7276becb6367d352cb791cb76197d4d976ce8664bd4a4954bfd2978fc82d9b7e`. The gate ran from a frozen worktree with Sonnet 5.5 at high effort.

**Findings fixed before release**
- **#56:** after narrowing `--agents`, Block Beaver's own setup exception still named the deleted files, so `exception-valid` failed the next audit. Narrowing now removes those paths from Block Beaver setup exceptions, and deletes an exception left with none.
- **#52:** under a dark skin, the page's block cards and resolution report stayed white. They now use `--bb-panel-surface` and `--bb-control-border`, and a test rejects any literal white background.
- **#51:** CodeQL `js/file-system-race` fired on `kit create --input-file`, which checked the size and then read the file separately. It now reads through one file handle.
- **Gate re-runs:** an earlier gate run was blocked because the source changed during the run (`candidate-source-stable`). The final runs use a frozen worktree.

**Known limits**
- Git-aware scanning needs at least one tracked file. A fresh `git init` with nothing tracked uses the plain walk, which is the staged-audit snapshot's behaviour.
- A failed `kit create` rollback removes the files it created but can leave the empty directories made for them.
- `runtime-import-dev-dependency` reads the root `package.json`. The project model has no mapping from a file to its nearest `package.json`.
- The overflow folders in the rail are plain list items, with no reach lines.
