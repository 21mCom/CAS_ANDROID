---
name: Direct Playwright browser proofs
description: When the testing subagent fails with infrastructure errors, run Playwright directly from the shell using the root pnpm store and the system chromium.
---

When the `testing`-kind subagent repeatedly fails with "Replit infrastructure issue", a browser proof can still be run directly:

- Import playwright from the pnpm store absolute path: `/home/runner/workspace/node_modules/.pnpm/playwright@<version>/node_modules/playwright/index.mjs` (no package.json declares it; resolution from /tmp or package dirs fails).
- Launch with the system browser: `chromium.launch({ executablePath: '/repl/tools/bin/chromium' })` — there is no `~/.cache/ms-playwright` browser download.
- Scripts can read secrets from `process.env` without printing them; a `.mjs` script run with `node` works fine.

**Why:** the testing subagent is the default for e2e, but it is an infrastructure dependency that flakes; the direct route unblocks time-critical browser proofs.

**How to apply:** only as a fallback after the testing subagent fails; keep proofs one-off and still clean up any credentials or data the proof creates.
