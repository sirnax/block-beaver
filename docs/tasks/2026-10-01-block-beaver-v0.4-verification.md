# Block Beaver 0.4.0 local verification

Release readiness is complete. [Final candidate evidence](2026-10-01-block-beaver-release-readiness.md#final-acceptance--complete) records green remote CI/security checks, trusted native Codex execution, eight accepted live-editor cases and the reviewed 67-file package at `e1b1529`.

The following sections preserve the original A–C local acceptance snapshot. Their pending remote/native checks and older artifact are historical and superseded by that final evidence.

A–C from the agreed design are implemented locally. E remains deferred. Nothing has been published.

## Historical A–C candidate

Runtime/source SHA-256: `066f9b6e694eeaabefd7ebb5d8793fc0472fbf2f64fa78ed1b98807ef532ad5b`.
All eight accepted live-editor cases recorded this same hash before and after execution.
Local branch: `codex/block-beaver-v0.4-design`; implementation commits `1bc1779`, `d931eed`, `4ca5e9b`.

## Verification

| Check | Result |
| --- | --- |
| Full source syntax, kernel budget and test suite: Node 22.18.0 | 310 passed,0 failed,0 skipped |
| Same suite: Node 24.21.0 | 310 passed,0 failed,0 skipped |
| Same suite: Node 26.10.0 | 310 passed,0 failed,0 skipped |
| Live Claude normal/bypass/failed/drift | 4/4 passed |
| Live Codex normal/bypass/failed/drift | 4/4 passed |
| Live-editor rubric | 96/96 checks passed |
| Actual generated and live browser views | Strict CSP, skins, history, app filters, evidence and repeated listener disposal passed; 0 console errors/warnings |
| Existing-system adoption fixture | Named manifest bytes unchanged, registry semantics retained, custom generation and differently named clone checks passed |
| Real tsx 4.23.15 fallback: Node 22/24 | CommonJS enum/default/named manifests and custom enum generation passed |
| Real ESLint 9.39.5 | Allowed/baseline/generated/directive cases exit0; literal violation exits1 |
| Runtime kernel | Dependency boundary and actual esbuild tree shaking passed;4,504/6,144 gzip bytes |
| Packed installation | Clean npm tarball transport, all exports, typed generation/check, idempotent install/upgrade, owner-preserving uninstall passed |
| Installed CommonJS kernel | Node 22,24,26 passed |

Normal editor runs used passing checks and ready review before approval, staged reviewed implementation/manifest/receipt files, invoked successful staged CLI audits, and regenerated current views. Bypass attempts reached the real Git commit hook and were rejected. Failed and drift cases produced failed-check evidence and no approvals or integration receipts. Installed guidance/native files/Git hooks remained intact.

Claude requested and actual model was Sonnet 5.5 at high effort, verified in all four runs. Codex requested GPT-6.1-Sol at medium effort; its events do not name the actual model. Claude native hooks executed. Codex native-hook execution was not observed because the fresh fixtures had no persisted hook trust; its workflow and Git commit-hook checks passed. No trust bypass or user trust-state edits were used.

## Artifact

The tested package is `block-beaver-0.4.0.tgz`,154152 packed bytes,66 files, SHA1 `f806d8a3a548eb682c9701aa1dc51a892536592a`. Smoke testing used normal npm tarball/cache transport in disposable repositories. The local file dependency was normalized to exact 0.4.0 after transport to avoid a lookup for this unpublished version. Runtime exports and kernel types are included; development-console top-level assets remain outside the package whitelist.

Native run JSON, logs and package inventory remain in the task's temporary evidence directory. The human-readable live report is `block-beaver-v040-live-report.md`; pack evidence is `block-beaver-final-pack/report.md`.

## Historical reviews and release limits

Parallel GPT owners implemented bounded subsystems. Sonnet implemented host setup, initial live-editor harness and generation/history. Opus reviewed family architecture and kernel/loader; Sonnet independently reviewed GPT-authored A and C integration. GPT independently reviewed Sonnet host and generation code. All material findings received public regressions or direct browser/runtime verification.

Remote Linux/Windows CI has not run in this local task. Codex native hooks require a separate trusted-editor check. Existing GitLab include-list and inherited tsconfig exclusion edits produce explicit manual-remediation diagnostics; additive owner JSON excludes are preserved on uninstall. The tree-shaking test explicitly skips if esbuild is absent, while the kernel size/dependency gate always runs. These limits are distinct from the eight-case workflow/commit-gate rubric that passed. Package and release publication require a separate instruction.
