# Block boundaries and verification

Read the project's authoritative manifests before changing code. Record the affected feature's purpose, owned files, interfaces, dependencies, and acceptance checks.

Use `block-beaver plan ROADMAP --root . --scope existing/files.ts --create new/files.ts`, then prepare the proposal required by `.blocks/WORKFLOW.md`. Run `propose`, `check`, and `review` for the same roadmap and block. Checks run in an isolated worktree. A larger boundary needs a new plan. Review JSON must report `readyForApproval: true` before approval. After authorized approval, run `block-beaver integrate ROADMAP BLOCK --root .` to apply the reviewed files and create their receipt. Stage the receipt and matching roadmap proposal/ledger evidence with the implementation. Approval and integration do not commit or merge the change.

Run `block-beaver audit --root .` before completing a task, and `block-beaver audit --staged --root .` before committing. A failed gate needs a fix or a justified exception recorded through `block-beaver exception`; guidance from a hook does not override an audit failure.

`.blocks/config.json` sets how strictly review receipts gate commits through `enforcement.receipts`: `required` (the default when absent), `optional` (unreviewed changes become advisories; invalid or stale receipts still fail) or `off`. `block-beaver audit` reports the active level under `enforcement`. Structural rules gate commits at every level. Do not loosen the setting to get a commit through; the base revision's stricter level applies anyway.

Do not hand-edit generated views. Regenerate with `block-beaver update --root .` and inspect the resulting block names, files, and connections.
