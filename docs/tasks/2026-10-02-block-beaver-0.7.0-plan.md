# Block Beaver 0.7.0 plan: adopting an existing family system, part 2

Issues #36–#43 came from the next adoption steps in the repository that drove 0.6.0 (4 apps, 6 families, 174 manifests). Tracking issue #44 records the goal. Block Beaver goes 0.6.0 → **0.7.0**: a minor release, because #36–#40 add contract and config keys.

**Goal.** After 0.7.0 an adopting project can:
- generate every output it has today through Block Beaver, taking existing files over without deleting them;
- serve the family map in a host app at a sensible size;
- keep every piece of map information, including links, grouping and history labels.

## Owner decisions

- **Branching.** 0.7.0 is built on `release/0.7.0`, cut from `main` at `b3652d1`.
  - Each slice is built in a worktree on `feat/0.7.0-<slug>`. The orchestrator creates every worktree from the current `release/0.7.0` head.
  - Slices merge into `release/0.7.0` after review and checks. One release PR carries `Fixes #36` … `Fixes #44`.
- **#43 changes the managed hook and CI bytes.**
  - The managed pre-commit runs `audit --staged --format summary --root .`.
  - The managed CI job adds `--format summary`.
  - `upgrade` rewrites those hash-trusted regions once. This is the single exception to #44's "`upgrade` is a no-op apart from the version stamp" check, and the changelog records it.
- **#42 keeps `full` as the default detail.** `--detail map` is opt-in through the flag or config `view.detail`. Existing exported modules keep their bytes.
- **Compatibility.**
  - `graph.json` stays at schema 2.
  - Projects that don't use the new keys keep identical graph and output bytes.
  - The changelog gets a "Compatibility notes" section, as in 0.5.x and 0.6.0.

**Workers and order.** Workers follow the roster in `AGENTS.md`, one owner per file.
- Wave 1 runs in parallel: O, L, M and Q.
- Wave 2: G starts after L, and R and H start after O.
- Wave 3 is integration: the adoption fixture, docs, version and release.

## Block records

### O — Generator entries and output adoption (#41, #38)
- **Purpose:**
  - Generators can see each manifest's path and export name.
  - An existing output without a Block Beaver header can be taken over without deleting it.
  - A load that fails because a generated output is missing says so clearly.
- **Boundary:**
  - `src/families/generate.mjs`, `src/families/commands.mjs`, the `gen` branch of `src/cli.mjs`;
  - the generator context in `src/families/load-worker.mjs`;
  - `GeneratorContext` in `src/kernel/index.d.ts`.
- **Connections:**
  - `ctx.entries(family?)` returns `{ref, family, id, path, exportName, hash, value}` in `ctx.manifests` order.
  - `ref`, `path` and `exportName` join the custom generator cache context.
  - `gen --adopt [PATH…]`: listing paths is consent, and a bare `--adopt` adopts every claimed conflicting output. `--check` never adopts.
  - `output-required-for-load` replaces `unresolved-import` when the missing file is a statically known claimed output. The known outputs are:
    - config registry outs;
    - the index and history paths;
    - `out` literals in generator modules;
    - recorded cache outs.
- **Acceptance:**
  - A contract imports a headerless generated file. `gen --adopt that/file.ts` takes it over with no deletion, and the next `gen --check` is clean.
  - Without `--adopt`, the result is still `output-conflict`.
  - Deleting a load-time-imported output gives `output-required-for-load`, naming both files.
  - `--adopt --dry-run` writes nothing and reports `bodyIdentical`.
  - A custom generator emits `import { <exportName> } from './<path>'` for every manifest, in `ctx.manifests` order.

### L — Join links (#36)
- **Purpose:** a link can match a value on one manifest against a field on every manifest of the target family.
- **Boundary:**
  - link validation in `src/families/load-worker.mjs`;
  - `src/families/graph.mjs`;
  - `src/families/kit.mjs`;
  - a new `src/families/paths.mjs` (a shared `.`/`[]` path walker);
  - link types in `src/kernel/index.d.ts`.
- **Connections:**
  - `links[i].match` is validated against the target family's `fields` (`link-path-invalid` at `$.links[i].match`). `to` must be a single family when `match` is used.
  - Join edges are ordinary `link: true` edges, so `dependencies`, `undeclared-link`, `unused` and the map use them unchanged.
- **Acceptance:**
  - Scalar × array and array × array fixtures produce exactly the expected edges, in deterministic order, deduplicated per `(from, to, kind)`.
  - A value with no match produces no edge and no diagnostic.
  - A bad `match` path fails `manifest-valid`.
  - Graphs of families without `match` keep the same bytes.

### M — Map-only view detail (#42)
- **Purpose:** an exported view module can embed only what the family map draws, under an optional byte budget.
- **Boundary:**
  - `src/view-exports.mjs`;
  - `src/block-map.mjs` (render options);
  - the `view` branch of `src/cli.mjs`;
  - `view-fresh` in `src/compliance.mjs`;
  - `view.detail` in `src/families/config.mjs`.
- **Connections:**
  - Registry entries record `detail` when it is not `full`.
  - Every registry reader renders each module at its recorded detail.
  - The trimmed payload renumbers `data-map-edge`.
  - `#cross-app-links`, `#search` and `#app-filter` stay, because the page script uses them.
- **Acceptance:**
  - `--detail map` output contains no `evidence` text and no file-level nodes.
  - The map renders the same floors, bricks, links and slabs.
  - `--max-bytes` fails deterministically with `view-too-large` and writes nothing.
  - Full-detail bytes are unchanged.

### Q — Quiet audit output (#43)
- **Purpose:** a passing hook audit prints at most one line.
- **Boundary:**
  - the `audit` branch of `src/cli.mjs`;
  - a new `src/audit-format.mjs`;
  - `src/install-host.mjs`, plus the hook and CI byte tests.
- **Connections:**
  - The managed pre-commit and CI use `--format summary`. `--staged` stays directly after `audit`, because the live editor gate matches on it.
  - The default output stays JSON.
- **Acceptance:**
  - A passing staged audit through the managed hook prints one line.
  - A failing one prints each error once, with its rule id, and exits non-zero as before.
  - Warnings print once per run.
  - `upgrade` rewrites a 0.6.0 hook and CI without conflicts.

### G — Per-family map grouping (#37)
- **Purpose:** each family groups its floor by its own field rule.
- **Boundary:**
  - contract `map` validation in `src/families/load-worker.mjs`;
  - grouping in `src/families/graph.mjs`;
  - types in `src/kernel/index.d.ts`.
- **Connections:**
  - `map.group: {field, join, empty, format}` wins over config `map.groupBy`.
  - The rule is copied into `graph.families`, so the fingerprint includes it.
- **Acceptance:**
  - A fixture clusters each family by its own rule: scalar, nested-nullable, array-joined, empty fallback and format.
  - An invalid path reports `contract-invalid` at `$.map.group.field`.
  - Graphs without `map.group` keep the same bytes.

### R — Region outputs (#39)
- **Purpose:** a generator can own a marked region of a hand-edited file.
- **Boundary:**
  - generator validation in `src/families/load-worker.mjs`;
  - claims, planning and drift in `src/families/generate.mjs`;
  - `GeneratorDefinition` types.
- **Connections:**
  - Markers are whole lines, `block-beaver:region ID` … `/block-beaver:region ID`, written in the file's comment style. They are distinct from managed `block-beaver:start/end` sections.
  - Claims are keyed by `(out, region)`.
- **Acceptance:**
  - `gen` updates only the region, and `--check` reports drift only inside it.
  - Hand edits outside a region never drift.
  - Missing or duplicated markers give `region-missing` / `region-duplicate`, and nothing is written.
  - A region claimed twice is a collision.

### H — Derived history labels (#40)
- **Purpose:** history entries written by hooks and agents get a label worked out from the repository.
- **Boundary:**
  - `history` validation in `src/families/config.mjs`;
  - the label flow in `src/families/generate.mjs`;
  - the generate pass in `src/families/load-worker.mjs`;
  - tracked inputs in `src/families/loader.mjs`;
  - the eslint skip list.
- **Connections:**
  - `history.label: {module}`. The module's default export is `(ctx) => string | null` and gets the generator context.
  - The module is evaluated only when an entry is appended.
  - `--label` still overrides it.
- **Acceptance:**
  - Changing a manifest appends an entry with the derived label.
  - An unchanged set keeps exact bytes, and the module isn't evaluated.
  - Invalid modules give `history-label-invalid`, and nothing is written.

## Release gate

- Every issue has a passing and a failing fixture.
- `npm run check` passes on Node 22.18.0, 22, 24 and 26, plus macOS and Windows CI, CodeQL and Gitleaks.
- The adoption fixture (`tests/adoption.test.mjs`) covers:
  - adopting an output a contract imports;
  - join links and per-family groups;
  - a region badge;
  - a label module;
  - a map-detail export under a byte budget;
  - a one-line staged audit.
- A packed-tarball run in a disposable repository covers:
  - install;
  - the hook's one-line output on pass and on failure;
  - `gen --adopt`;
  - a map-detail view;
  - upgrade from 0.6.0.
- A browser check of the console Blocks view and a map-detail exported view, under the strict CSP.
- The live editor gate (`docs/LIVE_EDITOR_BATTLE.md`) against one candidate fingerprint. It is mandatory here because the hook bytes change.

## Known limits

To be filled in during the build.

## Evidence

To be filled in during the build.
