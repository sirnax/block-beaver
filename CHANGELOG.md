# Changelog

All notable user visible changes are recorded here. Releases follow semantic versioning. Before 1.0, behavior and graph contracts may change between minor versions.

## Unreleased

- No additional changes recorded.

## 0.4.0 — 2026-10-01

Release candidate; not yet published. Versions 0.2.0 and 0.3.0 were local development versions and were never published. The upgrade path from the latest published release, 0.1.1, is directly to 0.4.0.

**Breaking changes:** the generated graph contract is now schema version 2, with app ownership and reachability data. The minimum supported Node.js version is 22.18.0; Node 24 and 26 are also supported. Consumers that read graph JSON or run Block Beaver on Node 22 before 22.18 must update.

- Add optional, project-defined typed families, TypeScript contract and manifest loading, family graph links and map floors; expose `block-beaver/kernel`, JSON kit commands, `gen --check`, history import, and the opt-in `block-beaver/eslint` rule. No domain family is bundled.
- Add multi-app detection and owner-controlled `.blocks/config.json`, compiler-based resolution, graph schema 2 ownership and reachability, cross-app links, app filters and health reports.
- Add `install`, `upgrade`, `uninstall` and `audit` workflows with managed editor instructions, native hooks, Git hooks, CI setup, versioned migrations, stable audit rules and configurable coverage, resolution and lint ratchets.
- Add strict scan diagnostics, incremental scanning, deterministic view module export with pure nonce/header helper, and generated maps with automatic refresh through `block-beaver start`; add `init` and `update` for setup and offline regeneration.
- Show declared local block dependencies as evidenced connections in the scanned graph and local Blocks view.
- Support explicitly scoped file creation in roadmaps and agent requests, with safe `op: "create"` patches alongside existing replacements.
- Preserve CRLF managed files and track workspace runtime dependencies through Windows junctions; bind reviewed filesystem permissions separately from portable Git receipt modes.
- Bind review and approval to the complete verified worktree snapshot, including declared generated files and the `.blocks` manifest; reject out-of-scope or post-check changes.
- Keep repair within the same implementation paths and patch operations while allowing content fixes.

## 0.1.1 — 2026-09-20

- Remove a separate file metadata check before reading local console assets, closing the file system race reported by CodeQL.

## 0.1.0 — 2026-09-20

- Add JS, TS, and React source scanning with evidence linked relationships.
- Add local browser graph explorer and read only previews.
- Add bounded roadmap proposals, checks in isolated worktrees, decisions, and event replay.
- Add agent protocol and authenticated local worker.
- Add the public project page, Apache-2.0 license, contributor and security guidance, CI, dependency audit, secret scanning, CodeQL, and tag based GitHub releases.
- Restrict local HTTP requests to loopback hosts and matching browser origins.
