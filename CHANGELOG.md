# Changelog

All notable user visible changes are recorded here. Releases follow semantic versioning. Before 1.0, behavior and graph contracts may change between minor versions.

## 0.4.0 — 2026-10-01

Release candidate; not yet published.

- Add optional project-defined typed families, TS contract/manifest loading, family graph links and map floors; expose `block-beaver/kernel`, JSON kit commands, `gen --check`, history import, and the opt-in `block-beaver/eslint` rule. No domain family is bundled.
- Add multi-app detection and owner-controlled `.blocks/config.json`, compiler-based
  resolution, graph schema 2 ownership and reachability, cross-app links and health reports.
- Add app filters and grouping to the console and generated map, strict scan diagnostics,
  incremental scanning, and deterministic view module export with pure nonce/header helper.
- Add one-command target-project integration with native editor instructions, a portable block workflow, generated HTML/JSON maps, and automatic refresh through `block-beaver start`. Add `init` and `update` for setup and offline regeneration.
- Show declared local block dependencies as evidenced connections in the scanned graph and local Blocks view.
- Support explicitly scoped file creation in roadmaps and agent requests, with safe `op: "create"` patches alongside existing replacements.
- Bind review and approval to the complete verified worktree snapshot, including declared generated files and the `.blocks` manifest; reject out-of-scope or post-check changes.
- Keep repair within the same implementation paths and patch operations while allowing content fixes.

## Unreleased

- No additional changes recorded.

## 0.1.1 — 2026-09-20

- Remove a separate file metadata check before reading local console assets, closing the file system race reported by CodeQL.

## 0.1.0 — 2026-09-20

- Add JS, TS, and React source scanning with evidence linked relationships.
- Add local browser graph explorer and read only previews.
- Add bounded roadmap proposals, checks in isolated worktrees, decisions, and event replay.
- Add agent protocol and authenticated local worker.
- Add the public project page, Apache-2.0 license, contributor and security guidance, CI, dependency audit, secret scanning, CodeQL, and tag based GitHub releases.
- Restrict local HTTP requests to loopback hosts and matching browser origins.

Known limitations: graph edges are source observations rather than complete runtime dependencies. Dynamic imports, arbitrary path aliases, and relationships hidden behind reexports can be missed. The console and worker are for trusted local use. The 0.3.0 and 0.4.0 changes are local and have not been published.
