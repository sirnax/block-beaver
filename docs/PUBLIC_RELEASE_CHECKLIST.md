# Public release checklist

This is the review gate before changing repository visibility or advertising a first release.

## Repository content

- [x] Choose Apache-2.0 and add a `LICENSE` file plus package metadata.
- [ ] Review every tracked file and every reachable Git commit for secrets, personal paths, private source, and third party material. Rotate any exposed secret before rewriting history.
- [ ] Check that the TeaCake reference remains read only and no TeaCake source or proprietary assets were copied here.
- [ ] Confirm README commands, support route, conduct contact, and security reporting route work for an outside contributor.
- [x] Rename the GitHub repository to `block-beaver` and verify its links, badges, templates, and clone instructions.

## Quality and security

- [ ] Run `npm ci --ignore-scripts` and `npm run check` on supported Node versions through GitHub Actions.
- [ ] Run the dependency audit online and resolve high or critical findings.
- [ ] Smoke test the visual console and worker on a clean local fixture, including rejected foreign Host and Origin headers and missing worker tokens.
- [ ] Review verification command execution and agent adapter trust instructions in `SECURITY.md`.

## GitHub configuration

- [ ] Apply [GitHub setup](GITHUB_SETUP.md), including dependency alerts, private vulnerability reporting, and an active `main` ruleset.
- [ ] Confirm required checks and one outside contributor pull request path work.
- [ ] Publish the prepared `docs/` landing page through GitHub Pages only when public access is intended; verify badges, links, mobile layout, and the repository website field.
- [ ] Decide and record the first release version, tag, and known limitations.
