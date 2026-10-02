# Block Beaver 0.6.0 plan: adopting an existing family system

Issues #26–#32 came from moving a real multi-app pnpm repository (4 apps, 6 families, 174 manifests) onto 0.5.1 typed families. Tracking issue #33 records the goal. Block Beaver goes 0.5.1 → **0.6.0**: a minor release with new optional configuration, and every new key keeps 0.5.1 behaviour when it is left out.

**Goal.** A project with a hand-built typed block system (manifests, codegen, a block map) can move its build-time engine onto Block Beaver families with:
- no manifest data changes;
- byte-identical JSON outputs;
- no lost map features;
- a pre-commit hook that passes without a manual `update`.

The project can then delete its own codegen, map and kit scripts.

## Owner decisions

- **Branching.** 0.6.0 is built on its own integration branch, `release/0.6.0`, cut from `main` at `965e22f`.
  - Each slice is built in an isolated worktree on `feat/0.6.0-<slug>` and merged into `release/0.6.0` after review and checks.
  - Nothing reaches `main` until a single release PR from `release/0.6.0`. That PR carries one `Fixes #NN` line per issue.
- **#26 is fixed in the audit, not the hook.** `view-fresh` regenerates a gitignored view inside the audit snapshot. The managed hook bytes don't change, so upgrades don't churn and pre-commit matches CI. #26 ships in 0.6.0, not as a separate 0.5.2.
- **#28 findings get a new rule id, `family-valid`.**
- **#31 fixture folders are warnings.** Strays under `fixtures/`, `__fixtures__/`, `test/` or `tests/` that no family claims are reported as warnings, not errors.
- **Compatibility.**
  - `graph.json` stays at schema 2. The new fields (`codeReach`, `unused`, `gone`) are additive and documented.
  - `upgrade` from 0.5.x adds no keys that change behaviour.
  - CHANGELOG gets a "Compatibility notes" section, as in 0.5.0 and 0.5.1.

**Workers and order.** Workers follow the roster in `AGENTS.md`, one owner per file.
1. Groundwork comes first.
2. Slices A–E then run in parallel.
3. F starts after C (both change floor handling).
4. G is independent but merges last, because it changes audit behaviour the live editor gate depends on.

## Block records

### 0 — Shared config groundwork
- **Purpose:** validate every new optional `.blocks/config.json` key in one place, so the parallel slices don't conflict.
- **Boundary:**
  - `src/families/config.mjs` (`parseFamiliesConfig`);
  - the gating key lists in `src/adapter.mjs` and `src/compliance.mjs`;
  - `tests/audit-rules.test.mjs`.
- **Connections:** the new keys are:
  - top-level `checks: [path]`;
  - per-family `exclude: [glob]`;
  - `map.floors`, `map.groupBy`, `map.skins: [{id, path, tokens}]`, `map.bindings: [{family, call, registry}]`.
  - `map.skin` keeps working.
- **Acceptance:**
  - Malformed new keys report `config-valid` with a field path.
  - A config without them produces exactly the 0.5.1 results.

### A — Extensible implementation arms (#27)
- **Purpose:** a family can add its own fields to an implementation arm (for example `export` and `loading` on `module`). It can also declare extra data-only kinds that are allowed in runtime mode.
- **Boundary:**
  - `src/kernel/manifest.mjs`, `src/kernel/schema.mjs` (discriminated union on `kind`), `src/kernel/index.d.ts`;
  - `contractProblems` and the kind checks in `src/families/load-worker.mjs`;
  - `src/families/kit.mjs` (`describe`).
- **Connections:**
  - Only `module` resolves an `implemented-by` boundary (`src/families/graph.mjs`).
  - The kernel stays within its 6 KB gzip budget (`scripts/kernel-budget.mjs`).
- **Acceptance:**
  - A family whose module manifests carry declared `export`/`loading` fields validates.
  - An undeclared extra key still fails.
  - `module` stays required and must resolve.
  - Runtime mode rejects `module`, and accepts a declared data kind.
  - Covered by `tests/kernel.test.mjs`, `tests/kernel-types.test.mjs`, `tests/family-loader.test.mjs` and `tests/family-kit.test.mjs`.

### B — Set-wide checks (#28)
- **Purpose:** express rules over a whole family or across families. Examples: at least one manifest exists, cross-family coverage, uniqueness.
- **Boundary:**
  - the family contract `checkAll(manifests, {families, get, all(familyId)})`;
  - config `checks: [path]` modules with the same signature, loaded like custom generators in `src/families/load-worker.mjs`;
  - rule routing in `src/audit-rules.mjs`;
  - tracked inputs in `src/families/loader.mjs`;
  - `protectedPaths` in `src/families/generate.mjs`.
- **Connections:** findings flow through `familyDiagnostics`, so they appear in both `audit` and `gen --check`.
- **Acceptance:** each example rule reports under `family-valid`, with a stable code and the offending file paths, in both commands.

### C — Decouple floor order (#29)
- **Purpose:** map floor order (`map.floors`) is independent of index, registry and `ctx.blocks()` order. Those still follow `families[]`.
- **Decision during integration:** `map.floors` lists floors top first, the direction the map already draws `families`. #29 says bottom to top, but following it would have changed every existing map.
- **Boundary:**
  - split `floor` from the config index in `src/families/config.mjs`, `src/families/load-worker.mjs`, `src/families/generate.mjs`, `src/families/builtin-generators.mjs`, `src/families/graph.mjs` and `src/families/map-render.mjs`;
  - tests in `tests/family-map.test.mjs` and `tests/family-generation.test.mjs`.
- **Connections:** diagnostic field paths keep pointing at `$.families[<config index>]`.
- **Acceptance:**
  - The map follows `map.floors`.
  - Index bytes are unchanged when only `map.floors` changes.
  - Without `map.floors`, output is identical to 0.5.1.

### D — `family-unclaimed` honours `ignore` and `exclude` (#31)
- **Purpose:** fixtures that share a manifest suffix stop failing the audit once they are excluded.
- **Boundary:**
  - `findUnclaimed` and `attachFamilies` in `src/families/graph.mjs` (pass `project.isIgnored`);
  - per-family `exclude` at the manifest-match sites in `src/families/loader.mjs` and `src/families/load-worker.mjs`;
  - `tests/family-graph.test.mjs`.
- **Connections:** config `ignore` also applies to family manifest discovery, so an ignored file never loads as a manifest.
- **Acceptance:**
  - Excluded or ignored fixtures aren't reported.
  - Strays outside fixture or test folders are still errors.

### E — Stable generation (#32)
- **Purpose:** one `gen` reaches a fixed point even when a manifest imports a generated output.
- **Boundary:**
  - a loop in `generateProject` (`src/families/commands.mjs`): plan, apply, re-scan, re-plan, capped at 3 passes;
  - the `generator-unstable` code through `problem()` in `src/families/generate.mjs`;
  - `tests/family-generation.test.mjs`.
- **Connections:**
  - `--check` and `--dry-run` remain a single, read-only plan.
  - The forked loader and the content-hash cache already see the newly written bytes.
- **Acceptance:**
  - A manifest that imports a generated registry settles in one `gen`, and `gen --check` is clean straight afterwards.
  - An oscillating generator reports `generator-unstable` and names its files.

### F — Map parity (#30)
- **Purpose:** a project can replace its own map with Block Beaver's view without losing features.
- **F1 boundary (data).** Additive graph fields, built by `src/scanner.mjs` reachability and `src/families/graph.mjs`:
  - `codeReach`: ordinary folders that import a block's implementation module, plus optional `map.bindings` registry-call matches found through `src/plugins/js-ts-react.mjs`;
  - `unused`: blocks with no link and no code reach;
  - `gone`: removed blocks retained by `src/families/history.mjs`.
- **F2 boundary (rendering):**
  - code-reach slabs, unused highlighting, gone bricks in the history slider, and `map.groupBy` clusters, in `src/families/map-render.mjs` and `src/block-map.mjs`;
  - `map.skins` with a per-browser toggle, every skin validated by `validateMapStyle` and `prepareMapStyle`;
  - the console's `index.html`, `src/app.js` and `styles.css`.
- **Connections:** the output stays self-contained, keeps a strict CSP with a nonce on every script and style, and remains compatible with `prepareView`.
- **Acceptance:**
  - Every feature is shown in the generated view and in the console Blocks view for a representative manifest set. The review records which view was checked and what appeared.
  - The existing CSP, hostile-text and listener-disposal tests pass.

### G — Pre-commit view freshness and baseline lowering (#26)
- **Purpose:** editing source and committing passes without a manual `update`. Ratchet counts drop when `ignore` grows.
- **Boundary:**
  - `auditSnapshot` and `view-fresh` in `src/compliance.mjs`: regenerate an ignored view from the snapshot graph instead of copying the working-tree view;
  - a new `block-beaver baseline --lower` command (`src/cli.mjs`), also run by `upgrade` (`src/install.mjs`);
  - tests in `tests/install.test.mjs`, `tests/audit-rules.test.mjs`, `tests/upgrade.test.mjs` and `tests/worktree-hook.test.mjs`.
- **Connections:**
  - A committed (not ignored) view is still compared byte for byte.
  - The baseline is written through `writeProjectFiles` with a before-image, and only ever decreases.
- **Acceptance:**
  - A real hook commit passes without the `update` workaround.
  - An `ignore` entry followed by `upgrade` lowers `baseline.json`.
  - The linked-worktree pre-commit case from #21 still passes.

### H — Adoption fixture and documentation
- **Purpose:** prove the #33 goal end to end and document it.
- **Boundary:**
  - `tests/adoption.test.mjs`;
  - `README.md`: version pins, upgrade/audit, "Optional typed families" (including the runtime-kernel non-goal), and a new config reference section;
  - `CHANGELOG.md`;
  - `templates/block-workflow.md` and the installed guidance in `src/project-integration.mjs` / `src/install-templates.mjs`;
  - `templates/agent-skill/references/workflow.md`;
  - `docs/BLOCK_WORKFLOW.md`, `ROADMAP.md`;
  - the version in `package.json` / `package-lock.json`.
- **Connections:** the fixture covers:
  - 3+ families, one with extended module arms;
  - a cross-family `checks` module;
  - suffix-sharing fixtures;
  - a manifest that imports a generated registry;
  - a non-default `map.floors`.
- **Acceptance:**
  - Byte-identical JSON outputs.
  - A clean `gen --check` and `audit --strict`.
  - Onboarding and view regeneration verified in a disposable target from the packed tarball.

## Non-goals

- Replacing an adopting project's own runtime schema and registry kernel. Its result shapes, coerce leniency, plan kinds and registry ordering are domain decisions. Block Beaver's kernel stays small and generic.
- Byte-identical non-JSON outputs. The "generated by block-beaver" header on `.ts`, `.md` and `.html` stays.

## Release gate

1. `npm run check` passes on Node 22.18.0, 22, 24 and 26, plus the full CI matrix on the release PR.
2. Packed-tarball run in a disposable target:
   - `install`;
   - edit and commit without `update`;
   - `gen`, `gen --check`, `audit --strict`;
   - `upgrade` lowering the baseline.
3. All eight cases of the live editor gate (`docs/LIVE_EDITOR_BATTLE.md`) pass with one candidate fingerprint.
4. A cross-family review of each slice, and a review of the full release diff.
5. After merge, follow `docs/RELEASING.md` steps 4–7. Then re-run the downstream adoption listed in #33.

## Known limits

- `block-beaver audit` in a repository with no commits fails with a git error instead of a JSON result. `main` (0.5.1) behaves the same, so this is outside 0.6.0.
- A view that is ignored only through `.git/info/exclude` or a global excludes file is not visible inside the staged snapshot. It is compared against the working copy, as in 0.5.1.
- `baseline --lower` lowers coverage and resolution counts. It does not lower lint allowances, because those counts need ESLint.
- Grouping with `map.groupBy` starts a new row for each group, so many small groups make a floor tall.
- The family map appears in the console's Map view. The Blocks view lists blocks with unused, reach and group chips.

## Evidence

**Commits on `release/0.6.0`:**

| Commit | Slice |
| --- | --- |
| `69c3d1d` | Plan and docs |
| `ec915e1` | 0: config groundwork |
| `a4b3c63` | E: stable generation (#32) |
| `0e600d8` | D: unclaimed honours ignore and exclude (#31) |
| `86faab3` | C: `map.floors` (#29) |
| `3b34397` | A: implementation arms (#27) |
| `cdbd299` | B: set-wide checks (#28) |
| `1332072` | F1: map parity data (#30) |
| `d6bfdaf` | G: staged view regeneration and `baseline --lower` (#26) |
| `06e2c8a` | H: README, config reference, CHANGELOG, version 0.6.0 |
| `b77ad7b` | H: adoption fixture (#33) |
| `eeb54f6` | Fixes from the first review |
| `1b3cde4` | F2: map parity rendering (#30) |
| `aa3d348` | Fixes from the second review |

**Workers.** Claude Sonnet 5.5 built A–E and the adoption fixture. Claude Opus 5.5 built F1, F2 and G. Each worked in its own worktree. Several worktrees started at `965e22f` instead of `release/0.6.0`, so slices were applied as three-way patches, and conflicts in `load-worker.mjs`, `loader.mjs` and the appended tests were resolved by hand.

**Checks.**
- `npm run check` passes locally on Node 26.10.0 with 447 tests, 0 failures. The kernel is 4738 of 6144 gzip bytes.
- **CI on PR #34 at `33bf661`:** all checks pass. That covers Node 22.18.0, 22, 24 and 26, macOS and Windows, the dependency audit, Gitleaks and CodeQL. CodeQL had flagged `js/bad-tag-filter` in three test nonce checks; those regexes now match tags case-insensitively.

**Cross-family review (GPT reviews Claude work).**
- **Review 1:** gpt-6.1-sol, xhigh effort, covering slices 0, A–E, F1 and G. Fixed in `eeb54f6`:
  - P1: a checks-only config skipped every check module.
  - P2: `gen` reported a false `generator-unstable` after the third write.
  - P2: config `checks` modules took a different signature from `checkAll`.
  - P2: `checkAll` lacked types (already fixed in `06e2c8a`).
  - P2: callback types excluded data kinds.
  - P2: commented-out calls counted as binding reach. This is now matched through the TypeScript AST.
  - P2: non-string binding names crashed the scan.
  - P2: audit findings dropped `code` and `field`.
- **Review 2:** gpt-6.1-sol, xhigh effort, covering F2 and `eeb54f6`. No P1 or P3, and no F2 findings. Fixed in `aa3d348`:
  - P2: errors from the verification plan were discarded.
  - P2: `config-valid` findings still lost `code` and `field`.
  - P2: the widened callback types broke existing narrowing on `kind === 'module'`. `LoadedManifest` is now opt-in.
- **Review 3:** gpt-6.1-sol, high effort, on `aa3d348`. No P1, P2 or P3 findings; all three fixes confirmed.

**Adoption fixture (`tests/adoption.test.mjs`).** The fixture has three families, one with extended module arms. It also has a cross-family `checks` module, suffix-sharing fixtures excluded with `exclude`, a manifest that imports a generated registry, and `map.floors` in a different order from `families`.
- The JSON index and coverage outputs match hand-built literals byte for byte.
- `gen` is followed by a clean `gen --check`, and `audit --strict` passes.
- A failing variant reports `family-valid` with the manifest path in both `gen --check` and `audit`.

**Packed tarball.** `block-beaver-0.6.0.tgz` has shasum `14c2b962…d4a0` and 71 files. It was tested in a disposable npm repository outside this checkout:
- The install commit went through the managed pre-commit hook.
- **#26:** a source edit was committed through the hook without `update`, and the working view was not modified.
- After `ignore: ["legacy/**"]`, `upgrade` lowered `baseline.json` coverage from 3 to 2. A later `audit --strict` passed.
- `npm publish --dry-run --access public` reported `block-beaver@0.6.0`, 71 files and the same shasum.

**Map view (Playwright).** The test was a fixture with 3 families and 15 blocks, `map.floors`, `groupBy`, a binding, two skins, and history with two removed blocks, served through `prepareView` under a strict nonce CSP. It produced no console errors. In the generated view:
- Focusing `src/pages` drew six reach lines and lit six blocks across three floors.
- At the first history snapshot, only the blocks that existed then were shown, plus the two ghost bricks.
- The skin choice and slider position were restored after a reload.

The console's Map view showed the same map. Its Blocks view showed the unused, reach and group chips.

**Live editor gate.** The candidate fingerprint is `8492c275311a32bc99c3f4b2a26d2860c113306f697580ff802d19705f9407a8`, at `aa3d348`.

| Case | Claude (claude-sonnet-5-5) | Codex (trusted hooks) |
| --- | --- | --- |
| normal | pass | pending |
| bypass | pass | pending |
| failed | pass | pending |
| drift | pass | pending |

An earlier Claude run passed all four cases at fingerprint `e1285f49…`, before `aa3d348`. The Codex cases need `--codex-hook-trust`, and the owner must trust the hook interactively in the Codex UI.
