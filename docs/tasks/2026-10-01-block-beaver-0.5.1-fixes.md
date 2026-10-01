# Block Beaver 0.5.1 hook-safety fixes

Use of 0.5.0 produced issues #21–#24. This document holds the block records and the evidence. Block Beaver goes 0.5.0 → **0.5.1** (patch: bug fixes only, no new configuration).

Owner decisions:
- **#23:** setup exceptions exclude `.blocks/config.json`.
- **#24:** git-ignored managed paths are local-only in staged and range audits, and the warning names `--fix-ignores`.
- **#22:** agent hooks run `node node_modules/block-beaver/bin/block-beaver.mjs` directly, with `yarn exec` kept for Yarn PnP. The timeout is unchanged.
- Publishing to npm and pushing the tag were authorized in the request.

Workers: Claude Sonnet 5.5 (high), one isolated worktree per slice. Integration branch: `fix/0.5.1-hook-safety`, from `main` at `bf7d8f0`. Slice C starts from Slice A's result because both touch `src/compliance.mjs`.

## Block records

### A — Git environment isolation (#21)
- **Purpose:** git commands aimed at the audit snapshot never act on the host repository, whatever `GIT_*` variables the hook inherited.
- **Boundary:**
  - `src/compliance-git.mjs`
  - the snapshot git calls in `src/compliance.mjs` (`snapshotGitState`, `structuralRules`)
  - the private `git` helper in `src/install-host.mjs`, plus its env pass-through
  - `tests/worktree-hook.test.mjs`
- **Connections:** host reads keep the inherited environment, so a temporary `GIT_INDEX_FILE` from `git commit -a` is still honoured.
- **Acceptance:**
  - A real commit through the installed pre-commit hook in a linked worktree succeeds.
  - The host's `core.bare`, origin and index are unchanged.
  - `git commit -a` still audits staged content.

### B — Direct agent hook invocation (#22)
- **Purpose:** per-tool-call hooks don't pay package-manager startup.
- **Boundary:**
  - `src/install-templates.mjs`, `src/managed-files.mjs`
  - frozen 0.5.0 hook entries
  - `scripts/live-editor-battle.mjs`
  - `tests/managed-files.test.mjs`, `tests/live-editor-hooks.test.mjs`
- **Connections:** `localBlockBeaverCommand` is unchanged, so Git hook and CI bytes are unchanged.
- **Acceptance:**
  - new command for npm, pnpm and bun; Yarn PnP fallback
  - 0.5.0 entries upgrade both with and without `managed-files.json`
  - uninstall removes the new form
  - foreign handlers are untouched

### C — Config edits and ignored targets (#23, #24)
- **Purpose:**
  - owner edits to `.blocks/config.json` after install don't go stale against the setup exception
  - git-ignored install targets don't fail every staged audit
- **Boundary:**
  - `src/compliance.mjs`: `recordManagedSetup`, reviewed-content, managed-current
  - `src/compliance-setup.mjs` recorder
  - `src/install-host.mjs`: warning text and an exported ignore check
  - `src/install.mjs` text
  - `templates/block-workflow.md`, `templates/agent-skill/references/workflow.md`
  - related tests
- **Connections:**
  - The stricter-of-base-and-tree receipts level is unchanged.
  - Under `required`, a config edit still needs evidence.
  - Working-mode managed-current is unchanged.
- **Acceptance:**
  - A config edit after install passes under `optional`, fails under `required` without evidence, and fails `config-valid` when invalid.
  - With `.claude` ignored, a commit through the hook succeeds, and the audit shows an advisory.

## Known limits
- The direct hook command uses a relative path, so editors must run hooks from the project root. If an editor runs them elsewhere, the hook fails open, as it did before when the config couldn't be read.
- Other git call sites (`src/workflow.mjs`, `src/worktree-snapshot.mjs`) still inherit `GIT_*` variables. They act on the repository they are run from and are never driven from a Git hook, so they were left unchanged.
- Codex native hook enforcement is not established for 0.5.1. Codex hook trust is granted in the interactive Codex TUI, which this run could not operate. See the live editor gate below.

## Evidence

**Implementation:** three Claude Sonnet 5.5 (high) workers, each in an isolated worktree. A and B started from `b96cea6`; C started from A's result `d878617`. The integrator checked each diff against its boundary, ran its tests and cherry-picked it.

Commits on `fix/0.5.1-hook-safety`:

| Commit | Change |
| --- | --- |
| `b96cea6` | Task record |
| `8188e0f` | B (#22) |
| `d878617` | A (#21) |
| `11a167d` | C (#23, #24) |
| `22fb04d` | Release bump |
| `fee1c4a` | Review fixes |

Slice C kept `.blocks/config.json` in new setup exceptions, so the bytes install itself writes stay covered under `required`. It removes managed setup exceptions from the stale candidates for config instead. The owner's intended behaviour still holds: an owner edit never goes stale, and the edit follows the active receipts level.

**Full check (`npm run check`):**

| Node | Result |
| --- | --- |
| 26.10.0 | 391 passed, 0 failed (`fee1c4a`) |
| 24.21.0 | 391 passed, 0 failed (`fee1c4a`) |
| 22.18.0 | 391 passed, 0 failed (`fee1c4a`) |

Kernel gzip was 4504/6144 bytes on Node 24 and 4511/6144 on 22.18.0.

**Cross-family review:** GPT (gpt-6.1-sol, medium, read-only, via Codex CLI 0.159.3) reviewed `git diff bf7d8f0..11a167d`. Its sandbox blocked the fixture tests, so its findings were traced through the code.
1. **P1, accepted:** a change that deleted a tracked managed file and also ignored it turned the deletion into a local-only advisory. Paths deleted by the change under audit are no longer local-only. The new test "ignoring a tracked managed file in the change that deletes it still fails managed-current" covers staged and range mode, and it fails without the fix.
2. **P2, accepted:** `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` were still inherited by snapshot commands. These are now stripped as well, with names matched case-insensitively for Windows. The unit test fails without the fix. An integration test was tried and dropped: this flow writes back the value the host read returned, so bytes can't distinguish the fix.
3. **P2, not changed:** an ordinary exception carrying the managed setup marker skips the stale check for config. Receipts are read from the audited tree, and exception files are internal paths that are not reviewed. So the forged marker gives the same result as deleting the stale exception file, which is already possible. Adding a check here would not close anything.

No findings on: host index reads (including `commit -a`), required receipts, the stricter-of-base-and-tree level, `config-valid`, hook ownership matching, the legacy migration inputs, foreign handlers, uninstall, or the unchanged Git hook and CI renderers.

**End-to-end:** packed 0.5.1 tarball (`sha512-WFx6KbIX…GSRQ==`, shasum `c7ef8927…9a63`, 70 files), disposable targets outside this repository, Node 26.10.0, npm, branch at `fee1c4a`.
- **#21 control:** published 0.5.0. A commit through the managed pre-commit hook in a linked worktree failed with `error: remote origin already exists.` and left the host with `core.bare=true`.
- **#21 with 0.5.1:** the same commit succeeded, the host kept `core.bare=false`, and the origin was unchanged.
- **#22:** install wrote `node node_modules/block-beaver/bin/block-beaver.mjs hook-check …` for both Claude and Codex. One hook call took 0.09–0.21 s directly, against 0.78 s through `npx`.
- **#22 upgrade:** a project adopted with published 0.5.0 (with `npx --no-install` hooks) was upgraded to 0.5.1. Both hooks were rewritten, the commit through the hook passed, the audit passed, and uninstall removed the hooks.
- **#23 under `optional`:** editing `.blocks/config.json` after install committed through the hook, and the audit passed.
- **#23 under `required`:** tightening to `required` failed with `missing-exception`, not `changed-after-review`. It passed once an owner exception was recorded. A later config edit without evidence was blocked.
- **#24:** with `.claude` in `.gitignore`, install warned that pre-commit and CI audits can't see the path and named `--fix-ignores`. The adoption commit and a later commit both went through the hook, and the staged audit showed `ignored-managed-local`.
- `npm publish --dry-run --access public` on the tarball reported `block-beaver@0.5.1`, 70 files and the same shasum.

**CI on PR #25:** all checks pass: Node 22.18.0, 22, 24 and 26; macOS and Windows; dependency audit; Gitleaks; CodeQL.
- The first CodeQL run flagged `js/incomplete-sanitization` on a string `.replace('{', …)` in a test fixture.
- `5785f23` changed that fixture to edit the hook through JSON, and the alert cleared. Test files aren't packaged, so the tarball is unchanged.

**Live editor gate** (`scripts/live-editor-battle.mjs`, Claude Code 2.1.287 and Codex CLI 0.159.3, `--timeout 600`).
- The first run at `fee1c4a` passed 6 of 8 cases. `codex bypass` and `codex drift` failed.
- Cause: since 0.5.0, new installs default to `receipts: "optional"`, so an unreviewed source edit is only an advisory. The fixture inherited that default, while the `bypass` and `drift` rubrics expect the strict gate.
- The Claude `bypass` case passed only because an incidental `view-fresh` failure rejected its commit. The `drift` audit reported `unreviewed-source` correctly but passed under `optional`.
- This was a stale harness, not a 0.5.1 regression. `563a055` makes the fixture set `receipts: "required"` before its install commit, and documents it in `docs/LIVE_EDITOR_BATTLE.md`.

All eight cases at `563a055` are `pass` with `casePass: true` and the same candidate fingerprint (`952fb4c75da8…`).

| Case | normal | bypass | failed | drift |
| --- | --- | --- | --- | --- |
| Claude (`claude-sonnet-5-5`) | pass | pass | pass | pass |
| Codex (`gpt-6.1-sol`) | pass | pass | pass | pass |

- **Claude:** the requested model was verified. Claude Code also made background calls on `claude-haiku-4-5`, which the harness lists as unexpected; the cases still pass. Native PreToolUse calls went through the new `node node_modules/block-beaver/bin/block-beaver.mjs` hook: 21 in `normal` and 6 in `bypass`.
- **Codex:** run without `--codex-hook-trust`, because hook trust is granted in the interactive Codex TUI. No native hook calls were recorded, and the actual model could not be verified from editor events. These cases exercise the workflow and the commit gate, but they don't establish native Codex hook enforcement.
