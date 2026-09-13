---
name: Windows PowerShell script paths
description: Reliable script-relative output paths for the downloadable CAS Windows test kit.
---

Do not use `$PSScriptRoot` inside PowerShell parameter default expressions. Default path parameters to an empty string, then resolve the script directory and assign the default after the `param` block.

**Why:** On the field Windows machine, `$PSScriptRoot` was empty while a parameter default was evaluated, causing `Join-Path` to terminate the preflight before any checks ran.

**How to apply:** For every downloadable PowerShell entry point, derive the directory in the script body from `$PSScriptRoot`, then `$MyInvocation.MyCommand.Path`, then the current location. Exercise startup under Windows PowerShell before shipping.