# Install, agent integration and upgrades implementation plan

Status: planned on 2026-10-01; B implementation begins only after A's acceptance gate. Design authority: [v0.2 design, sub-project B](2026-10-01-block-beaver-v0.2-design.md). Target release: 0.3.0. No E work is included. This record defines file ownership and connections before editing.

## Prerequisites and reuse

Accept A's config model, compiler resolver, graph schema 2, deterministic view export and strict scan behavior first. Integrator publishes exact exported API names and graph fields to all B workers before dispatch. Preserve current A code and existing public commands.

Reuse the three commits after `fd43577` on `codex/block-compliance`: `abcc64b`, `2841b50`, `79c27d8`. Portable integration at fd43577 already exists in main. Bring new compliance files/tests/harness in through reviewed patches, then manually integrate shared CLI/map/workflow changes. Do not reset main or reapply old shared files over A. Investigation details and patch commands are in `/tmp/block-beaver-compliance-reuse.md`; retain relevant evidence in this task when integrating because temp reports are not permanent documentation.

The reused audit enforces exact reviewed receipts and exceptions. Retain that guarantee alongside the design's rule IDs. Existing exceptions forbid source files: ratchet exceptions need a distinct versioned type; do not silently weaken verified-content exceptions.

## Parallel boundaries

No worker delegates, commits, merges or publishes. The orchestrator owns integration and release decisions; implementation workers use designated isolated worktrees or explicitly assigned non-overlapping paths. Up to 16 useful workers total, including any CLI review workers; spare capacity does not justify duplicate ownership.

| Slice | Purpose and owned paths | Connections | Acceptance |
| --- | --- | --- | --- |
| B1 Managed files | Render/protect managed sections and agent skills; `src/managed-files.mjs`, `src/install-templates.mjs`, `templates/agent-skill/**`, `tests/managed-files.test.mjs` | Pure desired-state plan; package version, config, agent ids; consumed by installer/upgrade | Idempotency, surrounding/local text preserved, recorded hash, edited managed content refuses upgrade unless force, JSON entries replaced by id |
| B2 Package managers | Exact npm distribution pin and uninstall; `src/package-manager.mjs`, `tests/package-manager.test.mjs` | Lockfile detection and injectable command runner; installer requests add/remove | npm/pnpm/yarn/bun fixture matrix, exact versions, lockfile update, conflicting detection reported, runner failures propagated, dry-run performs no commands |
| B3 Host setup | Git/CI hook chaining, ignored targets, host excludes; reused `src/compliance-setup.mjs`, new `src/install-host.mjs`, `tests/install-host.test.mjs` | Managed renderer; safe project writer; package manager local executable; config worktrees dir | Bare/Husky/lefthook preserve existing steps; unrelated agent hooks preserved; GitHub/GitLab strict merge-base audit; narrow opt-in ignore/exclude patches |
| B4 Migrations | Pure config/data upgrades; `src/migrations.mjs`, `src/migrations/**`, `tests/migrations.test.mjs`, `tests/fixtures/upgrades/**` | A config schema, roadmap/graph schemas; C future registration seam | Sequential N→N+1, future schemas refuse safely, repeated upgrade stable, owner config retained, frozen prior migration fixtures |
| B5 Hook context | Fast agent context and optional denial; `src/hook-check.mjs`, `tests/hook-check.test.mjs` | A config and cached graph, block ownership/dependents, enforcement setting, normalized tool events | Read/edit/create/commit cases, usedBy context, guide silence/success, intentional block denial, corrupt state/timeout fail open within 500 ms |
| B6 Audit rules | Stable named hard gates and ratchets; reused `src/compliance.mjs`, `src/compliance-git.mjs`, new `src/audit-rules.mjs`, `tests/compliance.test.mjs`, `tests/audit-rules.test.mjs` | A scan/config/manifest/view contracts; B1 expected managed state; B4 schema checks; C drift callback | Each rule pass/fail fixture, correct staged/range content, baseline downward ratchet, scoped justified exceptions, preserved receipt tamper rejection |
| B7 Shared integration | Install/upgrade/uninstall orchestration, CLI/package/docs; `src/install.mjs`, `src/project-integration.mjs`, `bin/block-beaver.mjs`, `package.json`, lockfile, `src/block-map.mjs`, `src/workflow.mjs`, `templates/block-workflow.md`, README/CONTRIBUTING/CHANGELOG and relevant docs | All previous slices; one owner for shared files and existing tests | Disposable full onboarding, regeneration, legacy init/start compatibility, CLI JSON/error behavior, uninstallation preserves owner state |
| B8 End-to-end gates | Golden installs/upgrades, release harness; `tests/install.test.mjs`, `tests/upgrade.test.mjs`, `tests/uninstall.test.mjs`, `scripts/live-editor-battle.mjs`, `docs/LIVE_EDITOR_BATTLE.md`, `.github/actions/block-beaver/**`, `.github/workflows/release.yml` | Public CLI after integration; manifests and render expectations from B1; package publish policy from B7 | Installation matrix, prior-version golden equality, all eight live cases, action smoke fixture, package contents check, publication configuration reviewed |

B1–B6 can work concurrently after A interfaces land. B7 integrates their exported functions as each lands; B8 can prepare fixtures and harness adaptation in parallel, then runs against the integrated CLI. Assign an independent reviewer after the combined diff, preferably Claude Sonnet high when authenticated/model verified; otherwise disclose GPT same-family fallback. A failing gate stays a recorded blocker, not a skipped success.

## Shared API proposal

These names are proposed contracts, resolved with A's owner before B code starts.

```js
planManagedFiles({ root, version, config, agents, operation, force })
// -> { files: [{ path, before, content, kind }], conflicts, diagnostics }
detectPackageManager(root)
// -> { id, lockfile, executable, diagnostics }
planPackageChange(root, { manager, version, operation })
// -> { commands, files, diagnostics }; execution delegated to injected runner
planHostSetup(root, { config, agents, fixIgnores, fixExcludes, operation })
// -> { files, hooks, diagnostics }; no file writes
migrateDocument(kind, value, targetVersion)
// -> { value, applied }; pure ordered registry, no original mutation
hookCheck(event, { root, deadlineMs: 500 })
// -> { decision: 'allow' | 'deny', context?, reason?, diagnostics? }
evaluateAuditRules(context)
// -> [{ id, pass, findings: [{ path?, message, remediation? }] }]
installProject(root, options)
upgradeProject(root, options)
uninstallProject(root, options)
// -> { changed, diff, diagnostics, conflicts, commands, ... }
```

The installer builds and validates every file plan before applying writes. Reuse safe compare-before-write/symlink protections in `project-files.mjs`; a command failure is reported accurately and no successful complete install is claimed. Package-manager commands are executed with argument arrays and no shell interpolation. Lockfile changes happen via the host package manager. Detection from ambiguous multiple lockfiles must not silently choose a different package manager.

Use `codex` as the public agent id, mapping legacy editor `agents` to AGENTS.md. Explicit `--agents` wins; otherwise detect installed agent files/directories, with documented behavior for an empty detection. Config owner entries survive install/upgrade. Managed sections record their prior rendered hash and preserve separate local sections. JSON hook entries have stable Block Beaver ids, and uninstall removes only those entries. Publish the exact hook event envelopes after verifying current official agent specifications; tools' unknown envelopes fail open.

Audit preserves `{pass,mode,base,files,invalidEvidence}` and adds `rules`. Rule ids: managed-current, config-valid, manifest-valid, view-fresh, undeclared-link, coverage-ratchet, resolution-ratchet, exception-valid; reserve family-drift for C. Retain reviewed-content as an additional stable rule for the reused receipts. `--strict` activates resolution ratchet and strict A scan errors. Audit uses the selected working/index/HEAD snapshot consistently. Freshness comparison renders deterministically without calling an auditing update path. View module exports are included in declared generated outputs.

Ratchet exceptions carry schemaVersion/type/reason/paths and bounded rule allowance. Verified receipt exceptions keep their existing exact content binding. Missing paths are invalid; exceptions cannot erase other rule failures. Baseline schema includes coverage and unresolved-import counts and a future opt-in lint counts object for C. Baseline updates never happen implicitly during audit.

Upgrade migrations run config then managed plans then versioned data. Reject unsupported future schema and migration gaps before writes. Existing shipped migrations remain immutable. No migration is required merely to increment a package patch version. Installed version mismatch emits the documented upgrade command. Uninstall removes the exact devDependency, managed content, managed skill files and hooks; `.blocks/` deletion requires explicit owner confirmation or an explicit CLI confirmation option, with default preservation.

## Verification matrix

| Area | Required cases |
| --- | --- |
| Install | pnpm/npm/yarn/bun × bare/Husky/lefthook; run twice and compare bytes/status; explicit and detected agents; no-package and conflicting-lockfile diagnostics |
| Owner state | Agent prose/local sections preserved; other JSON hooks retained; owner CI/hook conflicts reported; symlink/hardlink/changed-during-write refusal |
| Managed current | Fresh install passes; changed package version fails; missing/old managed content fails; owner-edited managed section blocks upgrade; force replaces only managed bytes |
| Upgrades | Golden earlier-version installs become equal to fresh current install; second upgrade no-op; config/graph/roadmap migration fixtures; unsupported future schema leaves files unchanged |
| Host diagnostics | Ignored .claude/ and .codex/ targets reported; narrow --fix-ignores retains local settings/worktrees ignores; tsconfig/lint/test/formatter pickup detected; --fix-excludes preserves owner formatting/config keys or reports unsupported format |
| Hook check | Owning block + dependencies/dependents/usedBy; out-of-block create reminder; git commit reminder; guide default; block edit denial; unknown event/corrupt graph/error/500 ms deadline fails open |
| Audit | Every named rule has independent pass/fail fixture; staged content differs from working content; full ancestor range; receipt evidence staging and hash/mode tampering; stale graph/view/module; baseline reductions pass, unexplained increases fail |
| Uninstall | Preserve unmanaged prose/local sections/other hooks; remove exact pin with manager; leave .blocks default; explicit deletion in disposable repo only; repeated uninstall no-op |
| Release | npm pack file inspection and clean tarball CLI install; npm run check; CI Node 22/24/26 and platform matrix; Codex/Claude normal/bypass/failed/drift each casePass true with logs |

Use disposable Git repositories for writing fixtures. Stub package command runners in focused tests; at least one real clean-tarball installation verifies distribution without relying on network publication. Fixture families/manifests can test the future callback seam, while C implementation remains separate.

## Release gate and known environment limitations

Inspection of the reused branch: 10/11 focused compliance/integration tests passed. Live map test could not bind 127.0.0.1 inside this sandbox (`listen EPERM`); rerun in an approved listener environment. Codex 0.159.3 is authenticated, but a minimal actual read-only invocation failed before a model turn with `failed to initialize in-process app-server client: Operation not permitted`. Claude 2.1.286 meets the version requirement but is unauthenticated. These are external execution/setup prerequisites, not product changes. Do not change credentials or upgrade CLIs as part of B.

Existing release publishes GitHub releases and package is private. B prepares npm distribution and release configuration; actual publication follows the user-authorized release boundary after checks. Live CLI failures/timeouts/permission failures are failed or blocked evidence, never passing gates. Record model identity, actual CLI arguments, scenario result and log paths. Update the Claude harness to the AGENTS.md unattended policy without permission-bypass flags; verify both CLIs support selected flags before use.

## Completion record

- [x] Inspect design B and existing compliance implementation.
- [x] Verify focused reused tests and actual Codex launch feasibility.
- [x] Define file owners, shared APIs and acceptance matrix before implementation.
- [ ] A gate accepted and exact API names recorded.
- [ ] Reuse patches integrated by shared owner.
- [ ] B1–B6 implementation and focused checks complete.
- [ ] B7 orchestration, installed workflow and docs complete.
- [ ] Golden/onboarding/uninstall and package gates complete.
- [ ] Independent combined review complete; fallback disclosed if necessary.
- [ ] CI matrix and eight live editor cases pass.
- [ ] Release 0.3.0 readiness recorded; C gate may begin.
