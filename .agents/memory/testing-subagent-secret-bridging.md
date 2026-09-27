---
name: Testing subagent secret bridging
description: The Playwright testing subagent's shell has workspace secrets as env vars, but its browser/notebook runtime has no process.env — bridge secret values through a shell-written file, and say exactly which value goes in the file.
---

# Testing subagent secret bridging

When a browser test needs a secret (e.g. an API credential typed into a dialog), the testing subagent's **shell** has the workspace secrets as environment variables, but its Playwright/JS runtime does **not** expose `process.env` (the name is undefined there).

**Why:** During a credential-gated browser flow, the tester first grabbed the wrong value entirely (an enrollment *response* token saved from a curl response, not the enrollment credential from the env), and a later attempt to read `process.env.CAS_ALERT_TOKEN` in the browser-side runtime failed because `process` is undefined there. Three rounds were lost to credential mismatch.

**How to apply:** In the test plan, spell out the bridge: `printf '%s' "$SECRET_NAME" > /tmp/some-file` (no trailing newline) in the shell, then read that file from the browser script and use it for both the dialog answer and any expected-header assertion. Name the exact secret and warn against substituting values from API responses. Tell the tester to delete the file afterwards and never print the value.
