# Project integration

## Purpose

Make Block Beaver usable in any target repository through one command. The tool installs portable AI editor guidance and generates a block view; users do not manually edit instructions or HTML. This extends the product beyond the guidance used to develop Block Beaver itself.

## Boundary and connections

- `src/project-integration.mjs`: managed project instructions and safe, repeatable setup.
- `src/project-files.mjs`: confined file access and preservation of concurrent edits.
- `src/block-map.mjs`: graph snapshot export and an HTML view derived from the authoritative registry and source graph.
- `src/project-watch.mjs`: refresh the view while a local viewing session is active.
- `bin/block-beaver.mjs`: `init`, `update`, and `start` commands.
- `templates/block-workflow.md`: workflow installed in the target project.
- `tests/project-integration.test.mjs`: disposable target repositories and CLI integration checks.
- README, block workflow, and changelog: installation and daily usage.

Reuse the existing scanner and registry adapters. Keep the existing roadmap/proposal/check/approval contract. Project instructions use portable CLI commands and relative paths; generated files remain under `.blocks/`. Editor instruction fragments live in AGENTS.md, CLAUDE.md, Cursor rules, and Copilot instructions. Preserve unrelated existing content.

## Acceptance

1. A fresh target can run `start` to install guidance and show its generated map; no target file editing is required.
2. Repeated setup is idempotent, preserves existing instructions, and refuses unsafe paths or ambiguous managed sections.
3. Adding or changing source and manifests changes the exported map; an active viewing session refreshes automatically. No generated view is treated as an authoritative registry.
4. Exported HTML safely renders repository-controlled text and loads without external assets. Empty projects remain usable.
5. Source scans remain read-only; setup and export are explicit product actions. An AI editor is instructed to use the existing bounded workflow and refresh the view after changes.
6. Focused tests and `npm run check` pass. Editor file installation is tested; live model compliance is not claimed.

## Verification

- `npm run check`: all 50 tests passed, including target-project setup, preservation, path safety, regeneration, and live HTTP refresh.
- Packed the current checkout, installed the archive offline in a temporary prefix, and ran the installed executable against a separate project. Its instructions and generated HTML were present.
- Opened the generated map in a browser, changed a fixture block manifest, and observed the name refresh automatically without navigating or requesting another scan. Stopped the session after verification.

Editor rule formats were checked against the official [Cursor rules](https://cursor.com/docs/rules), [Claude Code project memory](https://code.claude.com/docs/en/memory), and [VS Code custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions) documentation. Tests verify the installed files and product behavior, not whether every model follows the guidance in every editor session.
