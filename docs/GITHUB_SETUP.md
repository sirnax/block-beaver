# GitHub repository setup

These settings live on GitHub and cannot be enforced by files in this repository alone. The default branch is `main`.

## General

1. Set the description to: “Block Beaver: a local architecture workspace for JavaScript, TypeScript, and React repositories.” Add relevant topics such as `developer-tools`, `typescript`, and `architecture`.
2. Keep Issues enabled. Enable Discussions if maintainers can answer usage questions there. Enable “Automatically delete head branches.”
3. Confirm GitHub detects the [Apache-2.0 license](../LICENSE) once the license commit is pushed.
4. Inspect every commit and Git blob for credentials, private data, copied third party material, and personal paths. Rotate and remove any discovered secret from history before public release.

## Actions and security

1. In **Settings → Actions → General**, set workflow permissions to **Read repository contents**. Allow actions pinned to a full commit SHA; the CI workflow uses pinned `actions/checkout` and `actions/setup-node` releases.
2. In **Settings → Security → Advanced Security**, enable dependency graph, Dependabot alerts, Dependabot security updates, secret scanning, and private vulnerability reporting. The versioned CodeQL workflow analyzes JavaScript and TypeScript after the repository becomes public.
3. Confirm the private vulnerability link in the issue template works for a non-maintainer before advertising the public release.
4. Review the first full CI run. The required status checks below must have run at least once before they can be selected in a ruleset.

## Protect `main`

Create a branch ruleset targeting `main`, with no bypass actors. The versioned [ruleset payload](github-main-ruleset.json) records the intended settings. Enable:

- Require a pull request before merging, with dismissal of stale approvals after new commits. The initial approval count is zero because `@sirnax` is the only collaborator; raise it to one when a second maintainer can review pull requests.
- Require conversation resolution and status checks before merging. Require these exact CI checks: `Check (Node 22)`, `Check (Node 24)`, `Check (Node 26)`, `Platform (macos-latest)`, `Platform (windows-latest)`, `Dependency audit`, `Gitleaks`, and `Analyze (JavaScript and TypeScript)` after each has passed on public `main` and a pull request.
- Require branches to be up to date before merging, unless merge queue is configured. Block force pushes and deletions.
- Apply rules to administrators as well. Keep the ruleset active and verify it against a test pull request.

The `CODEOWNERS` file names `@sirnax`. Enable code owner review only if the maintainer has a workable backup review arrangement; a sole owner can otherwise block routine fixes.

## Release

Follow [the release process](RELEASING.md) and [the public release checklist](PUBLIC_RELEASE_CHECKLIST.md). Make the repository public after the history review and CI pass, then enable the public security features. Tag the checked `main` commit to publish the release notes from `CHANGELOG.md`.

## Project page

The standalone landing page is [docs/index.html](index.html), with local CSS and artwork under `docs/assets/`. Publish it with **Settings → Pages → Deploy from a branch → `main` → `/docs`**, then verify the published links and add its URL to the repository's website field.
