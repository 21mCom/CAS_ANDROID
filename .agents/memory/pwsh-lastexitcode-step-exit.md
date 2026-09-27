---
name: pwsh CI steps propagate the last native command's exit code
description: A GitHub Actions pwsh step whose last native command exits non-zero fails the step even when every assertion passed — end negative-test steps with explicit exit 0.
---

A `shell: pwsh` step on GitHub Actions exits with `$LASTEXITCODE` of the LAST native command the script ran. Cmdlets afterwards (Write-Host, if-checks) do not reset it. So a negative-test step that intentionally runs a failing native command (a gate expected to exit 1, a preflight expected to exit 2) and then asserts on captured output goes RED with "Process completed with exit code N" **after** printing its success message — every assertion passed, yet the step failed.

**Why:** First real windows-latest run of the Windows test-kit workflow failed exactly this way on the API-floor negative step; the fix was to end each of the five negative-test pwsh steps with an explicit `exit 0` after the assertions, then the same run went green.

**How to apply:** In any pwsh CI step that captures a native command's output/exit code for assertions (`$PSNativeCommandUseErrorActionPreference = $false; $out = & python ... 2>&1; $code = $LASTEXITCODE; ...`), add `exit 0` as the final line. Assertion `throw`s still exit non-zero before reaching it, so the step stays honest. Bash steps don't need this when they end with `echo` (exit 0).
