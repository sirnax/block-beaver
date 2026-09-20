# Public release checklist

This records the v0.1.0 launch review. Check an item only after verifying the published result.

## Repository content

- [x] Choose Apache-2.0 and add a `LICENSE` file plus package metadata.
- [x] Review tracked files and reachable history for secrets, personal paths, private source, and third party material. Gitleaks scanned all reachable commits before publication with no findings.
- [x] Check that the TeaCake reference remains read only and no TeaCake source or proprietary assets were copied here.
- [ ] Confirm README commands, support route, conduct contact, and security reporting route work for an outside contributor.
- [x] Rename the GitHub repository to `block-beaver` and verify its links, badges, templates, and clone instructions.

## Quality and security

- [x] Run `npm ci --ignore-scripts` and `npm run check` on supported Node versions through GitHub Actions (Linux 22/24/26; macOS and Windows 24).
- [x] Run the dependency audit online and resolve high or critical findings (production audit passed).
- [x] Smoke test the visual console and worker: console root 200, foreign Host and Origin 403; worker scan 200 with a local test token, missing token 401, foreign Origin 403.
- [x] Review verification command execution and agent adapter trust instructions in `SECURITY.md`.

## GitHub configuration

- [x] Apply [GitHub setup](GITHUB_SETUP.md), including dependency alerts, private vulnerability reporting, native secret scanning with push protection, CodeQL, and an active `main` ruleset.
- [ ] Confirm required checks and one outside contributor pull request path work.
- [x] Publish the prepared `docs/` landing page through GitHub Pages with HTTP 200 for the page and artwork, and set the repository website field.
- [x] Decide and record the first release version, tag, and known limitations in [the changelog](../CHANGELOG.md) and [release process](RELEASING.md): v0.1.0.
