# Block Beaver 0.4.0 release readiness

Owner request: finish remote Linux/Windows CI, trusted Codex native hooks, and release review so the package can be adopted in Teacake. Baseline: clean local branch `codex/block-beaver-v0.4-design`,commit `5e22fcf`.

## Scope and boundaries

- Primary: integration,GitHub candidate branch/CI runs,package/release workflow,release notes,ROADMAP and final review.
- release_ci / Sol medium: `.github/workflows/ci.yml`, `tests/{kernel,audit-rules,host-hooks,install}.test.mjs`, `src/{host-hooks,compliance}.mjs` and a small file-mode helper if needed; full remote suites and meaningful kernel bundler evidence.
- codex_trust / Sol medium: supported normal native-hook trust investigation,disposable harness and focused trust tests. No fabricated trust state or bypass flags.
- Claude Sonnet5.5 high: independent release/package review using reading tools only.

Each worker must report changes,verification,findings and limits. No worker may delegate,commit,merge or publish. Shared edits are integrated by the primary.

## Acceptance

- [ ] Exact candidate tested remotely on Linux and Windows; required checks all green.
- [ ] Installed Codex native hooks actually execute through normal persisted trust; no bypass flags or real user trust-state edits.
- [ ] Release/package review completed; material findings fixed and checked.
- [ ] Package/version/changelog/release notes and publishing procedure agree.
- [ ] ROADMAP and verification evidence updated.

Running remote CI requires making the committed candidate available on its GitHub branch. Package/GitHub release publication and Teacake repository changes are separate steps after readiness.

## Progress and expanded boundaries

- Baseline remote CI [36871508495](https://github.com/sirnax/block-beaver/actions/runs/36871508495) at `5e22fcf`: Linux22/24/26, macOS24 and dependency audit passed; Windows24 exposed16 failures and one optional bundler skip. This run is diagnostic, not final acceptance.
- CI ownership expanded to `src/install-templates.mjs` (bundled LF normalization), `src/managed-files.mjs` (CRLF managed-hash and exact historical template equivalence), `src/project-model.mjs` (TypeScript canonical paths) and corresponding fixture tests. Raw owner bytes and reviewed snapshot checks remain strict.
- Root owns template portability guidance and `src/project-integration.mjs`; installed editor guidance is mirrored through the shared renderer. Luna medium owns README/changelog completion; Sol medium package worker owns disposable tarball smoke evidence.
- Codex normal `/hooks` UI trusted the actual installed command in an isolated home. Native probes observed guide context and allow, block denial and absent denied file. No bypass flags/private trust fabrication/real user auth writes. Final matrix waits for source freeze.
- Claude Sonnet5.5 high independently reviewed package/release files with Read/Glob/Grep, actual canonical model confirmed, no permission denials. Findings drove release-note validation, B/breaking/upgrade notes, minimum Node CI, publishing procedure, fresh matrix and package evidence.
- npm registry lookup returned404 for `block-beaver` on2026-10-01. This does not establish name ownership or publication credentials. Publication remains separate.
- Actual active GitHub ruleset includes existing Linux22/24/26/platform/audit/security contexts. Versioned guidance adds minimum22.18.0 context; applying that additional protection on GitHub is a release settings follow-up. Existing required names are preserved.

Second remote candidate `4db8d74` passed Linux22.18.0/22/24/26, macOS and audit, plus CodeQL and Gitleaks, but Windows retained four failures. Follow-up boundaries: Sol xhigh `windows_receipts` owns compliance receipt/audit mode conversion and `src/compliance-git.mjs`/`src/file-mode.mjs` as necessary, preserving raw snapshot/byte checks; CI worker owns canonical junction loader tracking, CRLF JSON managed idempotency and upgrade fixture line-ending comparison. Escalation reason: cross-platform reviewed-content integrity requires careful native/Git representation without weakening tamper detection. Codex worker owns provisioned package metadata/bin and no-install fixture preflight; package transport remains separately verified. Earlier passed matrix/artifact records are superseded until final runtime freeze.

Receipt integrity boundary now also includes `src/worktree-snapshot.mjs` and `tests/worktree-snapshot.test.mjs`: exact raw byte/native-mode checks are retained, while batch-read index executable metadata is separately attested for Windows receipts. Legacy Windows passing evidence requires a fresh check before integration rather than writing an invalid receipt. Root added a public release-note CLI regression. Integrated local check currently319 passed,0failed,0skipped; final accepted evidence still pending independent review and frozen matrix.
