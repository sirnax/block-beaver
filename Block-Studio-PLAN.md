# Block Studio — a standalone visual development system

## Summary

Build Block Studio in its **own repository**, as a CLI, local worker, and visual console that can attach to any codebase. TEACAKE is the first substantial test case and may have an optional adapter; none of the core tool depends on TEACAKE. Version one supports JavaScript, TypeScript, and React, with language plugins for later expansion.

The tool maps software first, then guides AI-assisted conversion into blocks through a resumable roadmap. A block is a cohesive feature with a declared contract; individual functions and components remain visible as lower-level *observed pieces*. The visual shows both levels and the migration as it happens.

## Architecture and interfaces

- **Discovery core:** Language plugins extract code pieces and relationships into one normalized graph. Every inferred edge links back to source evidence. The scanner is read-only and works on repositories with no Block Studio files.
- **Block contracts:** After a repository opts into conversion, versioned `.blocks/` manifests in that repository define feature boundaries, dependencies, implementation files, rationale, and verification. These are project data, **not** copies of the Block Studio application. Existing project registries remain authoritative where an adapter identifies them.
- **Agent-neutral workflow:** Structured CLI/API operations cover `scan`, `inspect`, `plan`, `propose`, `check`, `review`, `approve`, and `resume`. Agent adapters consume the same graph and return roadmap slices, patches, evidence, and check results. An agent may repair work inside an approved slice, but may not enlarge its scope or pass the next approval point.
- **Durable execution:** Each migration runs in an isolated branch/worktree. The repository records its roadmap, proposed and applied diffs, checks, decisions, and ordered event ledger under `.blocks/roadmaps/`. Restarting the tool reconstructs progress from that ledger; changed source invalidates an outdated proposal before application.
- **Visual console:** Generate the layout and animation from graph snapshots and ledger events, including connections, impact, active work, failures, and history. Visual edits create reviewable patch proposals; they never silently rewrite source or become a second source of truth.
- **Deployment:** The local CLI and UI work independently. A product can embed a developer-only console, while a separately authenticated worker attached to a checkout performs analysis and code-changing jobs. The production product server does not execute migrations.

## Build sequence and acceptance

1. **Map:** Deliver the standalone repository, graph contract, JS/TS/React scanner, CLI queries, and read-only visual. Verify relationships and source evidence against TEACAKE and a second, differently structured application. The second app must work without a TEACAKE adapter.
2. **Govern:** Add block manifests, validation, candidate-boundary suggestions, and impact analysis. Convert one selected feature in each test repository without requiring a manifest for every function or component.
3. **Migrate:** Add agent adapters, bounded roadmap slices, isolated patches, checks, ledger replay, and milestone approval. Prove a complete conversion flow and that failed checks, rejected changes, interrupted runs, and source drift cannot advance the roadmap.
4. **Interact:** Enable visual proposals and procedural progress replay; add the gated development-worker integration. Verify that visual state matches the ledger after restart and that a proposed connection change appears as an inspectable diff before approval.

Each step ships with focused tests and a working end-to-end path. TEACAKE integration must reuse its existing block manifests, dev kit, codegen, and checks—never introduce another node-type list or bypass its approval and deployment rules.

## Assumptions

- “Separate” means all Block Studio implementation and releases live outside TEACAKE; only adopted block definitions and migration records live in a target repository.
- AI conversion is incremental and reviewed, not an unattended whole-codebase rewrite.
- The visual is a faithful, procedural view of code and recorded events, not the authority for code or architecture.
- No TEACAKE files are changed merely to build or validate the standalone core.
