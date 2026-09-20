# GitHub repository setup

These settings live on GitHub and cannot be enforced by files in this repository alone. Apply them to `sirnax/block-bot-dev` before making it public. The default branch is `main`.

## General

1. Set the description to: “Local architecture workspace for JavaScript, TypeScript, and React repositories.” Add relevant topics such as `developer-tools`, `typescript`, and `architecture`.
2. Keep Issues enabled. Enable Discussions if maintainers can answer usage questions there. Enable “Automatically delete head branches.”
3. Confirm GitHub detects the [Apache-2.0 license](../LICENSE) once the license commit is pushed.
4. Inspect every commit and Git blob for credentials, private data, copied third party material, and personal paths. Rotate and remove any discovered secret from history before public release.

## Actions and security

1. In **Settings → Actions → General**, set workflow permissions to **Read repository contents**. Allow actions pinned to a full commit SHA; the CI workflow uses pinned `actions/checkout` and `actions/setup-node` releases.
2. In **Settings → Security → Advanced Security**, enable dependency graph, Dependabot alerts, Dependabot security updates, and private vulnerability reporting. Enable CodeQL default setup for JavaScript and TypeScript if offered for the repository.
3. Confirm the private vulnerability link in the issue template works for a non-maintainer before changing visibility.
4. Review the first full CI run. The required status checks below must have run at least once before they can be selected in a ruleset.

## Protect `main`

Create a branch ruleset targeting `main`, with no bypass actors. The versioned [ruleset payload](github-main-ruleset.json) records the intended settings. Enable:

- Require a pull request before merging, with dismissal of stale approvals after new commits. The initial approval count is zero because `@sirnax` is the only collaborator; raise it to one when a second maintainer can review pull requests.
- Require conversation resolution and status checks before merging. Require these exact CI checks: `Check (Node 22)`, `Check (Node 24)`, `Check (Node 26)`, and `Dependency audit`.
- Require branches to be up to date before merging, unless merge queue is configured. Block force pushes and deletions.
- Apply rules to administrators as well. Keep the ruleset active and verify it against a test pull request.

The `CODEOWNERS` file names `@sirnax`. Enable code owner review only if the maintainer has a workable backup review arrangement; a sole owner can otherwise block routine fixes.

## Release

1. Complete [the public release checklist](PUBLIC_RELEASE_CHECKLIST.md).
2. Set a release tag only after the license and changelog are committed and the first CI run passes.
3. Make the repository public only after a final review of history, settings, and the first CI run.
4. Publish release notes from `CHANGELOG.md`, documenting supported Node versions and known limitations.
