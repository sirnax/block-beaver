# Releasing Block Beaver

Block Beaver uses semantic versions and GitHub source releases. `package.json` remains `private: true`; a GitHub release is not an npm publication.

1. Open a pull request that updates `package.json`, `package-lock.json`, `CHANGELOG.md`, and any compatibility or migration notes. Review the diff and wait for required CI and security checks.
2. Merge into protected `main`. Confirm its checks pass and that the release commit is on `main`.
3. Create and push an annotated `vX.Y.Z` tag at that commit. The release workflow checks the tag against `package.json`, extracts that version's notes from `CHANGELOG.md`, reruns the checks, and publishes a GitHub release. A failed workflow leaves the tag available for investigation; never silently move a published tag.
4. Verify the release page, download/source links, badges, Pages site, and security reporting route. Record any correction in a followup patch release.

The first public release is **v0.1.0**. It supports Node.js 22, 24, and 26. CI runs on Linux for all three and on macOS and Windows with Node.js 24. The graph has the limitations recorded in the [changelog](../CHANGELOG.md).

This project uses a version pull request followed by a tag driven release. Release Please's default GitHub token does not trigger other workflows from its generated pull requests, which conflicts with this repository's required checks. A dedicated app token would add a credential to operate. The tag workflow keeps the branch protection and release steps explicit.
