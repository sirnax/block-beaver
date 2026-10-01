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
