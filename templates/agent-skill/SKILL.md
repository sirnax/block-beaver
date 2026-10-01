---
name: block-beaver
description: Inspect owning blocks, respect file boundaries, declare dependencies, and audit changes using the repository's Block Beaver workflow.
---

# Block Beaver

Before changing code, read `.blocks/WORKFLOW.md` and inspect the owning block using a fresh `block-beaver scan --root . --full true` graph and the authoritative manifests.

1. Inspect the owning block, its implementation files, dependencies, and dependents.
2. Keep edits inside the agreed block boundary. Record exceptions explicitly when a boundary cannot apply.
3. Declare every new connection between blocks in the authoritative manifest.
4. Propose new blocks through the plan → propose → check → review workflow, with purpose, rationale, files, dependencies, and verification. Require `readyForApproval: true`, preserve the owner's approval boundary, then integrate through the CLI to create the reviewed-content receipt.
5. Run `block-beaver audit --root .` before finishing and report its results. After source or manifest changes, run `block-beaver update --root .` to regenerate the graph and map.

Read [workflow details](references/workflow.md) for planning and verification, or [application ownership](references/apps.md) when editing files shared by several apps. Load only the reference needed for the task.
