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

**Implementation:** four Claude Sonnet 5.5 (high) workers in isolated worktrees from `5c6f7bb`; their diffs were checked against each file boundary and applied by the integrator. Commits on `fix/0.5.0-first-use`: E `ad29e54`, C `9846709`, A `b09474b`, B `bb2a72d`, D `e74f5dc`, release bump `4395547`.

**Full check (`npm run check`, syntax + kernel budget + `node --test`):**

| Node | Result |
| --- | --- |
| 22.18.0 | 361 passed, 0 failed (before review fixes) |
| 24.21.0 | 361 passed, 0 failed (before review fixes) |
| 26.10.0 | 363 passed, 0 failed (after review fixes) |

Kernel gzip 4504/6144 bytes on 24 and 26 (4511 on 22.18.0).

**Cross-family review:** GPT (gpt-6.1-sol, medium, read-only) reviewed `git diff 5c6f7bb..HEAD`. No findings on stdout flushing, CI version selection, frozen legacy bytes, stricter-of-base-and-tree enforcement or the matching CodeQL SHAs. Two findings, both accepted and fixed:
1. **P1:** with `receipts: "off"` a forged block receipt, or an exception whose recorded verification failed, left the audit passing. Under `off` the review requirement is still skipped, but invalid evidence now fails `reviewed-content`. Tests changed to require failure; one added for a failed-verification exception. (The Slice D worker had flagged this as an open owner decision and asserted the weaker behaviour.)
2. **P2:** export-pattern precedence compared only prefix length. It now breaks ties on whole-key length as Node does, so `"./*.css": null` overrides `"./*"`. New test covers both a null and a redirecting specific pattern.

**End-to-end (packed 0.5.0 tarball, disposable target outside this repo, Node 24.21.0; target at commit `4395547`):**
- #14: `install --dry-run` on a 1,100-file project piped into `JSON.parse` parsed intact.
- #17/#18: `install --agents claude,codex` exited 0, `complete: true`, recorded one setup exception, reported `receipts: optional` with the gate message. The first `git commit` went through the real pre-commit hook.
- #15: with a GitHub remote, `upgrade` wrote `actions/checkout@v7`, `actions/setup-node@v7` and `node-version-file: .nvmrc`; the commit passed the hook.
- #16: `scan --strict` exited 0 with 0 unresolved and 0 missing assets for `import 'reactflow/dist/style.css'`.
- #18 levels: under `optional` an edit to an existing source file committed with one advisory. Tightening to `required` takes effect at once, so the `.blocks/config.json` change needs a covering exception (`block-beaver exception`). Under `required` a further source change was blocked. Loosening to `off` in the same commit as a source change was blocked (base level wins). Loosening alone with an exception was allowed, and a later source commit then passed.
- Not exercised end to end: the P1/P2 fixes landed after this run and are covered by unit tests.

**Corrections to the plan found during verification:**
- Step 7 as written (adding an unreviewed new `src/new.ts`) is blocked by `coverage-ratchet`, a structural rule that `optional` does not relax. Edit an existing owned file instead.
- A source change also needs `block-beaver update` first, or `view-fresh` fails. That is intended.
- The audit-output test uses 600 untracked files, not 3,000 (3,000 took about 45 s per run); it still asserts more than 64 KB of piped output.
- `src/project-integration.mjs` needed no change: it writes `templates/block-workflow.md`, so `init` already gets the new section.
- The disposable target's local dependency had to be normalized to exact `0.5.0` after tarball transport so `install` would not ask the registry for the unpublished version, as in the 0.4.0 acceptance.

**Console check:** Slice C's worker scanned a fixture (`reactflow/dist/style.css` present, `reactflow/dist/gone.css` and `./nope` missing) in the local console and clicked app health. Status read "2 unresolved imports (1 missing asset)"; the report heading read "Unresolved imports (2, 1 missing asset)" and listed `[asset]` and `[module]` entries; the resolving import was not listed. The worker saw one Playwright console error and did not investigate it (see open items).

## Open items
- Investigate the one console error seen during the Slice C console check.
- Closing #10 and #11, `npm publish` and the `v0.5.0` tag push need owner authorization.
