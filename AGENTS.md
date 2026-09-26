# Agent guidance

This file covers general collaboration in the Block Beaver repository. Task-specific requirements belong in the user's request or the relevant task document.

## Orchestration

- Use **gpt-6-sol at medium effort** as the default orchestrator for software work. It owns task boundaries, integration, and the final review.
- When the user requests delegation, parallelize independent work. Assign one owner to each file or tightly coupled subsystem, agree on shared interfaces first, and integrate dependent work after its prerequisites land.
- Up to 16 subagents may run on this machine. Use only the slots that have independent, useful work; account for the primary agent separately.
- Give each agent a bounded assignment with its files, expected output, dependencies, and verification. Keep a single integration owner for files that many tasks would otherwise edit.
- Treat model comparisons as routing guidance, not proof that a particular model will succeed. Escalate based on the task and observed results.

## Default subagent roster

| Model | Effort | Intended assignment |
| --- | --- | --- |
| gpt-6-luna | low | Mechanical inspection, repository search, and simple classification |
| gpt-6-luna | medium | Documentation, routine inspection, test interpretation, and small well-defined edits |
| gpt-6-luna | high | Bounded investigation and small edits requiring more reasoning |
| gpt-6-luna | xhigh | Harder bounded analysis or implementation with a precise specification and strong checks |
| gpt-6-sol | medium | Default delegated implementation, focused tests, bug fixes, and code review |
| gpt-6-sol | high | Difficult implementation, debugging, consequential review, and integration |
| gpt-6-astra | low | Exceptional complex or ambiguous debugging and architecture |
| gpt-6-astra | medium | Exceptional high-consequence architecture, security reasoning, or critical independent review |

Luna medium is the default for small, clear non-code tasks. Sol medium is the default for software implementation. Use Astra only when the task warrants an exceptional escalation. Max effort, Astra high or xhigh, Sol xhigh, and older model families are outside this default subagent roster unless the owner explicitly requests or authorizes them. The primary model selected in Codex is unaffected.

## Repository work

- Read the relevant code and task document before editing. Keep changes within the requested scope and preserve existing public behavior unless the task requires a change.
- Use disposable repositories or fixtures for workflow experiments. Do not put source or machine-specific absolute paths from another project into Block Beaver.
- Have one agent integrate shared-file changes and inspect the resulting diff. Run the checks needed for the change and report any checks that could not be completed.

## graphify

When the user types `/graphify`, load and apply the `graphify` skill before other task work.
