---
name: Windows PowerShell 5.1 native invocation traps
description: CAS launchers and the entry-point gate run under powershell.exe 5.1 on CI; native args with embedded quotes get mangled, and native stderr in 2>&1 captures under EAP=Stop throws NativeCommandError.
---

Two Windows PowerShell 5.1 behaviors have bitten the CAS CI launchers and neither reproduces under pwsh 7:

1. **Native argument encoding drops embedded double quotes.** `& $bash @('-c', 'echo "msg" >&2; exit 3')` under powershell.exe passes bash a truncated command (`echo ` exits 0) because 5.1 wraps space-containing args in quotes without escaping embedded ones. Keep native arguments quote-free.
2. **Native stderr aborts captures under EAP=Stop.** When a script sets `$ErrorActionPreference = 'Stop'` and captures `@(& native.exe 2>&1)`, the first stderr line arrives as an ErrorRecord and throws NativeCommandError, aborting the capture before any assertion runs. Drop to `$ErrorActionPreference = 'Continue'` around such captures, and keep simulated-failure messages on stdout.

**Why:** The first real windows-latest run of the packaged-kit workflow (2026-09-17) failed twice on exactly these: the harness-failure simulation looked successful, then the gate died with an unhandled NativeCommandError instead of its descriptive assertion. Local validation used pwsh 7, which handles both cases correctly, so only a real Windows runner exposed them.

**How to apply:** When editing pixel11-gate0a.ps1, test-windows-entrypoints.ps1, or any launcher/gate script that executes under powershell.exe, keep native args quote-free, prefer stdout for stub output, and guard 2>&1 captures. Do not trust a green pwsh-7 local check for these paths; confirm on a real Windows runner (GitHub workflow_dispatch works).
