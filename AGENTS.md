# Agent guidance

This file covers general collaboration in the Block Beaver repository. Task-specific requirements belong in the user's request or the relevant task document.

## Orchestration

- Use **gpt-6.1-sol at medium effort** as the default orchestrator for software work. It owns task boundaries, integration, and the final review.
- Delegate automatically when bounded work improves speed, quality, or available capacity, unless the user asks otherwise. Parallelize independent work. Assign one owner to each file or tightly coupled subsystem, agree on shared interfaces first, and integrate dependent work after its prerequisites land.
- Up to 16 workers may run on this machine, counting Codex subagents and Claude CLI processes together; account for the primary agent separately. Use only the slots that have independent, useful work. Workers must not launch additional agents independently.
- Give each worker a purpose, owned files, shared interfaces, dependencies, acceptance checks, and required report covering changes, verification, findings, and remaining issues. Keep a single integration owner for files that many tasks would otherwise edit.
- For independent review, assign a separate worker from the other model family when available: Claude reviews GPT-authored work, and GPT reviews Claude-authored work. The reviewer inspects the requirements, diff, and verification evidence directly and reports its own findings. Choose effort for review difficulty; higher effort does not make a review more independent. If the other family is unavailable, disclose the same-family fallback.
- Treat model comparisons, including the [Artificial Analysis leaderboard](https://artificialanalysis.ai/leaderboards/models), as routing guidance, not proof that a particular model will succeed. Escalate based on the task and observed results.

## Default worker roster

| Model | Effort | Intended assignment |
| --- | --- | --- |
| gpt-6-luna | low | Mechanical inspection, repository search, and simple classification |
| gpt-6-luna | medium | Routine summaries, documentation upkeep, test interpretation, and small well-defined edits |
| gpt-6.1-sol | medium | Default delegated implementation, focused tests, bug fixes, and code review |
| gpt-6.1-sol | xhigh | Difficult coding, deep debugging, and demanding review of Claude-authored changes |
| Claude Sonnet 5.5 | medium | Fast, straightforward implementation, documentation, and routine fixes with clear checks |
| Claude Sonnet 5.5 | high | Routine Claude implementation, bounded debugging, edge cases, and focused review |
| Claude Opus 5.5 | medium | Ambiguous investigation, design tradeoffs, and difficult review |
| Claude Opus 5.5 | xhigh | Exceptional debugging, architecture, or consequential review |

Luna medium remains the default for small, clear non-code tasks. Use Sol medium for routine implementation and Sonnet high as the routine Claude alternative; choose Sonnet medium when the task is straightforward and speed matters. Share suitable assignments based on task fit, available capacity, and observed results, with no fixed percentage. Use Opus medium for ambiguity, design, and difficult review. Escalate difficult coding to Sol xhigh and exceptional reasoning to Opus xhigh; record a brief reason when selecting either. GPT models and efforts outside this roster require explicit owner authorization. The primary model selected in Codex is unaffected.

These placements are routing judgments based on Artificial Analysis's 2026-10-01 quality, response-time, and cost measurements; see the [research record](docs/tasks/claude-cli-workers.md#research-basis--2026-10-01). Its [coding research](https://artificialanalysis.ai/articles/gpt-6-1-sol-replaces-gpt-6-sol-after-just-7-days-with-near-astra-intelligence/) found Sol xhigh outperforming max, supporting one GPT coding escalation. Benchmark API costs are not subscription charges, and response measurements are not full CLI task duration. Revisit the placements when measured results or local acceptance checks change.

## Claude CLI workers

This routing policy applies only to Block Beaver's development repository. It is not installed into projects using Block Beaver. See the [CLI reference](https://code.claude.com/docs/en/cli-reference), [model configuration](https://code.claude.com/docs/en/model-config), and [permission rules](https://code.claude.com/docs/en/permissions).

### Preflight and handoff

- Check `command -v claude`, `claude --version`, and `claude auth status` before dispatch. Require Claude Code 2.1.284 or newer for the full roster and an authenticated account with access to the selected model. Verify model access with a minimal `-p --tools "" --disallowedTools "mcp__*" --output-format json` request using the selected model and effort before assigning repository work. Inspect errors and result metadata for actual model use or fallback.
- If the CLI, authentication, model access, or required permissions are unavailable, report the reason and route the assignment to the appropriate GPT worker. Do not silently substitute another Claude model. CLI upgrades and login are separate setup work.
- The orchestrator creates and manages an isolated Git worktree for each implementation worker and supplies its committed base plus any required current changes. Do not assume a new worktree includes uncommitted changes from the main checkout. Review workers may inspect the designated checkout with reading tools only.
- Write the assignment to a task file and supply the current `AGENTS.md` explicitly through `--append-system-prompt-file`; do not rely on Claude discovering it. Include the assigned paths, checks, dependencies, output requirements, and the instruction not to delegate, commit, merge, or publish.
- Use `dontAsk` with explicit tool allowances for unattended calls. Omit permission-bypass flags. Permit only the editing tools, owned file paths, and verification commands needed by the assignment. Existing settings can also grant permissions, so inspect them when setting up a worker; the examples do not establish a sandbox.

### Invocation patterns

Run these examples in Bash or Zsh. Set the paths before changing directories: `task_file` names the assignment, `guidance_file` names the current guidance, and `worker_dir` names the designated checkout or implementation worktree. Paths are supplied by the orchestrator for each assignment.

```sh
task_file=/absolute/path/to/assignment.txt
guidance_file=/absolute/path/to/current/AGENTS.md
worker_dir=/absolute/path/to/worker-checkout
cd "$worker_dir"

# Review worker: reading tools only, with MCP tools disabled.
worker_args=(
  --output-format json
  --append-system-prompt-file "$guidance_file"
  --permission-mode dontAsk
  --tools "Read,Glob,Grep"
  --allowedTools "Read,Glob,Grep"
  --disallowedTools "mcp__*"
)

# Select and run one profile for the assignment.
claude -p --model claude-sonnet-5-5 --effort medium "${worker_args[@]}" < "$task_file"
claude -p --model claude-sonnet-5-5 --effort high "${worker_args[@]}" < "$task_file"
claude -p --model claude-opus-5-5 --effort medium "${worker_args[@]}" < "$task_file"
claude -p --model claude-opus-5-5 --effort xhigh "${worker_args[@]}" < "$task_file"
```

For implementation, replace `worker_args` with the following in the isolated worktree, then run one of the same model commands. Replace `src/owned.mjs` and `npm run check` with the assignment's actual owned paths and approved checks; list each additional allowance explicitly. Scope Write permissions to the same paths as Edit permissions.

```sh
worker_args=(
  --output-format json
  --append-system-prompt-file "$guidance_file"
  --permission-mode dontAsk
  --tools "Read,Glob,Grep,Edit,Write,Bash"
  --allowedTools "Read,Glob,Grep,Edit(./src/owned.mjs),Write(./src/owned.mjs),Bash(npm run check)"
  --disallowedTools "mcp__*"
)
```

Capture the JSON output and exit status with the orchestrator's process runner. Inspect both for errors, permission denials, incomplete work, and model fallback; a successful process exit alone does not establish acceptance. The orchestrator checks the full worktree diff against the file boundary, reviews the worker's report, and verifies the assigned checks before integrating. Workers do not commit, merge, or publish.

## Repository work

- Use [Working in blocks](docs/BLOCK_WORKFLOW.md) as the standing reference for feature boundaries, implementation, verification, and review. Record the purpose, owned files, connections, and acceptance checks for meaningful changes in the task document or pull request before editing; update that record if the boundary changes.
- Changes to the user workflow must also update `templates/block-workflow.md` and the installed editor guidance in `src/project-integration.mjs`. Verify onboarding and view regeneration in a disposable target repository; instructions in this development repository alone do not integrate other projects.
- For a change that adds or changes a declared block, update the authoritative manifest or registry in the target repository as part of the reviewed slice. After integration, rescan the target and verify the block appears with the right files and connections in the local console's Blocks view. Do not hard-code individual blocks into HTML.
- When a change affects how blocks are presented, update the local console's `index.html`, `src/app.js`, and `styles.css` as needed, then verify the Blocks view with a representative manifest. `docs/index.html` is the public landing page, not the interactive Blocks view. Record in the review which view was checked and what appeared.
- Read the relevant code and task document before editing. Keep changes within the requested scope and preserve existing public behavior unless the task requires a change.
- Use disposable repositories or fixtures for workflow experiments. Do not put source or machine-specific absolute paths from another project into Block Beaver.
- Have one agent integrate shared-file changes and inspect the resulting diff. Run the checks needed for the change and report any checks that could not be completed.

## graphify

When the user types `/graphify`, load and apply the `graphify` skill before other task work.
