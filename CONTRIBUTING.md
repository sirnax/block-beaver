# Contributing to Block Studio

Thanks for helping improve Block Studio. The project is early and the [plan](Block-Studio-PLAN.md) describes its intended boundaries. Please open an issue before a large change so the approach can be discussed.

## Set up

1. Install Node.js 22 or newer and Git.
2. Run `npm ci`.
3. Run `npm run check` before sending a pull request.

Use a small fixture repository or a temporary directory for tests that write `.blocks/` data. The TeaCake repository is a read-only reference; contributions must not depend on it being present. Add a focused test when changing the scanner, graph contract, roadmap state, patch validation, worker authorization, or other behavior with a regression risk.

## Pull requests

- Keep each pull request focused. Explain the behavior, why it matters, and how you tested it.
- Describe any graph schema or manifest compatibility impact.
- Avoid committing generated worktrees, credentials, private repository content, or personal absolute paths.
- Add a changelog entry for user visible changes.
- Expect maintainers to review the code and CI checks before merging. A passing check is not approval to merge.

The project will choose a license before accepting outside contributions. If you plan to contribute before then, discuss licensing with the maintainer first.
