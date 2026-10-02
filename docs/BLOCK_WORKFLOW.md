# Working in blocks

This is the working reference for using Block Beaver and for developing Block Beaver itself. A **block** is one cohesive feature with a purpose, an explicit implementation file boundary, dependencies, and verification. A function or component is an observed piece of code; it does not need its own block manifest.

## Automatic project integration

After installing the command with `npm ci` and `npm link` from the Block Beaver source checkout, run `block-beaver start --root /path/to/project`. This installs portable guidance in the target repository's editor instruction files, creates `.blocks/WORKFLOW.md`, and opens a local viewing session at the URL printed by the command. Source and registry changes regenerate `.blocks/view/index.html` and `graph.json`; the open map refreshes automatically while the session runs. The user does not need to copy these development instructions into another repository or edit generated HTML.

`block-beaver init` installs the same integration without running a server. `block-beaver update` regenerates the view once, and the installed instructions ask the AI editor to run it after changes. Setup manages marked sections and preserves surrounding instructions. The installed [workflow template](../templates/block-workflow.md) is the user-facing reference, with no dependence on Block Beaver's own development files. Project instructions must be enabled in the editor; the instructions are guidance, while the existing workflow commands enforce scope, checks, and approval.

## Use Block Beaver on a project

Block Beaver currently supports JavaScript, TypeScript, and React source. Use Node.js 22.18+ for family contract loading (or a project-configured TypeScript loader), Git, and a project you are authorized to inspect. From the Block Beaver checkout, run `npm ci` once. `npm start` opens the read-only console at `http://127.0.0.1:4173`; enter the target's absolute path and scan it. The CLI provides the full workflow:

## Optional typed families

Families add typed, repository-defined manifests alongside the base file-boundary method. They are disabled when `.blocks/config.json` has no `families` array. When enabled, each family entry names a TS contract module and a manifest glob; the ordered array controls floor order in the generated map. Each contract defines its own fields, implementation kinds, link kinds, optional generators, map copy, scaffold, and extra check. Block Beaver supplies only common manifest fields and generic runtime tools. Do not add product-specific family names, fields, path conventions, or link kinds to Block Beaver.

Contracts, manifest modules and custom generators use Node's built-in TS stripping with extensionless relative imports and tsconfig aliases resolved through the owning app. The default requires Node 22.18+ with `module.registerHooks`; use the repository's `loader` package config when it requires another TS loader. Modules should use strip-only TS syntax and `.ts`, `.mts`, or `.cts` extensions; `.tsx` needs the configured loader.

Use `block-beaver kit list`, `kit describe FAMILY`, `kit validate --json JSON`, and `kit compose --json JSON` for JSON-only inspection and checks. `kit create FAMILY ID --json JSON --dry-run` previews scaffold paths; without `--dry-run`, creation refuses existing paths, writes the configured scaffold, reports manual steps, and runs generation. `block-beaver gen --check` reports missing or stale generated files without writing; `block-beaver gen` writes outputs. `block-beaver history import FILE --map MAPPING.json` requires an explicit old-key mapping to `family:id`. Include generated files in the reviewed feature boundary.

An existing output that has no Block Beaver header is taken over with `block-beaver gen --adopt PATH` (review with `--adopt --dry-run`; `--check` never adopts). A generator can also own one marked region of a file (`region`), so the rest of the file stays hand-written. If a contract imports a generated output that was deleted, loading fails with `output-required-for-load`: restore the file with `git restore`, then adopt it if it predates Block Beaver. The managed pre-commit and CI audits print a one-line summary; run `block-beaver audit` for the full report.

1. **Map the project.** Run `node bin/block-beaver.mjs scan --root /absolute/path/to/project`. Use `scan --full true`, `search QUERY`, and `inspect NODE_ID` to examine the graph and its source evidence. The first scan writes detected apps to `.blocks/config.json`; review and commit that config. `detect` previews new apps and `detect --write` adds them without replacing owner entries. If typed families are configured, review their contracts and run `gen --check` to detect drift. Check app health and use `scan --strict` at a gate. The graph is evidence for a proposed boundary, not proof that every runtime relationship was found.
2. **Choose one feature boundary.** Name its purpose and rationale. List the existing source files it owns and any new files it must create. Check imports and existing block manifests for dependencies. Keep unrelated files out of this slice. The target must be a Git repository with a committed base for the worktree check.
3. **Create a roadmap.** Run `node bin/block-beaver.mjs plan feature-roadmap --root /absolute/path/to/project --scope src/existing.ts --create src/new.ts`. Omit `--scope` or `--create` if unused, but provide at least one. Block Beaver writes roadmap data under the target's `.blocks/roadmaps/` directory.
4. **Submit a proposal.** Write a JSON proposal with `id`, `name`, `description`, `rationale`, `files`, `dependencies`, `verification`, and `patches`, then run `node bin/block-beaver.mjs propose feature-roadmap /absolute/path/to/proposal.json --root /absolute/path/to/project`. The proposal ID becomes the slice ID. `files` names the block's implementation files, within the roadmap scope. Each replacement patch supplies complete file content and the matching `baseHash` from `scan --full true`; each new file uses `op: "create"`, complete content, and a path in `--create`. A new implementation file must have a create patch. Declare any generated files that checks will leave behind.
5. **Check and review.** Run `node bin/block-beaver.mjs check feature-roadmap feature-id --root /absolute/path/to/project`, then `review` with the same IDs. `check` validates the contract, source fingerprint, patch content, and paths; creates a branch and worktree under `.blocks/worktrees/`; applies the proposal there; runs the proposal's verification commands; and captures the complete change set. Inspect the command results, review output, and worktree diff. An undeclared change or changed source prevents approval.
6. **Decide and integrate.** Run `approve` with the same IDs only after the checked worktree matches the review. Approval records a decision and returns the branch and worktree; it does **not** commit, merge, or deploy the change. The reviewed files are still uncommitted in that worktree. Commit them and integrate the branch using the target project's normal Git and review process. Rescan the integrated target in the local console and check that the block appears in **Blocks** with its intended files and connections. Use `reject feature-roadmap feature-id --reason TEXT` when the slice should not proceed. Use `resume feature-roadmap` to replay status from the event ledger after a restart.

If a check fails, fix the proposal within the same ID, implementation files, and patch path/operation boundary with `repair ROADMAP_ID SLICE_ID revised.json`, then rerun `check` and `review`. If the boundary must grow, plan a new slice instead. Keep verification commands explicit and review them before running `check`; they execute in the isolated worktree.

The local browser console previews candidate blocks and downloads proposals. It does not apply patches. An agent adapter can generate a proposal, but its output follows the same `propose` → `check` → `review` → `approve` path. See the [README](../README.md#agent-and-worker-interfaces) for the adapter and authenticated worker interfaces.

## Build Block Beaver in the same manner

For each meaningful feature or behavior change in **this repository**, keep a short block record in the issue, task document, or pull request. Use this shape before editing:

| Field | Record |
| --- | --- |
| Purpose | One user-visible capability or one coherent internal responsibility, and why it is one block. |
| Boundary | Owned files and planned new files; list shared interfaces separately. |
| Connections | Inputs, outputs, graph or manifest contracts, and dependencies on existing blocks or subsystems. |
| Acceptance | Observable behavior, important failure paths, and the checks that will demonstrate them. |

Then work in this order:

1. Read the relevant code, tests, and task document. Confirm the boundary against actual imports and callers; adjust the record if discovery changes it.
2. Implement within the recorded boundary. If work crosses into another subsystem, state the new interface and update the record before widening the change. When delegating, give each owner a separate file boundary and one integration owner for shared files.
3. Add focused regression checks where behavior can break. Run `npm run check` and any manual end-to-end path needed for the changed capability. Use a disposable Git repository for tests that write `.blocks/` data.
4. Review the full diff against the record: purpose achieved, file boundary explained, contracts and compatibility accounted for, no unrelated changes, and docs updated. Put the record, evidence, and any remaining limits in the pull request. A passing test suite alone is not the review decision.

This process is a review discipline for Block Beaver development. The product's `.blocks/` manifests and roadmap ledger belong to a **target repository that opts in**; this repository does not need a manifest for every internal function or every maintenance edit. An adopting project keeps its existing registry authoritative by configuring that system's contract and manifest paths, then checks generated output equivalence before replacing its own generation workflow.

## Keep the block view aligned

For target-project users, `block-beaver start` keeps the generated map aligned automatically, and the installed editor instructions call `block-beaver update` after changes when working without a viewing session. New blocks need a declared manifest; scanning alone does not invent feature boundaries. The remainder of this section describes maintenance of the original Block Beaver console itself.

An AI editor working in this repository should read `AGENTS.md` and this guide at the start of a task. For a target project's new or changed block, the source of truth is its reviewed base manifest or configured family manifest. The family loader adds typed declarations and links to the scanned graph; `server.mjs` serves the graph; `src/app.js` renders block nodes into the **Blocks** section defined in `index.html`. The console holds a scan snapshot, so scan again after integrating a manifest or changing source. Confirm the block's name, implementation links, declared links and map floor in the view; record that check in the review.

Edit `index.html`, `src/app.js`, or `styles.css` when the *presentation or interaction* of the local Blocks view must change. Include that UI work in the block boundary and verify it against a representative target repository. `docs/index.html` is the separate public project landing page; change it when public product information changes. Do not copy block records into either HTML file to make a block appear.
