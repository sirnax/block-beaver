# Security policy

Block Studio reads local source code and can run project supplied verification commands in a Git worktree. The optional worker can create roadmap files and worktrees. Treat a scanned repository and its verification commands as trusted local input.

## Report a vulnerability

Do not open a public issue for a vulnerability. Use the repository's **Report a vulnerability** option under **Security → Advisories** on GitHub. Include the affected version or commit, steps to reproduce, the impact, and a suggested fix if available. Do not include secrets or private source code in the report. The maintainer will acknowledge and triage reports through the advisory thread.

If private vulnerability reporting is not enabled yet, contact the maintainer through the private contact method on their GitHub profile. Public release is gated on enabling private vulnerability reporting.

## Supported versions

Until the first stable release, security fixes target the latest commit on the default branch. Earlier commits and development snapshots are not maintained separately.

## Local use boundary

- The visual console and worker bind to loopback and are for trusted local use only. Do not expose them through a public proxy or tunnel.
- Use a random worker token of at least 16 characters. Do not commit it or pass it to untrusted processes.
- `check` executes verification commands declared by a proposal. Review those commands and the proposed patch before running it.
- An agent adapter is a local executable. Run only adapters you trust; it receives source content from its declared scope.
