# Block Beaver

<p align="center"><img src="docs/assets/block-beaver-hero.png" alt="A beaver builds a dam from blocks marked with code and graph connections" width="100%"></p>

<p align="center">
  <a href="https://github.com/sirnax/block-beaver/releases"><img alt="Latest GitHub release" src="https://img.shields.io/github/v/release/sirnax/block-beaver?color=28728d"></a>
  <a href="https://github.com/sirnax/block-beaver/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/sirnax/block-beaver/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/sirnax/block-beaver/actions/workflows/secret-scan.yml"><img alt="Secret scan status" src="https://github.com/sirnax/block-beaver/actions/workflows/secret-scan.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/sirnax/block-beaver/actions/workflows/codeql.yml"><img alt="CodeQL status" src="https://github.com/sirnax/block-beaver/actions/workflows/codeql.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-28728d"></a>
  <a href="#supported-environments"><img alt="Node.js 22, 24 and 26" src="https://img.shields.io/badge/Node.js-22%20%7C%2024%20%7C%2026-28728d"></a>
  <a href="#supported-environments"><img alt="Linux, macOS and Windows" src="https://img.shields.io/badge/OS-Linux%20%7C%20macOS%20%7C%20Windows-28728d"></a>
  <a href="https://github.com/sirnax/block-beaver/issues"><img alt="Report an issue" src="https://img.shields.io/badge/issues-report%20a%20bug-d1985b"></a>
</p>

Block Beaver makes the shape of a codebase visible. Scan a JavaScript, TypeScript, or React repository, follow each observed relationship to its source line, and turn a candidate feature into a reviewed block proposal. It runs locally and keeps code changes inside bounded Git worktrees.

**[Project page](https://sirnax.github.io/block-beaver/)** · **[Get started](#quick-start)** · **[How it works](#how-it-works)** · **[Working in blocks](docs/BLOCK_WORKFLOW.md)** · **[CLI and workflow](#propose-a-block)** · **[Plan](docs/tasks/block-studio.md)** · **[Contribute](CONTRIBUTING.md)**

> **This is an early release.** The graph is an aid to review, not a complete static analysis. Block Beaver is [Apache-2.0 licensed](LICENSE). The npm package is marked private, so install it from source.

## Supported environments

The CLI and local browser console run with **Node.js 22, 24, or 26**. CI checks Linux on all three versions and macOS and Windows on Node.js 24. The scanner reads JavaScript, JSX, TypeScript, and TSX, including MJS, CJS, MTS, and CTS files. Git is needed for roadmap checks and worktrees. This release is distributed as source through GitHub; it is not published to npm.

## Why use it?

| See the code | Draw a boundary | Keep the record |
| --- | --- | --- |
| Files, functions, components, hooks, and their evidenced connections appear in one graph. | Propose a cohesive feature with a declared file scope, dependencies, and verification commands. | Checks run in an isolated worktree; reviews, decisions, and failures stay in an ordered roadmap ledger. |

The visual console explores and previews. The CLI and optional authenticated worker handle roadmap operations. TeaCake is a read-only reference and optional adapter; no TeaCake files are required for another project.

## Quick start

Requires **Node.js 22+**. Install dependencies, then launch the local console:

```sh
npm ci
npm start
```

Open **http://127.0.0.1:4173**, enter an absolute path to a project, and select **Scan project**. The console binds to localhost and offers read and preview operations. Set `BLOCK_BEAVER_REPO=/path/to/project` to prefill the path.

For a terminal first look:

```sh
node bin/block-beaver.mjs scan --root /path/to/project
```

## Use it with your AI editor

Set up the command once from your Block Beaver source checkout:

```sh
npm ci
npm link
```

Then run one command for the project you want to build:

```sh
block-beaver start --root /path/to/your-project
```

Open the localhost URL it prints (port 4175 by default). This command installs project guidance for editors using `AGENTS.md`, Claude Code, Cursor, and GitHub Copilot; creates `.blocks/WORKFLOW.md`; generates `.blocks/view/index.html` and `graph.json`; and refreshes both the files and the open browser view as source and manifests change. Existing instructions outside the marked Block Beaver section are preserved. Repeating setup does not duplicate instructions. Keep the process running for live updates; Ctrl+C stops it. No hand-editing of instruction files or HTML is required.

The installed rules tell the AI editor to read the registry, work within a feature boundary, use proposals/checks/review, and regenerate the map after changes. These are project files that travel with the repository. Each machine still needs Block Beaver installed, and each editor must have its project instructions enabled. The rules guide the agent; Block Beaver's workflow commands enforce scope and approval. The live map shows the current checkout and does not itself approve or validate arbitrary edits.

For setup without a live session, use `block-beaver init --root /path/to/your-project`. For a one-time regeneration, use `block-beaver update --root /path/to/your-project`. The generated HTML also opens offline. To install only one editor's instructions, add `--editor agents`, `claude`, `cursor`, or `copilot` to `init` or `start`; the default is `all`. A source-only install can use `node /path/to/block-beaver/bin/block-beaver.mjs start --root /path/to/your-project`, but putting the command on PATH with `npm link` lets future editor sessions use the portable commands in the installed guide.

## How it works

```mermaid
flowchart LR
  A[Scan source] --> B[Explore evidenced graph]
  B --> C[Propose bounded block]
  C --> D[Check in Git worktree]
  D --> E[Review and decide]
```

Scanning does not change the target repository. `init` and `start` explicitly install project instructions and generated views; creating a roadmap writes `.blocks/` workflow records. A proposal cannot advance after failed checks or source drift. [Read the original plan](docs/tasks/block-studio.md), written under the working title “Block Studio,” for the intended stages and boundaries.

## Explore from the CLI

```sh
node bin/block-beaver.mjs scan --root /path/to/project
node bin/block-beaver.mjs search Button --root /path/to/project
node bin/block-beaver.mjs inspect 'symbol:src/Button.tsx#Button' --root /path/to/project
# Optional TeaCake adapter: delegate a read-only query to its own dev kit
node bin/block-beaver.mjs kit list_blocks --root /path/to/teacake
```

`scan --full true` prints the complete normalized graph. The graph has `schemaVersion`, a source fingerprint, nodes (`file`, `function`, `component`, `hook`, `class`, and optional `block`), and typed edges. Every edge includes `evidence.file`, `line`, `column`, and source text. The scanner reads JS, JSX, TS, TSX, MJS, CJS, MTS, and CTS; it ignores build output, dependencies, Git metadata, and `.blocks/`.

The scanner host accepts language plugins with `accepts`, `parse`, `declarations`, `evidence`, and `links` methods. The included [JS/TS/React plugin](src/plugins/js-ts-react.mjs) uses the TypeScript parser. A later language can emit the same graph contract without changing the console or workflow.

## Propose a block

A target repository opts in when you create a roadmap. The scope is an explicit list of scanned source files. Block Beaver writes its roadmap, proposals, checks and ordered event log to that repository's `.blocks/roadmaps/` directory. It never writes to TeaCake during the scans described above.

```sh
node bin/block-beaver.mjs plan account-card --root /path/to/project --scope src/account/Card.tsx,src/account/data.ts --create src/account/card.json
node bin/block-beaver.mjs propose account-card /path/to/proposal.json --root /path/to/project
node bin/block-beaver.mjs check account-card account-card --root /path/to/project
node bin/block-beaver.mjs review account-card account-card --root /path/to/project
node bin/block-beaver.mjs approve account-card account-card --root /path/to/project
# After a failed check, repair within the same path and operation boundary, then check again:
node bin/block-beaver.mjs repair account-card account-card /path/to/revised-proposal.json --root /path/to/project
node bin/block-beaver.mjs resume account-card --root /path/to/project
```

A roadmap's `scope` lists existing scanned source files; optional `createScope` lists paths that may be added. The CLI accepts these new paths through `plan --create path1,path2`. Existing replacements use complete file contents and require a `baseHash` matching `scan --full true`. New files use an explicit `op: "create"` patch with complete content, and can only target a declared, currently absent path. Creation supports JSON and the JS/TS/React formats read by the scanner; JSON is parsed as JSON and source files are parsed by TypeScript.

```json
{
  "id": "account-card",
  "name": "Account card",
  "description": "Shows an account summary.",
  "rationale": "The card and its data loader make one cohesive feature.",
  "files": ["src/account/Card.tsx", "src/account/data.ts"],
  "dependencies": [],
  "verification": ["npm test"],
  "patches": [
    {
      "path": "src/account/Card.tsx",
      "baseHash": "from-scan-output",
      "content": "replacement source text"
    }
  ]
}
```

For a roadmap with `createScope: ["src/account/card.json"]`, a proposal may include `{ "op": "create", "path": "src/account/card.json", "content": "{\"id\":\"account-card\"}\n" }` in `patches`. Include every generated file that should be reviewed in `createScope` (or existing `scope` when it already exists); undeclared generated changes fail the check. A path declared in `manifest.files` must have its create patch. Paths must be safe, unique, and absent when planned and checked; if a file appears after planning, check reports drift rather than overwriting it.

`propose` validates the boundary and stores the proposal. `check` verifies the contract, source fingerprint, patch hashes, and patch syntax, then creates an isolated Git branch and worktree under `.blocks/worktrees/`. It applies the proposed files there and runs the manifest's verification commands. After verification it captures the complete worktree change set: tracked and nonignored untracked files, plus the `.blocks` manifest even when ignored. Undeclared changes fail the check. `review` shows the complete change set and before/after content (or a binary summary). `approve` records the decision only if the worktree still matches the latest passing snapshot; any later file, mode, or symlink change blocks approval. The original checkout stays untouched. `reject ... --reason TEXT` records a rejection. `resume` rebuilds slice status from `events.jsonl`. A failed check or changed source cannot be approved.

`repair` replaces a pending or failed proposal but requires the same slice ID, implementation files, and path-and-operation set. It records a new event and resets the slice to proposed. A repair may revise content, but cannot silently add, remove, or change a creation or replacement operation.

The console can preview a candidate block from a folder and download its JSON proposal. For local declared blocks, it can also preview a new dependency connection with before/after manifests and download that as a proposal. It plays the recorded roadmap ledger and shows the files involved in each event. Browser actions never apply patches.

The project map opened by `block-beaver start` refreshes automatically from source and manifests. `block-beaver update` regenerates its offline HTML snapshot. The original console opened by `npm start` has a **Blocks** view rendered from the scanned registry; rescan there after changes. That console uses `index.html` and `src/app.js`; `docs/index.html` is the public landing page. See [Working in blocks](docs/BLOCK_WORKFLOW.md) for the standing AI editor and review process.

## Agent and worker interfaces

An agent adapter is any local executable that accepts one JSON request on stdin and returns one JSON response on stdout. Run it with `node bin/block-beaver.mjs agent --exec /path/to/adapter --scope src/one.ts,src/two.ts --create src/new-contract.json --root /path/to/project`. The request includes protocol version 1, the bounded source contents and hashes, `createScope`, graph nodes and edges for the existing scope, and the scan fingerprint. Worker `plan` requests can likewise provide `createScope`. The response contains `{"protocol":1,"proposals":[...]}`. Block Beaver validates each proposed boundary and patch path before returning it; `agent` does not save or apply anything. A proposal is passed through the ordinary `propose`, `check`, `review`, and `approve` operations.

For a separate code-changing process, start the authenticated worker with an explicit repository path and a strong token:

```sh
BLOCK_BEAVER_REPO=/path/to/project BLOCK_BEAVER_TOKEN=replace-with-a-random-secret npm run worker
```

It binds to `127.0.0.1:4174` and requires `Authorization: Bearer <token>` on every request. POST JSON to `/scan`, `/inspect`, `/search`, `/suggest`, `/plan`, `/propose`, `/repair`, `/check`, `/review`, `/approve`, `/reject`, or `/resume`. The worker rescans before source-dependent operations. The visual server on port 4173 has no mutation endpoints and never receives the worker token. Both servers are intended for trusted local use; do not expose either port through a proxy or tunnel. Scan only repositories you are authorized to read, and review verification commands before running them because they execute in a worktree.

## Contracts and boundaries

- `.blocks/manifests/*.json` in a target repository are feature contracts. They describe a cohesive boundary, implementation files, dependencies, rationale, and verification commands. Functions and components remain observed pieces, not forced into individual manifests.
- Existing TeaCake manifests remain authoritative. The adapter reads `docs/blocks/index.json` and its generated map, and adds those blocks to the graph with links to their implementation files. It delegates read-only `kit` queries to TeaCake's own dev kit, and a migration `check` in an isolated TeaCake worktree includes `pnpm blocks:check`. It does not generate a parallel TeaCake registry. TeaCake codegen remains an explicit step inside a proposed worktree; generated changes must be reviewed within that slice's scope.
- CLI JSON is the agent-neutral interface. An agent can generate a proposal file, but scope, validation, review and approval use the same commands as a person.
- `verification` commands run in the isolated worktree during `check`, without a shell. Use simple command-and-argument strings such as `npm test`; shell operators and substitutions are rejected. Review the branch and its test output before merging it.
- The scanner resolves local relative imports and the common `@/` → `src/` alias. Dynamic imports, runtime calls, arbitrary path aliases, and relationships hidden behind reexports may be absent. Edges are observations, not a claim that every runtime dependency has been found.

## Verify

```sh
npm run check
node bin/block-beaver.mjs scan --root /path/to/teacake
node bin/block-beaver.mjs scan --root /path/to/another/js-app
```

The focused tests cover source evidence, React rendering links, candidate boundaries, worktree approval, ledger replay, and source drift. The original implementation plan is in [Block Studio plan](docs/tasks/block-studio.md).

## Contribute and get help

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Use the issue templates for bugs and feature ideas. For a security issue, follow [SECURITY.md](SECURITY.md) and avoid public issues. [SUPPORT.md](SUPPORT.md) explains where to ask usage questions. Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

The [project page](https://sirnax.github.io/block-beaver/) shows the visual concept and quick start. [Release notes](CHANGELOG.md) and the [release process](docs/RELEASING.md) describe each version.
