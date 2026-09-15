---
name: Local PowerShell verification
description: How to sanity-check Windows PowerShell scripts locally, and the sandbox quirks involved.
---

pwsh is not preinstalled; `nix profile install nixpkgs#powershell` works but the profile does not survive a workspace restart — reinstall before each session. Every pwsh process takes ~1–4 minutes to start in this sandbox, so batch everything into one background invocation and poll.

**Why:** Two verification rounds were lost to a wiped nix profile and to foreground timeouts before these quirks were understood.

**How to apply:** Parse-check a script with `[System.Management.Automation.Language.Parser]::ParseFile`. To exercise functions in scripts whose self-test blocks are Windows-only (e.g. the Gate 0A preflight's `-ParserRegressionCheck` asserts a `C:\Users\...` path and needs `ComSpec`), extract the `FunctionDefinitionAst` nodes for the target functions, dot-source them, and run the cases in a standalone harness. Leave the full self-test to the windows-latest CI workflow.
