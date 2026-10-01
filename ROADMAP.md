# Block Beaver design implementation roadmap

Source: `docs/tasks/2026-10-01-block-beaver-v0.2-design.md` (agreed 2026-10-01).
Integration owner: primary Codex agent. Baseline: `8551a99` on `main`; checkout initially clean.

## Scope and gates

Implement A → B → C locally, with a separate plan and acceptance review for each.
E remains deferred. Package publication and release publication require a separate instruction.
Owner confirmed full local A–C scope and public test seams: CLI commands, scanned
graph, generated view and installed files, exported view and kernel APIs.
No worker may delegate, commit, merge or publish.

## Current work

A and B implementations have passed local checks. C implementation is integrating;
real editor release scenarios and final cross-family reviews remain gates. No release is published.

| Lane | Owner/model | Purpose and owned boundary | Connections | Acceptance/status |
| --- | --- | --- | --- | --- |
| A1 | project_model / Sol medium | Config detection, ownership, compiler resolver; `src/project-model.mjs`, `tests/project-model.test.mjs` | TS config/compiler APIs; scanner consumes `loadProjectModel(root,{paths,writeConfig,strict})`, `ownerByFile`, `resolveImport` | Workspace/extends/owner precedence/safe config writes; complete |
| A2 | scanner / Sol medium | Graph v2, imports, entry reachability and health; `src/scanner.mjs`, `src/plugins/js-ts-react.mjs`, scanner tests | A1; nodes `app`/`usedBy`, edges `crossApp`, `resolutionReport` | Exact targets, dynamic imports, strict errors, unchanged limits, benchmark; complete |
| A3 | console / Sol medium | Live app areas, filter, health, cross-app evidence; `index.html`, `src/app.js`, `styles.css` | Graph v2 from A2; representative manifests | App headings above relative folders, chips and clickable report; complete |
| A3b | view / Sol medium | Generated map and pure embedding helper; `src/block-map.mjs`, `src/view.mjs`, map/view tests | Graph v2; CLI module export owned by integration | Inline nonce scripts/styles, slot, deterministic bytes, no external assets; complete |
| B discovery | compliance_reuse / Sol medium | Read-only inspection of `codex/block-compliance` | Existing audit/install/live-editor foundation | Report reuse strategy and branch state; complete |
| Integration | primary | CLI, package metadata, watch server, adapter metadata, docs and ROADMAP | All lanes; shared files have one owner | Focused checks, `npm run check`, disposable onboarding/view regeneration and UI check |

### B active lanes

Detailed boundaries and acceptance matrix: `docs/tasks/2026-10-01-block-beaver-install-plan.md`.

| Lane | Owner/model | Status |
| --- | --- | --- |
| Managed files/skills/native agent hooks | view / Sol medium | Five focused tests passed; native local CLI invocation being aligned |
| Package manager exact pins | package_managers / Sol medium | 12 tests passed; Windows adapter followup |
| Config/data migrations | project_model / Sol medium | Five golden tests passed |
| Hook context | hook_context / Sol medium | 13 tests passed; parent CLI wiring |
| Audit rules/receipt preservation | scanner / Sol medium | Complete; 12 focused typed-family/snapshot audit checks passed |
| Install/upgrade/uninstall | installer / Sol medium | Complete; 25 combined C installation/migration checks passed |
| Host hooks/CI/ignores/excludes | Sonnet 5.5 high CLI | Completed; GPT cross-review fixes verified |
| Live-editor release harness | Sonnet 5.5 high CLI | Completed; actual 8-case behavior matrix passed, final fingerprint gate pending |
| A independent review | Sonnet 5.5 high CLI | Completed with actual canonical model, no denials/fallback; findings routed |

## A plan: project model, resolver and multi-app view (0.2.0)

- [x] Read design, guidance and standing workflow; inspect baseline and worker availability.
- [x] Agree graph/model contracts and allocate independent boundaries.
- [x] Implement A1–A3b; integration and review fixes in progress.
- [x] Wire `detect`, `--strict`, `view --format module --out`, package view export and module size.
- [x] Replace unsafe-inline session CSP with request nonce rendering.
- [x] Update user workflow template, installed guidance and documentation.
- [x] Verify single/multi-app fixtures, generated map, live console and embedding.
- [x] Run full checks and independent spec/standards review; fix findings.

## B plan placeholder: install, upgrade and governance (0.3.0)

First inspect and reuse `codex/block-compliance`; document its integration diff before editing.
Then assign install/managed rendering, migrations, hook-check and audit extensions to
separate boundaries. Acceptance includes manager/hook fixtures, golden upgrades, edit
preservation, stable audit rule pass/fail fixtures and the real CLI release gate.

- [x] Integrate reusable compliance new files and ready-for-approval workflow fields.
- [x] Write detailed B boundary and interface plan.
- [ ] Implement and verify B, including release readiness and uncompleted external gates.

## C plan placeholder: optional families (0.4.0)

After B acceptance, assign kernel, loader/validation, generation/history, kit, and map
floors with explicit shared contracts. No shipped domain families. Remove legacy domain
adapter only when the generic configured families path is verified.

- [x] Write detailed C boundary and interface plan; Opus 5.5 medium finalized generic APIs
  in `docs/tasks/2026-10-01-block-beaver-families-contracts.md` with verified canonical model.
- [x] Implement C and document versioned output/API contracts.
- [x] Verify all design fixtures, domain guard, size budget and adoption compatibility.
- [x] Final full checks and independent review.

## Findings and decisions

- Claude Code 2.1.286 initially reported logged out inside the sandbox. Owner identified
  sandbox difference; authenticated outside sandbox and verified Sonnet 5.5 high access
  without fallback. Sonnet independent A review now running through CLI (reading only).
- GPT spec and standards reviewers found NodeNext conditional-export mode and malformed
  JSON config blockers. Model/scanner owners are adding regression fixes before A gate.
- Design requires first-run config writing; update prior read-only scan documentation.
- App IDs default to folder name; outside-app files use `app: null`.
- Resolution report entries: `{app,file,line,column,specifier,message}`. App health:
  `{status,unresolvedImports,unreachableFiles,tsconfigErrors}`.
- Use only independent useful workers, within the 16-worker limit, rather than filling slots.

## Verification log

- `npm run check` outside sandbox: 67 tests passed, no failures (A initial integration).
- Generated map actual Playwright strict-CSP test: zero errors/warnings, nonce scripts
  and styles, host navigation and app/cross-app filters working.
- Scanner disposable 1,300-file fixture: multi-app ~170 ms, repeated ~73 ms,
  single-app ~116 ms. Synthetic comparison; real adopted-project measurement still pending.
- Focused console mock DOM check passed app grouping/filter/chips/report/Blocks/evidence.
  Actual live-console representative manifest browser check remains.
- Registered view module exports excluded from source scanning to prevent self-scan drift;
  exported module repeat test passed. Other generated implementation files stay visible.
- Sonnet review identified ignored export registry; registry now committed at
  `.blocks/view-exports.json`. CLI detect prints public report only; read-only console,
  inspect/search/kit preserve target config. Document detection provenance.
- A model additional tests: malformed config/tsconfig, conditional exports, assets,
  escaped imports and bounded tsconfig inventory passed. Combined model/scanner 18 passed.
- Actual live console Chrome check against disposable multi-app manifests: both Blocks,
  implementation/dependency evidence, usedBy, health and app filters appeared correctly.
  20,000-file DOM mock confirms bounded initial rendering with explicit expansion.
- Compliance branch reuse inspection complete; B plan and C preliminary plan written.
- B integrated `npm run check`: **169 tests passed**. Installer 12 public tests passed,
  including frozen 0.1.1 upgrade, owner/local preservation and repeated no-op upgrade.
- Sonnet host setup 25 tests passed; GPT Sol xhigh review (complex multi-format preservation)
  found missing hash protection and CI view regeneration; reviewer completed fixes.
- Real live CLI attempts exposed a harness stream-completion race (exit 13). Fixed and
  no-agent process regression exercised; authenticated scenario matrix reruns pending.
- Package pack succeeded with temporary cache; first default-cache attempt hit sandbox EPERM.
  No machine cache ownership or credentials changed. Pack smoke installation pending.
- Range audit explicitly skips ephemeral bare `.git/hooks` availability/mode on CI clones;
  working/staged audits enforce it. Tracked hooks, native settings, CI and receipts remain gates.

## C active implementation boundaries

B local implementation checks passed; B release-harness and review followups continue.
C source work is local only; no release gate is declared passed by starting these lanes.

| Lane | Owner/model | Boundary and connections | Acceptance |
| --- | --- | --- | --- |
| Kernel | kernel / Sol medium | `src/kernel/**`, kernel tests; exported schema/registry/manifest/authoring API | Pure dependency-free runtime, runtime module refusal, TS types, size budget |
| Loader | family_loader / Sol xhigh | `src/families/{config,glob,loader,load-worker,hooks,canonical}.mjs`, loader tests | Escalated for TS hooks/cache isolation; aliases/type modes/purity/fallback/load freshness |
| Graph | family_graph / Sol medium | `src/families/graph.mjs`, graph tests | Typed array links, missing targets, module+files boundaries, app metadata/discovery |
| Generation/history | Sonnet 5.5 high CLI | `src/families/{generate,builtin-generators,cache,history,commands}.mjs`, generation/history tests; isolated worktree | Deterministic outputs, cache/check/collisions, preserved history/import replay |
| Kit | family_kit / Sol medium | `src/families/{kit,scaffold}.mjs`, kit tests | JSON APIs, collision-safe multi-file dry-run scaffold/manual steps/gen |
| Map | view / Sol medium | Generated/live renderers, `families/{map-style,map-render}.mjs`, floor tests | Isometric ordered floors, colored links/history, skin, base/CSP/embed compatibility |
| Lint/domain guard | family_lint / Sol medium | `src/eslint/index.mjs`, lint/domain tests/denylist | Opt-in counts, generated/allowed skips, no legacy domain in source |
| Integration | primary | Generic adapter removal, CLI/audit/installer/package/docs/check script | Real loader/gen/kit adoption fixture, browser floors, pack, full suite, cross-family review |

### Current integration update

- A actual generated and live browser checks completed; B integrated 169 tests passed.
- Host cross-model review fixes passed 28 host and 59 combined installer/managed tests.
- C loader 11 tests passed on Node 24.21 and 26.10; Node22.18 matrix remains pending.
- C graph 8, kit 7, lint 7 and map 9 focused tests passed.
- C actual generated strict-CSP and live family floor checks passed with zero errors/warnings;
  verified history membership/persistence, skin tokens, app filters and source evidence.
- Authenticated Claude/Codex failed-verification scenarios respected the workflow. Harness
  false-positive read-only Git hook overrides and staged snapshot repo identity need fixes.
- Sonnet generation worker resumed after correcting approved verification command allowances.
  Opus independently reviewing GPT kernel/loader; GPT workers integrating C audit/installer/hooks.

- Minimum loader matrix: Node22.18.0,24.21.0,26.10,12/12 each.
- Kernel CI budget now enforced at6KiB; actual4462bytes aggregate gzip. Runtime/types/tree-shaking
  checks passed onNode22.18; fullfocused Ckernel/loader/graph/map suite35 passed.
- C installer25 checks passed including invalidfamily no-mutation and index-array preservation.
- C hook16 and graph9 focusedtests pass; typed metadata does not invent implementation coverage.
- Real live gate: five scenarios currentlypass; remaining normal/bypass runs underway.

- Generation Sonnet implementation completed with canonical model verified; three exploratory
  Bash calls denied, approved checks passed. GPT review fixed semantic cache keys, reload
  errors, protected paths and final embedded map regeneration. Generation/history40 passed.
- Real adoption fixture preserves named manifest bytes and registry runtime semantics, uses
  frozen custom-generator context, and verifies immediate generated-module freshness.
- Opus independent kernel/loader review findings routed; invalid defaults fixed,4504bytekernel.
  Loader race/error/import/fallback refinements remain final focused-review work.
- Actual source tarball npm transport and installed exports/install/upgrade/uninstall passed
  at0.3.0; final0.4 repeat remains. No owner files or machine credentials/cache changed.

## Frozen 0.4.0 candidate verification

- Complete `scripts/check.mjs` suites: **309/309 tests pass** with no skips on
  Node22.18.0,24.21.0 and26.10.0; syntax and6KiB kernel budget passed.
- Node22 CommonJS fallback fixture preloads real kernel ESM before registering
  compilation hooks, avoiding Node22 synchronous-hook require(ESM) linking limitations.
- Final Sonnet independent C integration review completed with canonical model/no denials.
  Fixed actual mapStyle wiring, disposed repeated UI listeners, invoked unclaimed-family
  discovery, stable checked-in package identity, invalid history diagnostics, structured
  audit registry errors, diagnostic ownership, full dry-run parity and CLI error statuses.
- Actual map/browser repeat checks and public differently named clone adoption pass.
- Real ESLint9.39.5 CLI passes allowed/baseline/generated/directive cases; violations exit1.
- Frozen package smoke:154140packed bytes,66files; artifact SHA1
  `28b4c0462b04a60d9a7d5baad6726a2b7a0e8d1f`; clean npm tarball/cache transport,
  installedexports+familygen/check+idempotentinstall/upgrade+owner-preservinguninstall pass.
- Frozen source candidate fingerprint:
  `b19c989624de21bda1c9424ca4c9baa3d003e86fd247e9e6130a3abf76b27a87`.
  Final live-editor8-case gate running against this identical start/end fingerprint.
- Remote Linux/Windows CI has not run locally; repository CI remains configured for it.
  No package, GitHub release, branch or pull request has been published.
