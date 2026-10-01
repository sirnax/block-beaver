# Building this project in blocks

This project uses Block Beaver. Keep work organized around cohesive features with explicit file boundaries, dependencies, and verification. Read the existing project instructions and authoritative block registry before changing code.

## At the start of a task

Run `block-beaver scan --root . --full true` to get fresh source evidence and file hashes. Read the authoritative local block manifests and, when configured, each family contract and family manifest. Do not introduce a second registry beside an existing owner system; configure the existing family's paths and contract, then compare generated results during adoption.

The first scan creates `.blocks/config.json`. Commit it and review its detected apps.
Use `block-beaver detect` to preview newly detected apps and `detect --write` to add them.
Mark owner-controlled apps with `"source": "config"`; detection preserves those entries
and reports disappeared apps without removing them. Review app health and unresolved
imports; `scan --strict` fails on configuration or resolution problems. Files outside
apps remain visible. Each import uses its home app's TypeScript configuration.

Typed families are optional. If `.blocks/config.json` contains a `families` array, those repository-defined families own their manifest schema, allowed implementation kinds, links, generators, scaffolds, and map labels. The array order sets map floor order. Do not assume Block Beaver supplies domain family names, fields, paths, or link kinds. Run `block-beaver kit list` and `block-beaver kit describe FAMILY` to inspect configured contracts. Contracts, manifests, and custom generators use Node's TypeScript stripping on Node 22.18+; configure the repository's existing loader package with the config `loader` field when the default loader cannot load its syntax.

Choose the affected block or propose one cohesive new block. Record its purpose, implementation files, interfaces, dependencies, and acceptance checks in the task. Functions and components remain observed code pieces; they do not each require a block.

## Implement and verify

Use a Git repository with a committed base. Plan a bounded roadmap with `block-beaver plan ROADMAP --root . --scope existing/files.ts --create new/files.ts`. Omit unused scope options. Include every file that verification or generation will change.

Prepare a proposal JSON containing `manifest` and `patches`. A local manifest has `schemaVersion: 1`, a kebab-case `id`, a positive integer `version`, `name`, `description`, `rationale`, `files`, `dependencies`, and `verification`. Updating an existing local block requires a higher version. Dependencies use declared graph IDs such as `block:local:account`. Each replacement patch supplies `path`, the current `baseHash` from the scan, and complete `content`; a new file supplies `op: "create"`, `path`, and complete `content` within creation scope.

Run `block-beaver propose ROADMAP proposal.json --root .`, then `block-beaver check ROADMAP BLOCK --root .` and `block-beaver review ROADMAP BLOCK --root .`. Read the JSON results: a process exit alone does not establish that a proposal was accepted or checks passed. Checks apply the proposal in an isolated worktree and run the declared verification commands. Use meaningful project checks and inspect the complete change set. Do not alter the source checkout to bypass the bounded workflow. The current patch format supports JS/TS/React and JSON; document work outside that format and use the project's normal reviewed process.

Repair a failed proposal with `block-beaver repair ROADMAP BLOCK revised.json --root .` within the same files and operations, then repeat check and review. A larger boundary requires a new plan. Use `block-beaver resume ROADMAP --root .` to recover recorded state. Record approval only when authorized and the worktree matches the passing review. Approval does not commit or merge: integrate reviewed work through the project's normal Git process.

## Keep the view current

Run `block-beaver update --root .` after source or registry changes and after integration. This regenerates `.blocks/view/graph.json` and `.blocks/view/index.html` from source and manifests. Never hand-edit the generated HTML or graph. It is a view of the current checkout, not a record of approval and not a manifest editor. An approved block appears in the target checkout only after its manifest and implementation have been integrated there.

`block-beaver start --root .` installs the project integration if needed, serves the map locally, and refreshes it while the process runs. Keep that session running during development for automatic view updates. The HTML file can also be opened offline; reopen or reload it after an update. Report the affected block, verification results, and regenerated view when finishing a task.

Use the app filter and health reports to inspect cross-app links and files shared by
multiple apps. For embedding, `block-beaver view --format module --out src/generated/block-map.mjs`
exports `BLOCK_BEAVER_VIEW`. `prepareView` from `block-beaver/view` fills a request nonce
and optional static host header. The host must supply trusted or escaped `headerHtml`.

When families are configured, run `block-beaver gen` after manifest or generator-input
changes, and `block-beaver gen --check` to report generated drift without writing. Include
all expected generated outputs in the reviewed change. `block-beaver kit validate` and
`kit compose` take JSON via `--json JSON` (or stdin with `--json -`) and return JSON.
`kit create FAMILY ID` requires that family's scaffold, refuses existing target paths,
reports manual steps, and then generates outputs; use `--dry-run` to inspect scaffold
paths first. Use `block-beaver history import FILE --map MAPPING.json` only with an
explicit mapping from old keys to `family:id`.

## Enforcement levels

`.blocks/config.json` is authoritative for how strictly `block-beaver audit` gates commits. Its `enforcement.receipts` value is one of:

- `"required"`: every changed source or manifest file needs a reviewed block receipt, and every other changed file needs a recorded exception. A config without the key behaves this way.
- `"optional"`: unreviewed changes are listed as advisories and do not fail the audit. Invalid or forged receipts, and review that went stale against its own change, still fail. New installs start here.
- `"off"`: the review check is skipped, but invalid or forged evidence still fails.

The structural rules (declared links, ratchets, view freshness, managed files, config and exception validity) gate commits at every level. The stricter of the base revision's level and the checked tree's level applies, so loosening the gate needs a commit that passes under the old level first. `audit` output reports the active level under `enforcement`.

Edits to `.blocks/config.json` are owner-controlled: the managed setup exception never goes stale when you change it, and `config-valid` checks its contents. Such an edit follows the active level like any other changed file, so it needs a receipt or recorded exception only under `"required"`.

Managed files that Git ignores (for example a fully ignored `.claude/`) exist only on the machine that installed them. Pre-commit and CI audits cannot see them, so they report an `ignored-managed-local` advisory instead of failing `managed-current`; working-tree audits still check the local files. Run `block-beaver install --fix-ignores` to un-ignore only the managed paths so they can be committed and checked.

## Project portability

Commit the editor instructions, this workflow, and adopted manifests according to the project's versioning policy. Generated views and worktrees are ignored inside `.blocks/`. Another machine needs Node.js 22.18+ for family contract loading (or a configured loader package). Install this project’s locked dependencies using its package manager, then run its pinned Block Beaver through the local package-manager command (for npm, `npx --no-install block-beaver`). Source-checkout development can use `npm link`; installed projects use their pinned dependency. No machine-specific installation path belongs in these project instructions.

Editor guidance helps an agent follow the process; enforcement of scope, checks, and approval occurs when it uses Block Beaver's workflow commands. Refreshing the map does not certify architecture or validate an arbitrary edit made outside that workflow.
