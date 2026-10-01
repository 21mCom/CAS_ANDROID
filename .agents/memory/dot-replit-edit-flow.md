---
name: Editing .replit
description: Direct Edit/WriteFile on .replit is rejected; use the verifyAndReplaceDotReplit temp-file flow
---

The `Edit` tool fails on `.replit` (and `replit.nix`) with "Direct edits to .replit and replit.nix are not allowed".

**Why:** the platform schema-validates `.replit` before replacing it; bypassing that can brick workspace configuration.

**How to apply:** read the current `.replit`, write the FULL updated TOML to a temp file inside the workspace (e.g. `/home/runner/workspace/.replit.new`), then call `verifyAndReplaceDotReplit({ tempFilePath })` in CodeExecution. The temp file is consumed on success. Editing artifact service config is a different flow (`verifyAndReplaceArtifactToml`).
