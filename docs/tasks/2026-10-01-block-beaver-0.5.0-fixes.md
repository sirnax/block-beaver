# Block Beaver 0.5.0 first-use fixes

First real use of 0.4.0 produced issues #14–#18; Dependabot PRs #10 and #11 are the CodeQL chores. This document holds the block records and the evidence.

Chores note: 4.38.2 is the `github/codeql-action` version, not Block Beaver's. Block Beaver goes 0.4.0 → **0.5.0** (new config key, changed install default, extended resolution report).

Owner decisions: new installs write `enforcement.receipts: "optional"`; configs without the key keep `required`. Publishing and the tag push need explicit owner authorization.

Workers: Claude Sonnet 5.5 (high), one isolated worktree per slice from `main` at `5c6f7bb`. Review: cross-family (GPT) if available, otherwise Opus medium, disclosed below. Integration branch: `fix/0.5.0-first-use`.

## Block records

### A — CLI output flush (#14)
- **Purpose:** piped JSON from every command is complete, not cut at 64 KB.
- **Boundary:** `src/cli.mjs`, `src/hook-check-cli.mjs`, `tests/cli-output.test.mjs`.
- **Connections:** exit codes and `start`/hook timers unchanged; `src/families/load-worker.mjs` untouched (IPC).
- **Acceptance:** >256 KB `audit` output and a 1,500-file `install --dry-run` parse as JSON through a pipe; existing CLI tests pass.

### B — CI template Node version (#15)
- **Purpose:** managed CI uses the repository's Node version and current action majors.
- **Boundary:** `src/install-host.mjs` (CI helpers), `src/compliance-setup.mjs` (CI templates only), `tests/install-host.test.mjs`, `tests/ci-template-actions.test.mjs`, upgrade goldens where intended.
- **Connections:** legacy adoption bytes frozen (`@v4`, Node 22); `managed-current` compares exact bytes.
- **Acceptance:** `.nvmrc`/`.node-version`/`engines`/default fixtures render the right YAML and GitLab image; legacy and 0.4.0 regions still upgrade; template majors equal this repo's `ci.yml`.

### C — Package asset resolution (#16)
- **Purpose:** bare package asset imports (e.g. `reactflow/dist/style.css`) resolve through `node_modules` and `exports`; real misses are reported as assets.
- **Boundary:** `src/project-model.mjs`, `src/plugins/js-ts-react.mjs`, `src/scanner.mjs`, report sections of `src/block-map.mjs` and `src/app.js`, two test files.
- **Connections:** `unresolvedImports` stays the total so ratchet/`--strict` semantics hold; other `resolveImport` callers use only `.path`/`.external`.
- **Acceptance:** exports/wildcard/condition/not-exported/missing cases; strict scan passes with resolvable assets; console report shows the category.

### D — Setup exception and receipt level (#17, #18)
- **Purpose:** a fresh install passes its own audit; `enforcement.receipts` (`required|optional|off`) lets owners adopt the structural gate first.
- **Boundary:** `src/compliance.mjs`, `src/audit-rules.mjs`, `src/install.mjs`, `templates/block-workflow.md` (+ `templates/legacy/0.4.0-workflow.md`), `src/managed-files.mjs` (legacy registration), `src/project-integration.mjs` text, skill reference, five test files.
- **Connections:** reuses the managed-exception mechanism from `init`; hook and CI text unchanged; effective level is the stricter of base and tree config.
- **Acceptance:** install → audit passes → real pre-commit commit succeeds; upgrade records an exception; levels behave as specified; loosening in the same commit still fails.

### E — CodeQL chores (#10, #11)
- **Purpose:** `init` and `analyze` move together so CodeQL stops failing on a version mismatch.
- **Boundary:** `.github/workflows/codeql.yml`, `.github/dependabot.yml`.
- **Acceptance:** both pinned to the dereferenced 4.38.2 commit `2892aa5e…` (verified equal to Dependabot's); Dependabot group added; CI green.

## Known limits
- Setup exceptions accumulate, one per install/upgrade; pruning is deferred.
- `managed-current` still needs exact CI bytes; a Dependabot bump inside a target's managed region needs `upgrade --force`.
- `uninstall` records no setup exception.

## Evidence
(filled in during integration)
