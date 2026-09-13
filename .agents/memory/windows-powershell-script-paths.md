---
name: Windows PowerShell script paths
description: Reliable script-relative output paths for the downloadable CAS Windows test kit.
---

Do not use `$PSScriptRoot` inside PowerShell parameter default expressions. Default path parameters to an empty string, then resolve the script directory and assign the default after the `param` block.

**Why:** On the field Windows machine, `$PSScriptRoot` was empty while a parameter default was evaluated, causing `Join-Path` to terminate the preflight before any checks ran.

**How to apply:** For every downloadable PowerShell entry point, derive the directory in the script body from `$PSScriptRoot`, then `$MyInvocation.MyCommand.Path`, then the current location. Exercise startup under Windows PowerShell before shipping.

Wrap a PowerShell pipeline in `@(...)` whenever downstream code relies on `.Count` or numeric indexing, even when the pipeline normally emits one path.

**Why:** The field workstation confirmed that an unwrapped single SDK-root result became a scalar string, so `[0]` returned the drive letter instead of the complete path.

**How to apply:** Preserve environment-variable candidate collections explicitly and include one-value Windows drive-path cases in PowerShell 5.1 regression checks.

Do not capture a native command's normal stderr with `2>&1` under Windows PowerShell 5.1 when the script uses `$ErrorActionPreference = 'Stop'`.

**Why:** The field workstation confirmed that successful `java -version` stderr became a terminating `NativeCommandError`, producing the script's synthetic `-1` result despite Java exiting successfully.

**How to apply:** Use `System.Diagnostics.Process` with both streams redirected, call `WaitForExit()`, and only then read the real exit code. Test a successful stderr-only command under Windows PowerShell 5.1.