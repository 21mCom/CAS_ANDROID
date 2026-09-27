<#
.SYNOPSIS
    Shared parser for the CAS test kit's tool-requirements.json declaration.

.DESCRIPTION
    Library script, not an entry point. Dot-sourced by windows-preflight.ps1,
    pixel-emulator.ps1, pixel11-gate0a.ps1, and mvp-install.ps1 so the
    read-cast-validate logic — including the apiLevel/platform consistency
    rule — exists in exactly one place. A future change to the declaration's
    shape or to the consistency rule lands here once instead of in every
    entry point.

    Get-ToolRequirements returns $null for any missing or invalid
    declaration; every caller fails closed with its own BLOCKED message and
    exit code 2. Never add a fallback default here: a broken kit must block,
    not guess.

    The Gate 0A Bash harness (measure-gate0a.sh) carries a sed-based
    validation of the same declaration; both sides must accept and reject the
    same declarations. scripts/check-tool-requirements-parity.sh (run by the
    windows-test-kit-entrypoints workflow) proves the two validators agree on
    a shared fixture set; keep this parser and that block in lockstep.
#>

function Get-ToolRequirements {
    # tool-requirements.json is the single source of truth for the JDK and
    # Android SDK prerequisites the kit enforces; the Gradle build and GitHub
    # Actions read the same file, the way gradle-version.txt pins the Gradle
    # release.
    param([string]$Path)

    if (-not $Path -or -not (Test-Path $Path -PathType Leaf)) {
        return $null
    }
    try {
        $parsed = Get-Content -Path $Path -Raw | ConvertFrom-Json
        $jdkMinimumMajor = [int]$parsed.jdk.minimumMajor
        $apiLevel = [int]$parsed.androidSdk.apiLevel
        $sdkPlatform = [string]$parsed.androidSdk.platform
        $buildToolsMinimum = [version]([string]$parsed.androidSdk.buildToolsMinimum)
        if ($jdkMinimumMajor -lt 1 -or $apiLevel -lt 1) {
            return $null
        }
        if ($sdkPlatform -cne ('android-{0}' -f $apiLevel)) {
            return $null
        }
        return [pscustomobject]@{
            jdkMinimumMajor = $jdkMinimumMajor
            apiLevel = $apiLevel
            sdkPlatform = $sdkPlatform
            buildToolsMinimum = $buildToolsMinimum
        }
    } catch {
        return $null
    }
}
