# Plan: scoped file creation and complete worktree review

## Goal and evidence

Enable Block Beaver to carry a bounded conversion that adds architectural source files, while ensuring the reviewed and approved worktree is exactly the one that passed verification. The TeaCake TaskNode smoke run at Block Beaver `9991002e61ca5ee885b134be8cedbb91380d1e4f` stopped before `propose`: `plan` and `agent` rejected new paths as unscanned, and `propose` rejected a new-file patch as outside scope. A separate two-file fixture showed that `approve` accepted an unlisted file added after `check` and omitted by `review`.

This plan changes Block Beaver. Use small synthetic repositories for automated tests. Re-run the pinned TeaCake smoke fixture only as an integration check after the tool changes; its v2 behavior tests and frozen acceptance criteria remain the evaluator. Do not copy TeaCake source or local absolute paths into this repository.

## Design decisions

1. **Declare creation separately from existing source scope.** Add an optional `createScope` array to a roadmap and the agent request. CLI `plan` and `agent` accept `--create path1,path2`; the worker `plan` input accepts `createScope`. Existing `scope` continues to mean scanned files with hashes. Reject duplicate, existing, ignored, absolute, traversing, and symlink-escaping paths. Require at least one existing or created path. Keep the current 2 MB limit on existing source sent to an agent and apply a 2 MB limit to proposed creation content.
2. **Make creation an explicit patch operation.** A patch with `op: "create"`, `path`, and complete `content` requires a path in `createScope` and an absent target. Existing patches retain their current shape and mean replacement; their `baseHash` remains mandatory. A created file named in `manifest.files` is valid only if the proposal includes its create patch. Reject duplicate operations on one path. A creation patch cannot silently overwrite a file that appears after planning. Support JSON and the JS/TS/React formats used by the scanner; parse JSON as JSON and use TypeScript parsing for supported source extensions.
3. **Keep this release to creation and replacement.** Rename and deletion are separate operations with different preconditions and review needs. Add them only after this conversion demonstrates a need. `repair` may change content but must preserve the same path-and-operation set. Old roadmaps and proposals without `createScope` or `op` must continue to work.
4. **Bind approval to the entire reviewable worktree change.** After verification, enumerate changed tracked and nonignored untracked files relative to the worktree's base commit. Include the `.blocks` manifest explicitly even when `.blocks/` is ignored. Reject a passing `check` if a changed path lies outside the declared existing or create scope, apart from Block Beaver's own manifest. Save a deterministic snapshot of path, file type/mode, and content hash (or deletion state) with the `checks-passed` event. `review` presents that complete change set. `approve` recomputes the snapshot and rejects any difference, including an extra file, changed mode, symlink, or changed generated output. Use Git's null-delimited status with all nonignored untracked files and verify each path remains inside the worktree. Ignored dependency and build caches are outside the snapshot; declare any generated artifact that must be reviewed as a scoped path.

Example of the additive proposal shape:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "id": "example-block",
    "version": 1,
    "name": "Example block",
    "description": "Example boundary",
    "rationale": "One cohesive feature",
    "files": ["src/blocks/example.json"],
    "dependencies": [],
    "verification": ["npm test"]
  },
  "patches": [
    { "op": "create", "path": "src/blocks/example.json", "content": "{\"id\":\"example\"}\n" },
    { "path": "src/consumer.ts", "baseHash": "hash-from-scan", "content": "complete replacement source" }
  ]
}
```

The corresponding roadmap has `scope: ["src/consumer.ts"]` and `createScope: ["src/blocks/example.json"]`. The agent request supplies content and hashes for `scope`, and names `createScope` without pretending new files are graph nodes.

## Ordered work

### 1. Lock the failures with tests

**Files:** `tests/workflow.test.mjs`, `tests/scanner.test.mjs` or focused adjacent test files. **Dependency:** none.

- [ ] In a disposable Git fixture, demonstrate that a declared new JSON contract and TS selector cannot currently pass through `plan → agent → propose → check → review`.
- [ ] Demonstrate that a passing check followed by an unlisted worktree file is invisible to review and still accepted by approval. Keep a listed-file mutation control that is already rejected.
- [ ] Add rejection cases for a new-path collision, `..`/absolute path, symlink parent, duplicate patch, stale replacement hash, malformed JSON/TS, and a create patch outside `createScope`.

**Verify:** Focused `node --test` run shows the new success and integrity assertions failing for the expected reasons; existing tests still identify their prior behavior.

### 2. Add the creation contract and public inputs

**Files:** `src/contracts.mjs`, `src/agent.mjs`, `src/workflow.mjs`, `bin/block-beaver.mjs`, `worker.mjs`. **Dependency:** task 1.

- [ ] `plan --create` and worker `plan.createScope` persist validated planned paths; unchanged plans load with an empty creation scope.
- [ ] `agent --create` sends planned paths without reading nonexistent files or assigning fake hashes. Its response validator accepts only declared create patches and keeps the existing two-megabyte source limit and replacement-hash checks.
- [ ] `propose` and `repair` validate the operation/path relationship, allow `manifest.files` to name a created implementation file only with its patch, and preserve the existing file boundary on repair.

**Verify:** Focused contract, adapter, and workflow tests pass. Old proposal fixtures and the current CLI/worker inputs still pass without modification.

### 3. Apply and check created files safely

**Files:** `src/workflow.mjs` and focused workflow tests. **Dependency:** task 2.

- [ ] `check` tests absent-file preconditions independently of the scanner fingerprint, so a newly appeared JSON file causes a clear drift failure.
- [ ] Worktree preparation creates validated parent directories and writes the new content only inside the isolated worktree. Parsing uses the file format; verification commands see the created files.
- [ ] A repeated check or repair cannot carry unexplained edits from an earlier worktree state. Fail with an actionable error when unexpected paths are present; retain expected proposal paths for a bounded repair.

**Verify:** A two-file creation-and-replacement fixture reaches a passing `check`; collisions, malformed content, and scope escapes fail before any out-of-scope write. `resume` reports the resulting status correctly.

### 4. Capture and show the complete verified change

**Files:** `src/workflow.mjs`, workflow tests, and any small snapshot helper extracted from it. **Dependency:** task 3.

- [ ] `check` records the complete allowed change set and its digest after all verification commands finish. Verification-generated files must have been declared in existing or creation scope.
- [ ] `review` shows additions, replacements, generated changes, and the `.blocks` manifest from the actual worktree, with before/after content or a binary summary and hashes.
- [ ] `approve` compares the current complete snapshot with the latest passing event; adding, editing, deleting, changing mode, or replacing a path with a symlink after checks blocks approval. Rechecking a deliberate change records a new snapshot.

**Verify:** The formerly passing unlisted-file control fails at approval and is visible as an integrity problem in review. Valid checked changes still review and approve. An extra file produced by a verification command outside declared scope fails `check`.

### 5. Document the interface and rerun the conversion probe

**Files:** `README.md`, `CHANGELOG.md`, the CLI/worker tests affected by task 2. **Dependencies:** tasks 2–4.

- [ ] Document `--create`, `createScope`, the `op: "create"` proposal form, absent-file drift, repair boundaries, complete review, and approval behavior. Explain how generated files enter scope.
- [ ] Run `npm run check` and a fresh CLI/worker fixture from a clean checkout. Inspect the full Git diff of its generated worktree alongside `review` output.
- [ ] Re-run the pinned TeaCake TaskNode smoke fixture with a real Codex adapter. Require the previously frozen architecture and behavior criteria before calling it a conversion. Preserve the old blocked run and new request, response, diffs, checks, and report as separate evidence. If Codex produces a deficient proposal, record that as an agent result rather than a tool success.

**Verify:** The real adapter can submit a proposal with new files through `plan → agent → propose → check → review`; all declared verification passes and review accounts for every changed file. Approval is optional for the TeaCake experiment. The original TeaCake checkout and its data are not changed.

## Release gate

- [ ] Existing replacement-only proposals and ledger replay remain compatible.
- [ ] Creation requires explicit scope and absence; no path can escape the target worktree.
- [ ] Every tracked or nonignored untracked change, plus the Block Beaver manifest, is declared and shown in review or causes the check to fail.
- [ ] Approval rejects any change after the latest passing check.
- [ ] `npm run check` and the new focused tests pass; the README and changelog describe the user-visible contract.
- [ ] The TaskNode rerun reports whether actual architectural conversion passed, separately from Block Beaver's mechanics.

## Follow-up outside this release

The smoke graph missed TaskNode's literal dynamic import of its completion action. Add an evidenced edge for resolvable `import("literal")` calls and surface unresolved dynamic imports for manual impact review. This improves impact analysis, but it does not block file creation or worktree integrity and should be a separate scanner change with focused graph tests.
