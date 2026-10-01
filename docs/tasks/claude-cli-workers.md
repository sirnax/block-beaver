# Claude CLI workers

## Change record

| Field | Record |
| --- | --- |
| Purpose | Share development assignments across GPT and Claude with a compact roster, cross-family review, and one integration owner. |
| Boundary | `AGENTS.md` and this task record. Keep Luna low/medium, Sol medium/xhigh, Sonnet medium/high, and Opus medium/xhigh; remove overlapping routes using the requested research. |
| Connections | Existing orchestration rules; Claude Code CLI model, effort, tool permissions, and JSON output. Policy is local to this development repository. |
| Acceptance | Automatic task-based delegation; eight worker profiles; Sol xhigh handles difficult coding and Opus xhigh exceptional reasoning; review uses a separate worker from the other model family when available; isolated implementation worktrees; explicit guidance and assignment input; unattended tool allowances; shared worker limit; preflight and GPT fallback. Review the diff; existing application checks passed before this prose-only routing revision. |

## Research basis — 2026-10-01

Snapshot from the [LLM leaderboard](https://artificialanalysis.ai/leaderboards/models). Time is its total-response measurement, not repository completion time; cost is its API benchmark cost per task, not Max subscription billing. Claude rows include default fallback.

| Retained profile | Intelligence Index | API cost/task | Response seconds |
| --- | --- | --- | --- |
| Luna low | 22 | $0.0045 | 6.79 |
| Luna medium | 30 | $0.02 | Unreported |
| Sol 6.1 medium | 48 | $0.21 | 14.44 |
| Sol 6.1 xhigh | 51 | $0.39 | 117.46 |
| Sonnet 5.5 medium | 41 | $0.59 | 6.89 |
| Sonnet 5.5 high | 47 | $1.08 | 18.03 |
| Opus 5.5 medium | 51 | $1.34 | 32.20 |
| Opus 5.5 xhigh | 56 | $3.46 | 140.09 |

Routing is our inference from these tradeoffs. Retain Luna for cheap mechanical work, Sol medium for routine quality/cost, Sonnet for fast bounded work and provider capacity, and Opus for stronger general reasoning. Omit Luna high and Sol low/high/max to keep the roster compact. Opus max gains only two Index points over xhigh while response time rises from 140 to 722 seconds.

The [Sol release analysis](https://artificialanalysis.ai/articles/gpt-6-1-sol-replaces-gpt-6-sol-after-just-7-days-with-near-astra-intelligence/) specifically reports Sol xhigh outperforming max by three points on the Coding Agent Index. This supports retaining xhigh for difficult coding rather than removing every GPT escalation. It also supports using 6.1 Sol medium as the guidance's orchestration default, replacing the older Sol default without changing the user's selected primary model.

The [Sonnet release analysis](https://artificialanalysis.ai/articles/claude-sonnet-5-5) reports strong terminal performance at max, coupled with exceptionally high token usage. Do not transfer max-effort coding results to medium/high or claim universal equality with Sol. The [coding-agent methodology](https://artificialanalysis.ai/agents/coding-agents) distinguishes repository implementation, terminal use, and technical Q&A; use local checks to evaluate our assignments.

## Verification

- CLI preflight on 2026-10-01 outside the sandbox confirms Claude Code 2.1.286 and `loggedIn: true` via `claude.ai`. Earlier sandboxed checks showed stale version/authentication state; that did not reflect the user's terminal setup.
- Require Claude Code 2.1.284 or newer for the full roster. CLI upgrades and login are outside this change.
- Live smoke tests passed outside the sandbox using a disposable Git repository and a separate implementation worktree. Sonnet high independently audited both guidance files with reading tools and found no concrete stale-version issues or contradictions; the source checkout remained unchanged. Sonnet medium changed only the assigned fixture file and ran its approved check successfully. Opus medium and xhigh each passed a no-tool access request. All four returned the requested model in JSON metadata with no errors or permission denials.
- Both shell examples pass syntax checks in Bash and Zsh. All four explicit model/effort profiles, stdin assignment input, and appended guidance are present.
- `npm run check` passes all 50 tests when allowed to bind the local loopback server. The first sandboxed run passed 49 tests and failed the live-map test with `listen EPERM`; the rerun outside the sandbox passed.
- GPT modes outside the compact roster require owner authorization. Opus xhigh is available with a recorded reason. Higher effort is an escalation choice, not a measure of review independence. The only changed files are the local guidance and this record.
- The full-file audit confirms the orchestrator uses `gpt-6.1-sol`, the section is named "Default worker roster", all eight profiles agree with the research record, and no stale explicit-delegation requirement or blanket restriction on the retained Sol xhigh route remains. Historical model names in source URLs are preserved. Updated shell examples pass Bash/Zsh syntax checks, and `git diff --check` passes.

## References

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Model configuration](https://code.claude.com/docs/en/model-config)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Artificial Analysis leaderboard](https://artificialanalysis.ai/leaderboards/models)
