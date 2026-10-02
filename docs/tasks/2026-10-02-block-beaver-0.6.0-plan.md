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
- **Purpose:** map floor order (`map.floors`, bottom to top) is independent of index, registry and `ctx.blocks()` order. Those still follow `families[]`.
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

- Recorded as slices land.

## Evidence

- Recorded as slices land: commits, checks per Node version, review findings, tarball runs, CI and the live editor gate.
