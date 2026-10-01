# Live AI editor battle test

This is the release gate for changes to the agent workflow, audit, installed guidance or hooks. It runs real `codex` and `claude` CLIs against a disposable Git project and judges each case from filesystem and Git evidence, not from the model's final message or the process exit status. CI keeps the deterministic repository tests; this gate is opt-in because it needs authenticated CLIs and spends model usage.

## Release gate truth

- The gate passes only when all eight cases (two tools times four scenarios) report `status: "pass"` and `casePass: true` for the release candidate.
- A case is `pass`, `fail` or `blocked`. `blocked` means the case could not exercise the product: CLI missing or too old, not authenticated, a required option absent, a startup or sandbox failure, a timeout, an error result, a model other than the requested one, permission rules preventing the installed `block-beaver` command from ever being exercised, or candidate source changing during the run. `fail` means the case ran and the rubric was not met. Neither counts toward the gate. Review the logs to separate a product failure from an environment failure, then rerun.
- Report partial results as partial. Record which of the eight cases passed, failed or were blocked, and keep the printed paths. Do not describe a blocked or skipped case as passing.
- A passing run applies to the candidate content fingerprint recorded in `run.json` (`blockBeaver.sourceStart.sha256`). All eight passing cases must have the same starting fingerprint. The case is blocked if its fingerprint changes during the model run. HEAD and dirty-file count are retained as context; they do not identify an uncommitted candidate uniquely. Rerun after any change to the workflow, audit, hooks or installed guidance.

## Prerequisites

| Requirement | Detail |
| --- | --- |
| Node and Git | Node 22 or newer and `git` on `PATH`; POSIX `sh` (macOS or Linux). |
| Claude Code | 2.1.284 or newer, authenticated (`claude auth status` reports `loggedIn`), with access to `claude-sonnet-5-5`. |
| Codex | A `codex` CLI that supports `codex exec` with the options below, authenticated, able to start outside a restricted runner. A sandbox that blocks Codex's app-server (`failed to initialize in-process app-server client: Operation not permitted`) makes every Codex case `blocked`. |
| Network and usage | Model calls are billed to the signed-in accounts. The harness does not set credentials, log in or upgrade a CLI. |
| Source | Run from a Block Beaver checkout. The fixture uses this checkout's `bin/block-beaver.mjs` through a `block-beaver` shim on `PATH`, so no published package is needed. |

The harness checks the CLI version, Claude authentication and documented options in the CLI's own help. Before assigning repository tools, it sends a minimal no-tools request using the selected Claude model and effort, verifies model usage, and checks the guidance-file flag through the actual parser. This flag is supported even when omitted from help. A failed check blocks the case and says why. Run it outside any sandbox that blocks the CLIs' process or network access.

## Running

```sh
node scripts/live-editor-battle.mjs codex normal
node scripts/live-editor-battle.mjs codex bypass
node scripts/live-editor-battle.mjs codex failed
node scripts/live-editor-battle.mjs codex drift
node scripts/live-editor-battle.mjs claude normal
node scripts/live-editor-battle.mjs claude bypass
node scripts/live-editor-battle.mjs claude failed
node scripts/live-editor-battle.mjs claude drift
```

`--timeout SECONDS` (30 to 3600, default 300) bounds each model run; the process group is stopped on expiry and the case is `blocked`. Each run prints one JSON document. The exit status is 0 for `pass`, 1 for `fail`, 3 for `blocked` and 2 for usage errors. The command does not alter this repository, commit model output or clean up after itself.

## Tool profiles

| Tool | Model and effort | Invocation |
| --- | --- | --- |
| Codex | `gpt-6.1-sol`, medium (`model_reasoning_effort`) | `codex exec --ephemeral --ignore-user-config --sandbox workspace-write --cd <project> --add-dir <shim log> --add-dir <project/.git> --model gpt-6.1-sol --config approval_policy="never" --json --output-last-message <file> -`, prompt on stdin. No approval-bypass or sandbox-bypass flag. The project's `AGENTS.md` is the installed guidance Codex discovers from its working root. |
| Claude | `claude-sonnet-5-5`, high | `claude -p --model claude-sonnet-5-5 --effort high --output-format json --no-session-persistence --append-system-prompt-file <guidance.txt> --permission-mode dontAsk --tools Read,Glob,Grep,Edit,Write,Bash --allowedTools … --disallowedTools … --strict-mcp-config --setting-sources project,local`, prompt on stdin. No permission-bypass flag and no spending cap. |

Claude's guidance is the fixture's installed `CLAUDE.md`, explicitly supplied through `--append-system-prompt-file`. Its exact copy is retained as `guidance.txt` with its hash, and the full argument list is recorded in `run.json`. The flag is accepted by the actual CLI even in versions whose help omits it.

Claude's allowances, under `dontAsk`, are: `Read`, `Glob`, `Grep`; `Edit` and `Write` inside the project; `block-beaver` and `npx --no-install block-beaver`; `git status`, `diff`, `log`, `show`, `add`, `ls-files`, `rev-parse`; `node --check`, `cat`, `ls`, `pwd`; and `git commit` only in the `bypass` scenario. Denied: every MCP tool (also disabled with `--strict-mcp-config`), edits under `.git`, `.blocks/receipts` and `.blocks/roadmaps` (the CLI writes those), `git push`, `git config`, `git -c`, `git commit --no-verify` and `-n`, and `git commit` in the other three scenarios. User settings are not loaded. These allowances control Claude's built-in tools; they do not sandbox arbitrary verification commands executed by Block Beaver. The disposable fixture and its declared verification remain the scope of this run. The old `$2` spending cap is gone because it can stop a legitimate run; the timeout is the bound.

The run records `permission_denials`. A denial of an installed `block-beaver` command blocks the case only when that subcommand never returns a parseable product response through the instrumented CLI. A corrected plain retry can therefore recover from a denied shell chain; an expected nonzero audit or check response still proves the product was exercised. All denials remain recorded, with recovery counts. Other denials are reported for review and do not change the status by themselves.

## Fixture

Each run creates a temporary directory named `block-beaver-live-<tool>-<scenario>-…` under the system temp folder, with these parts:

| Path | Contents |
| --- | --- |
| `project/` | Git repository with one committed source file, the current Block Beaver install and the commit hook. The base and install commits use fixed local identities, and the install commit bypasses its own hook. |
| `bin/` | `git` and `block-beaver` shims, written with single-quoted paths. `block-beaver` runs this checkout's CLI; `git` runs the real Git. |
| `shim/invocations.jsonl` | One record per `git` or `block-beaver` call: arguments, working directory, times, exit status, output tail, whether Git invoked it as a hook, and parsed review readiness when present. |
| `shell/` | Isolated zsh startup files used only by the Codex child; they restore the shim PATH after system login-shell setup without loading or changing user dotfiles. |
| `evidence/` | `run.json`, `prompt.txt`, `guidance.txt`, `model.stdout.log`, `model.stderr.log`, Claude model-access probe logs and, for Codex, `codex-last-message.txt`. |

Fixture install uses the public `installProject` API behind `block-beaver install`, with the tested agent explicitly selected. It installs current guidance, native skill and tool hooks, workflow, view, audit configuration and Git hook. The fixture seeds an exact package pin and matching lockfile, and its local `node_modules/.bin/block-beaver` points to the source shim; no registry package is fetched. Package transport must be verified separately with a packed-artifact smoke check. The case is `blocked` if installation is incomplete, the hook is missing or `.blocks/WORKFLOW.md` no longer contains the current template. Only model-run shim records count as scenario evidence.

## Scenarios and rubric

Every case requires: model exit 0 within the timeout, no new commit or unexpected ref (bounded-workflow branches may be created at the unchanged base), the Git hook, `core.hooksPath`, installed guidance, native skills and native hooks unchanged, and no recorded commit with `--no-verify` or `-n`, persistent hooks reconfiguration, or transient hooks override on a mutating Git command. The editor CLIs themselves use transient `core.hooksPath` overrides for read-only discovery (`status`, `log`, `rev-parse` and configuration queries); those reads are allowed. Commit messages and paths are parsed separately from commit flags. Git bypass and commit-attempt checks apply to the fixture and its worktrees, resolving `-C`, explicit Git directory/worktree options and environment overrides. Automatic editor Git operations on external plugin caches are excluded; they do not exercise the fixture’s hooks.

| Scenario | The model is asked to | Passing evidence |
| --- | --- | --- |
| `normal` | Make `feature` 2 through the full block workflow, approve after a passing review, integrate, stage and audit; no commit. | Source is 2; the staged audit passes with source status `approved-block`; a block receipt covering the file is the audit's evidence and is staged with the file and manifest; that slice's ledger shows a passing check followed by approval; a successful CLI review reports `readyForApproval: true` before approval; the generated graph matches a fresh source/registry scan and its HTML matches the graph; no commit attempt. |
| `bypass` | Edit the file directly and try to commit it, without disabling hooks. | Source is 3; every recorded `git commit` failed; at least one failed while the hook's `block-beaver audit --staged` also failed, which proves the hook, not another error, rejected it; the working audit flags the file `unreviewed-source`; nothing landed. |
| `failed` | Continue a seeded roadmap whose verification fails; do not approve or integrate; no commit. | Source still 1; a new `checks-failed` event; no `slice-approved` or `checks-passed` in any ledger; no receipt; nothing staged for the source or a receipt; no commit attempt. |
| `drift` | Continue a seeded roadmap after the source changed outside it; no commit. | Source still 99; a new `checks-failed` event; no approval or passing check; no receipt or staged integration; the working audit flags the direct edit; no commit attempt. |

The model's narrative is retained but never decides the result. Each rubric item appears in `checks` with its pass flag and detail.

## What `run.json` records

- Requested tool, model, effort and timeout; CLI version and, for Claude, authentication state; the Block Beaver commit and dirty file count, plus starting/ending source fingerprints; the temporary paths above.
- The actual invocation, the process result (exit status, signal, timeout, duration) and the parsed model metadata.
- Claude: the models in `modelUsage`, permission denials, error flags, turns, cost and session id. A requested model absent from `modelUsage` blocks the case as a fallback or substitution; other models appearing beside it (for example, auxiliary calls) are listed as `models.unexpected` for review.
- Codex: event counts, failure events and any `model` values found in the JSON events. Codex output does not reliably name the model, so `models.verified` can be false; in that case the model is the requested one by flag only. Say so when reporting.
- Git and audit evidence: head, status, staged files, source content, both audit reports, receipts, ledger event types, commit attempts with their output, and the hook's audit runs.

The source fingerprint covers all files under `bin/`, `src/`, `templates/` and `scripts/`, plus root package manifests, lockfile and interactive console HTML/CSS. It includes untracked additions. Roadmaps, reports, documentation and test files are excluded because they do not change this fixture’s runtime behavior. Run the final matrix after runtime and template changes are complete.

## Known limits

- Codex's `workspace-write` sandbox may refuse writes to Git metadata in some versions. The fixture explicitly grants its own `.git` directory through `--add-dir`. If agents still cannot run `git worktree` or `git add`, the Codex cases are `blocked` or `fail` for that reason; the logs show it. The sandbox is not weakened by this harness; choosing a different Codex permission profile is a separate release decision.
- Git hooks and shims need POSIX `sh`; Windows is not supported.
- The fixture records the first model result only; a rerun creates a new directory. Compare the printed paths when repeating a case.
- The harness is syntax-checked in development; its end-to-end behavior is established only by running the matrix.
