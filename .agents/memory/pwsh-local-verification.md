---
name: Local PowerShell verification
description: How to sanity-check Windows PowerShell scripts locally, and the sandbox quirks involved.
---

pwsh is not preinstalled; `nix profile install nixpkgs#powershell` works but the profile does not survive a workspace restart — reinstall before each session. After install, `pwsh` is not on PATH for fresh shells: invoke `$HOME/.nix-profile/bin/pwsh`. Every pwsh process takes ~1–4 minutes to start in this sandbox, so batch everything into one background invocation and poll; a multi-check harness spawning child pwsh processes can take 15+ minutes total.

When a pwsh harness must fake Windows filesystem layout on Linux, remember backslashes in paths are directory separators to pwsh-on-Linux (`Join-Path`/`New-Item` behavior differs from Windows); build such shims as real nested directories with shell tools rather than through PowerShell cmdlets.

Two scripting gotchas that cost verification rounds: with `$ErrorActionPreference = 'Stop'`, `Write-Error` is terminating — a following `exit 2` never runs and the process exits 1, so deliberate exit codes need `Write-Host` + `exit`. And in test harnesses, `\$` inside a double-quoted PowerShell string still interpolates the variable (backslash is not an escape in PowerShell); use single-quoted regex patterns or a shell grep to assert on generated code.

Compress-Archive on sandboxed pwsh spins for many minutes at "0.0 MB/s" on even a few hundred KB when output is redirected — it is the Write-Progress rendering loop, not a hang; it does finish. Scripts that zip in CI should set `$ProgressPreference = 'SilentlyContinue'`.

**Why:** Two verification rounds were lost to a wiped nix profile and to foreground timeouts before these quirks were understood.

windows-preflight.ps1 cannot run to completion on Linux: the Git Bash candidate list does `Join-Path $env:ProgramFiles ...`, which throws a null-Path bind error (with `$ErrorActionPreference = 'Stop'`) because ProgramFiles is unset off-Windows. Only the early fail-closed paths (missing/invalid declarations, which exit 2 before the environment probes) are locally exercisable end-to-end; a full happy-path run must be left to the windows-latest CI workflow.

**How to apply:** Parse-check a script with `[System.Management.Automation.Language.Parser]::ParseFile`. To exercise functions in scripts whose self-test blocks are Windows-only (e.g. the Gate 0A preflight's `-ParserRegressionCheck` asserts a `C:\Users\...` path and needs `ComSpec`), extract the `FunctionDefinitionAst` nodes for the target functions, dot-source them, and run the cases in a standalone harness. Leave the full self-test to the windows-latest CI workflow. Packaging scripts that gate on check-tool-requirements-parity.sh can run end-to-end on Linux with `PARITY_PWSH=$HOME/.nix-profile/bin/pwsh`; a full gate + Compress-Archive run takes ~20-30 min here, so run it as a background task and poll.
