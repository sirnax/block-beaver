# Block Beaver design implementation roadmap

Source: `docs/tasks/2026-10-01-block-beaver-v0.2-design.md`, agreed 2026-10-01.
Integration owner: primary Codex. Initial checkout: clean `main` at `8551a99`.
Implementation branch: `codex/block-beaver-v0.4-design` (merged). Development checkout returns to `main` after the final publication record is integrated.

## Status

**0.7.0, adopting an existing family system, part 2 (#36–#44), is published** to npm and GitHub. See [the 0.7.0 plan, evidence and publication record](docs/tasks/2026-10-02-block-beaver-0.7.0-plan.md).

**0.6.0, adopting an existing family system (#26–#33), is published** to npm and GitHub. See [the 0.6.0 plan, evidence and publication record](docs/tasks/2026-10-02-block-beaver-0.6.0-plan.md).

**A–C and release readiness are complete at 0.4.0.** Remote Linux/macOS/Windows CI, trusted native Codex execution, package checks and independent release reviews passed. Block Beaver 0.4.0 is published to npm and GitHub. Fresh public-registry installation and complete onboarding checks passed. E remains deferred.
Detailed current evidence: [final release acceptance](docs/tasks/2026-10-01-block-beaver-release-readiness.md#final-acceptance--complete).

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

## Original A–C local verification (historical)

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

## Release readiness follow-up — complete

- [x] Remote candidate CI and security checks on `e1b1529`.
- [x] Trusted native Codex execution and verified actual model.
- [x] Independent Claude release review and all material fixes.
- [x] Final package checks, evidence and release handoff.

Final runtime fingerprint: `8a837833abf4b6c34ef9c10ae4e92488fb9872268d7cf50ab5d9845863b01866`. Eight live-editor cases passed 108 checks. Linux minimum/26 and local Node 26 passed 320 tests; Windows passed 318 with one POSIX-only skip and no failures. All platform jobs, actual bundler checks, CodeQL, secret scan and dependency audit are green. Main protection includes the minimum Node context.

Final 67-file tarball SHA1: `1044cc8a19fd727a34c29525cbb5d88d438ca4e1`; actual installation, exported types/runtime, generation, upgrades, uninstall and normal/offline publication dry runs passed. See [final acceptance](docs/tasks/2026-10-01-block-beaver-release-readiness.md#final-acceptance--complete) for CI links, artifact integrity and evidence details.

Completed readiness workers: Sol medium CI portability, Codex trust and package smoke; Luna medium release documentation; Sol xhigh reviewed receipt integrity (escalated for cross-platform byte/mode attestation). Claude Sonnet 5.5 high and Opus 5.5 medium independently reviewed GPT changes. Primary integrated Windows native-path/module-identity fixes and final evidence. No workers remain active.

Publication was subsequently authorized and completed as recorded below. Teacake adoption remains the next separate step. Follow [RELEASING](docs/RELEASING.md) for the concrete publication procedure. E stays deferred. Original browser/adoption evidence above remains the A–C snapshot; it is not presented as a new release-readiness browser run.

## Publication — complete

- [x] Confirm npm/GitHub authentication and final published-install wording.
- [x] Repack/dry-run final documentation artifact and independently verify exact tarball installation.
- [x] Create protected-main release PR #13.
- [x] Fix exact provider detection, legacy hook read race and ESLint cache consistency; independently classify findings.
- [x] Apply explicitly approved rescan dispositions for alerts18/19/20.
- [x] Refresh final source platform checks, eight live-editor cases and package evidence at `5423ddc`.
- [x] Merge protected main at `ffa9eef` after all PR checks passed.
- [x] Publish npm 0.4.0 and verify public version integrity.
- [x] Complete fresh standard registry installation/onboarding after index propagation.
- [x] Push immutable release tag and verify public [GitHub release](https://github.com/sirnax/block-beaver/releases/tag/v0.4.0).

The earlier readiness result covered successful CodeQL analysis; PR creation exposed its separate findings check. Publishing is held until those findings are resolved. Current owners: Sol medium provider/hook fixes, Sol xhigh ESLint cache and filesystem investigation, Claude Opus medium independent classification/review; primary integration/publication.

Published: [npm block-beaver 0.4.0](https://www.npmjs.com/package/block-beaver/v/0.4.0) and [GitHub v0.4.0](https://github.com/sirnax/block-beaver/releases/tag/v0.4.0). Release commit `ffa9eef`; final artifact SHA1 `7f5d25b3806158a40044c604bd79f4b149a86877`. Public registry `latest` is 0.4.0 and exact integrity matches. Normal registry installation (no URL substitution or dependency normalization), all exports/types, custom generation, reviewed Claude/Codex onboarding, repeat/upgrade/uninstall and owner preservation passed. Teacake was not modified. All workers finished. Future test maintenance: make disposable Git-fixture cleanup resilient to transient ENOTEMPTY; the unchanged exact failed main job passed on rerun.

Workspace cleanup preserves the older `codex/block-compliance` worktree and backup branch because they retain separate history. Completed implementation/design branches and Finder metadata are removed; installed development dependencies remain available.
