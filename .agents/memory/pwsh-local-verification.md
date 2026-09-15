---
name: Local PowerShell verification
description: How to sanity-check Windows PowerShell scripts locally, and the sandbox quirks involved.
---

pwsh is not preinstalled; `nix profile install nixpkgs#powershell` works but the profile does not survive a workspace restart — reinstall before each session. After install, `pwsh` is not on PATH for fresh shells: invoke `$HOME/.nix-profile/bin/pwsh`. Every pwsh process takes ~1–4 minutes to start in this sandbox, so batch everything into one background invocation and poll; a multi-check harness spawning child pwsh processes can take 15+ minutes total.

Two more Linux-vs-Windows quirks: `New-Item -ItemType SymbolicLink` fails with "No such file or directory" for paths containing backslashes (create the link with `ln -sf` in the shell instead), and `Join-Path` on Linux normalizes backslashes into real directory separators, so a Windows-path shim such as `ProgramFiles\Git\bin\bash.exe` must be created as real nested directories (`Git/bin/bash.exe`) for `Test-Path` to find it.

**Why:** Two verification rounds were lost to a wiped nix profile and to foreground timeouts before these quirks were understood.

**How to apply:** Parse-check a script with `[System.Management.Automation.Language.Parser]::ParseFile`. To exercise functions in scripts whose self-test blocks are Windows-only (e.g. the Gate 0A preflight's `-ParserRegressionCheck` asserts a `C:\Users\...` path and needs `ComSpec`), extract the `FunctionDefinitionAst` nodes for the target functions, dot-source them, and run the cases in a standalone harness. Leave the full self-test to the windows-latest CI workflow.
