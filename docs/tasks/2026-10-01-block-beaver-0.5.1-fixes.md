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

## Evidence

_Recorded during integration._
