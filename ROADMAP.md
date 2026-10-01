# Block Beaver design implementation roadmap

Source: `docs/tasks/2026-10-01-block-beaver-v0.2-design.md`, agreed 2026-10-01.
Integration owner: primary Codex. Initial checkout: clean `main` at `8551a99`.
Current branch: `codex/block-beaver-v0.4-design`.

## Status

**A–C are complete and verified locally at 0.4.0.** No authorized implementation work remains.
E is deferred; no package, release, branch or pull request has been published.
Detailed evidence and limits: [local verification](docs/tasks/2026-10-01-block-beaver-v0.4-verification.md).

The owner approved CLI, scan/graph, generated/installed files and exported view/kernel public test seams, plus full local A–C scope. Workers did not delegate, commit, merge or publish. The primary integrated and committed reviewed changes. Only useful independent workers ran within the 16-worker limit.

## Completed work

- [x] A: project/app detection, versioned config, TypeScript resolver, graph2 ownership/reachability/health, cross-app evidence and filters.
- [x] A: deterministic embedding module, pure nonce/header helper, strict-CSP watch server and portable generated/live views.
- [x] B: reusable compliance foundation, exact local package pins, managed native skills/hooks, host hooks/CI/ignores, versioned migrations.
- [x] B: install/upgrade/uninstall preservation, dry-run plans, hook context, structural/ratchet/receipt audit and reviewed integration.
- [x] B: authenticated normal/bypass/failed/drift release rubric for both editor CLIs, with stable source fingerprints.
- [x] C: dependency-free kernel with types/default validation/runtime restrictions, frozen registries, composition and size/tree-shaking checks.
- [x] C: child-isolated TS/fallback loader, real globs, exact-source cache, named validation failures, typed links/boundaries and unclaimed discovery.
- [x] C: deterministic registry/index/custom outputs, read-only drift checking, history/replay/import and safe multi-file kit creation.
- [x] C: shared isometric floors, skins/history/source evidence, opt-in lint/downward baseline and domain guard.
- [x] C: remove the legacy domain adapter and verify unchanged-manifest adoption with equivalent registry semantics.
- [x] Update workflow template, installed guidance, README, plans/contracts, design status and verification record.
- [x] Final independent reviews and full local runtime/browser/package/editor verification.

## Agent assignments

| Owner/profile | Purpose and owned boundary | Final evidence |
| --- | --- | --- |
| project_model / Sol medium | Model/resolver and migrations | Detection, aliases, conditional exports, assets and migration goldens |
| scanner / Sol medium | Scanner/plugin and audit/receipt integration | Typed/staged snapshot, drift, malformed-registry and ratchet regressions |
| console / Sol medium | Live app areas/evidence and bounded rendering | Actual browser navigation and20,000-file expansion |
| view / Sol medium | Generated/shared map, managed instruction foundation | Actual strict-CSP skins/history/evidence and repeated listener checks |
| installer / Sol medium | Install/upgrade/uninstall orchestration | Frozen0.1.1 upgrades, owner preservation, invalid-family no-mutation |
| package_managers / Sol medium | Manager plans and actual tarball smoke | Windows shim plans, npm/pnpm/Yarn/Bun invocation, installed exports |
| hook_context / Sol medium | Cached hook context and kit CLI errors | Typed association without coverage; actual partial-write/input tests |
| kernel / Sol medium | Pure runtime/types/budget | Minimum runtime/types/defaults and actual tree shaking |
| family_loader / Sol xhigh | TS hooks/cache isolation; escalated for complexity | Minimum22/24 matrix, review regressions and real tsx proof |
| family_graph / Sol medium | Typed links, ownership, discovery and history | Content-stable clone fingerprints, discovery and invalid history |
| family_kit / Sol medium | Safe scaffold/JSON kit | Real creation/dry-run parity and final view freshness |
| family_lint / Sol medium | Opt-in lint and domain guard | Real ESLint 9.39.5 CLI and public rule tests |
| families_plan / Luna medium | Plans and documentation | Current API/contracts and mirrored workflow docs |
| Sonnet 5.5 high CLI | Host setup, harness, generation/history | Isolated implementation worktrees; canonical model verified |
| Opus 5.5 medium CLI | Architecture and kernel/loader independent review | Canonical model verified; material findings fixed |
| GPT independent reviewers | Review Sonnet host/generation; initial spec/standards | Public regressions and review fixes integrated |
| gate_review / Sol medium | Actual editor release gate/instrumentation |8/8 cases,96/96 checks, same start/end source hash |
| primary | Shared CLI/adapter/package/docs and final integration | Local commits and final evidence below |

## Final verification

- **310 tests passed,0 failed,0 skipped on each Node 22.18.0,24.21.0,26.10.0**, including syntax and kernel budget.
- **8/8 editor scenarios,96/96 checks passed** against frozen source SHA256
  `066f9b6e694eeaabefd7ebb5d8793fc0472fbf2f64fa78ed1b98807ef532ad5b`.
- Generated/live browser checks passed with 0 errors/warnings; actual pipeline skin/token and listener-disposal regressions added.
- Real named-manifest/custom-generator adoption passed and a differently named clone produced fresh embedded modules.
- Kernel 4,504/6,144gzip bytes; actual esbuild tree shaking and declaration inference passed.
- Real tsx 4.23.15 CommonJS fallback passed on22/24 after adding the kernel's default package export; permanent require regression added.
- Real ESLint 9.39.5 allowed/violation/directive checks passed without adding a production dependency.
- Final 66-file tarball smoke passed. SHA1: `f806d8a3a548eb682c9701aa1dc51a892536592a`.
- Synthetic1,300-file scanner:~170ms multi-app,~73ms repeat,~116ms single; not a measurement of an external adopted project.

## Useful decisions and review fixes

- Registered view modules live in committed `.blocks/view-exports.json` and are excluded from source self-scanning. Generation/audit checks include them.
- Read-only console/inspect/search do not write target config; first CLI scan persists detection/provenance.
- Typed implementation boundaries are resolved module+explicitfiles; manifests/contracts/generators carry metadata without adding implementation coverage.
- Custom generation cache includes exposed semantic context and exact inputs/code/output hashes; check/audit do not write output or cache.
- JSON index remains a bare array. Configured JSON output replacement is intentional; reserved/managed paths are protected, including case aliases.
- Final generation refreshes maps after source/history writes. Kit dry-run uses a disposable snapshot and matches real output lists/bytes.
- Project identity comes from checked-in package metadata, with a stable fallback; history errors and malformed export registries produce located diagnostics.
- Independent reviews fixed NodeNext mode, malformed config, managed-section hashes, CI regeneration, loader races/retries/resolution/IPC, invalid defaults, mapStyle wiring, listener accumulation, unclaimed discovery and CLI error contracts.
- Claude authenticated outside the sandbox; canonical Sonnet/Opus models verified. No credential or machine-cache ownership changes were made.

## Remaining release work and limits

No A–C local implementation tasks remain. Remote Linux/Windows CI and a Codex native-hook trusted-editor check remain external verification; Codex native files were intact but execution was not observed in fresh untrusted fixtures. Its actual model metadata was also unavailable; GPT-6.1-Sol medium was requested. Claude actual Sonnet 5.5 and native execution were verified.

Known host boundaries and optional bundler availability are recorded in the verification document. Publication needs a separate instruction. E remains future work.

Implementation commits:`1bc1779` (A–C),`d931eed` (CommonJS kernel export),`4ca5e9b` (release evidence scope). Completed disposable Claude worktrees and browser servers were cleaned up; the pre-existing compliance worktree was preserved.

## Release readiness follow-up — 2026-10-01

Requested: remote Linux/Windows CI,trusted Codex native hooks,and release review before publishing for Teacake adoption. Detailed boundary/acceptance: [release readiness](docs/tasks/2026-10-01-block-beaver-release-readiness.md).

- [ ] Remote candidate CI.
- [ ] Trusted native Codex execution.
- [ ] Independent Claude release review and fixes.
- [ ] Final package/release handoff.

Active workers: Sol medium CI portability and Codex trust; Claude Sonnet5.5 high independent review after authentication/model preflight. Primary owns integration and remote CI.

Progress: baseline remote CI passed Linux22/24/26/macOS/audit but Windows exposed path, CRLF and permission defects. Fixes preserve the checks. Native Codex guide/deny probes executed successfully through normal `/hooks` trust. Claude review found stale release notes/install guidance, now being corrected; Luna handles README/changelog, Sol handles fresh package smoke. Final matrix and artifact wait for the behavior-source freeze.

Second candidate remote: Linux22.18/22/24/26, macOS, audit, CodeQL and Gitleaks passed; Windows four remaining failures are under repair. Additional Sol xhigh worker owns exact receipt-mode representation. First fresh Claude4/4 and tarballsmoke passed, but final evidence must be refreshed after these fixes.
