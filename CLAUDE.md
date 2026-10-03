# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Block Beaver is a local architecture workspace for JS/TS/React repositories: it scans a target repo into an evidenced graph, lets users/agents propose bounded "blocks" (features with a declared file scope), checks proposals in an isolated Git worktree, and records review decisions in a roadmap ledger. It is published to npm as `block-beaver` (ESM, plain `.mjs`, no build step; the only runtime dependency is `typescript`). Requires Node >= 22.18.

## Commands

```sh
npm ci
npm run check          # what CI runs: `node --check` on every .js/.mjs, kernel gzip budget, then `node --test`
npm test               # node --test (all of tests/*.test.mjs)
node --test tests/scanner.test.mjs                       # single test file
node --test --test-name-pattern='name fragment' tests/workflow.test.mjs   # single test
npm start              # localhost console (server.mjs) at http://127.0.0.1:4173; BLOCK_BEAVER_REPO=/path prefills the repo
npm run worker         # authenticated worker (worker.mjs); needs BLOCK_BEAVER_REPO and BLOCK_BEAVER_TOKEN (>=16 chars)
node bin/block-beaver.mjs <command>   # the CLI (also `npm run scan`); `help` lists every command
```

There is no linter. CI additionally installs `esbuild` (`BLOCK_BEAVER_REQUIRE_ESBUILD=1`) for the kernel bundle acceptance test, and validates the changelog via `node scripts/release-notes.mjs vX.Y.Z out.md`.

## Architecture

**Pipeline:** scan -> graph -> registry/families attached -> view/audit/workflow.

- `src/scanner.mjs` walks source files and delegates to language plugins (`src/plugins/js-ts-react.mjs`, built on the TypeScript parser/resolver). The host contract is `accepts/parse/declarations/evidence/links`; every graph edge must carry `evidence` (file, line, column, source text). `src/project-model.mjs` detects apps/workspaces and resolves imports.
- `src/adapter.mjs` (`attachProjectRegistry`) takes the raw scan and layers on app metadata, base-method block manifests, and typed families (`src/families/graph.mjs`). Every consumer (CLI, `server.mjs`, `worker.mjs`, audit) goes scan -> `attachProjectRegistry`.
- **Typed families** (`src/families/`) are optional, repo-defined manifest contracts loaded from the *target* repo via Node's TS stripping + `module.registerHooks` (`loader.mjs`, `load-worker.mjs`), or a configured `loader` package. They drive generators (`generate.mjs`, `claimed-outputs.mjs`, `regions.mjs`), `kit` commands, and the map floors. **Block Beaver must not ship domain families or hard-code product-specific family names, fields, paths or link kinds.** `tests/domain-guard.test.mjs` enforces this against `tests/fixtures/domain-denylist.json`.
- `src/kernel/` is the public `block-beaver/kernel` export (`defineFamily`, schema builder `s`). It must stay dependency-free with relative imports only and under a 6 KiB gzip budget (`scripts/kernel-budget.mjs`, checked by `npm run check`). Types live in `index.d.ts`.
- **Roadmap workflow** (`src/workflow.mjs`, `contracts.mjs`, `create-scope.mjs`, `worktree-snapshot.mjs`): `plan` -> `propose` -> `check` -> `review` -> `approve`/`reject`, with `repair` and `resume`. State is an append-only event ledger under the target's `.blocks/roadmaps/`; `check` creates a branch+worktree under `.blocks/worktrees/`, applies patches (full-file content with `baseHash`), runs the proposal's verification commands, and snapshots the change set. Source drift or undeclared changes block approval. `approve` does not commit or merge.
- **Compliance** (`compliance.mjs`, `audit-rules.mjs`, `audit-format.mjs`, `baseline.mjs`, `migrations.mjs`): `audit` (working tree, `--staged`, or `--base`) evaluates stable named rules; coverage/resolution baselines in `.blocks/baseline.json` can only ratchet down. `integrate` applies approved slices with receipts. Exit code 2 means failure.
- **Install/integration** (`install.mjs`, `install-host.mjs`, `install-templates.mjs`, `managed-files.mjs`, `host-hooks.mjs`, `hook-check*.mjs`, `project-integration.mjs`, `package-manager.mjs`, `templates/`): writes managed, marker-delimited sections into a target repo's editor instructions (AGENTS.md, Claude, Cursor, Copilot), native editor hooks, Git hooks and CI. Owner content outside markers is preserved; `upgrade` refuses edited managed sections unless `--force`. `hook-check` fails open on missing/invalid cache.
- **View:** `block-map.mjs` + `families/map-render*.mjs` render `.blocks/view/index.html` and `graph.json`; `project-watch.mjs` powers `start` live refresh. The interactive dev console is `server.mjs` + root `index.html` + `src/app.js` + `styles.css`; `docs/index.html` is the public landing page, not the console.
- `src/cli.mjs` is a single flat command dispatcher (hand-rolled flag parser; boolean flags are listed in the `flags` set, so a new boolean flag must be added there). `bin/block-beaver.mjs` is the entry point.
- Public exports (`package.json` `exports`): `.` (scanner), `./view`, `./kernel`, `./eslint`. `files` limits the npm tarball to `bin/ src/ templates/` plus docs.

## Conventions

- Tests that write `.blocks/` data or run Git must use a temp directory/disposable repo (see `tests/helpers/install-fixture.mjs`); never depend on TeaCake or any other external repo, and never embed machine-specific absolute paths.
- Changes to the user-facing workflow must update both `templates/block-workflow.md` and the installed editor guidance in `src/project-integration.mjs`, and be verified by onboarding a disposable target repo and regenerating its view.
- Changes to how blocks are presented update `index.html`, `src/app.js` and `styles.css` together; blocks are never hard-coded into HTML.
- Add a focused test for scanner, graph contract, roadmap state, patch validation, worker authorization, or other regression-prone changes. User-visible changes need a `CHANGELOG.md` entry (`## X.Y.Z — date`).
- For meaningful changes, record purpose / boundary / connections / acceptance in the PR or task doc before editing (`docs/BLOCK_WORKFLOW.md`, `docs/tasks/`).
- For well-defined tasks (clear scope, owned files and acceptance checks), delegate to the `sonnet-high` sub-agent (`.claude/agents/sonnet-high.md`: latest Sonnet at high effort, faster and cheaper) rather than doing everything on the primary model. Give each one a separate file boundary and keep a single integration owner for shared files.
- The HTTP console and worker bind to localhost and reject non-local requests (`src/http-security.mjs`); the worker requires a bearer token compared with `timingSafeEqual`.

## Releasing

See `docs/RELEASING.md`. Publishing to npm is a separate, owner-authorized step; the tag workflow only creates a GitHub release and contains no npm credentials. The user wants to receive exactly one command, `npm publish <absolute tgz path> --access public`; do the merge, pack, tag, GitHub release and issue closing yourself.

## Notes

- This repository no longer has an `AGENTS.md`; its multi-model worker roster was retired in favour of this file and `.claude/agents/`. Older task records in `docs/tasks/` still mention it as historical context. (Block Beaver still *installs* `AGENTS.md` guidance into target projects; that is unrelated.)
