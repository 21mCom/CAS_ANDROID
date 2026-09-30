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
        $raw = Get-Content -Path $Path -Raw
        $parsed = $raw | ConvertFrom-Json
        # Canonical-shape guard: the Gate 0A Bash harness validates this same
        # file with single-line sed extractions, so the declaration contract is
        # one field per line with unquoted numeric literals. A reformatted
        # declaration — compacted onto shared lines, or carrying numbers as
        # quoted strings — parses fine here but is rejected there, which is
        # exactly the workstation-passes/field-fails drift the parity gate
        # exists to catch. Reject any field that appears in a non-canonical
        # form so both validators accept and reject identical declarations.
        # Field order within the canonical shape is not contractual, and a
        # wholly absent field passes this guard to be caught by the
        # plausibility checks below (mirroring the harness's empty-extraction
        # rejection). A duplicated key with exactly one occurrence in
        # canonical form (a merge accident or careless hand-edit) also fails
        # here — occurrences outnumber canonical matches — and the Bash
        # harness mirrors this with an explicit duplicate-key count, so both
        # sides fail closed on that class.
        # The patterns use horizontal whitespace ONLY ([ \t], with an optional
        # trailing CR for CRLF line endings): \s would match a newline, so a
        # declaration reformatted with a line break after a field's colon
        # ("apiLevel":\n 35) would pass here while the harness's single-line
        # sed extraction rejects it — the same workstation-passes/field-fails
        # drift class. Keeping the guard horizontal-only makes both sides
        # reject that shape identically.
        $canonicalFields = @(
            @{ Key = 'minimumMajor';      Pattern = '(?m)^[ \t]*"minimumMajor"[ \t]*:[ \t]*\d+[ \t]*,?[ \t]*\r?$' }
            @{ Key = 'apiLevel';          Pattern = '(?m)^[ \t]*"apiLevel"[ \t]*:[ \t]*\d+[ \t]*,?[ \t]*\r?$' }
            @{ Key = 'platform';          Pattern = '(?m)^[ \t]*"platform"[ \t]*:[ \t]*"android-\d+"[ \t]*,?[ \t]*\r?$' }
            @{ Key = 'buildToolsMinimum'; Pattern = '(?m)^[ \t]*"buildToolsMinimum"[ \t]*:[ \t]*"[^"\r\n]+"[ \t]*,?[ \t]*\r?$' }
        )
        foreach ($field in $canonicalFields) {
            $occurrences = [regex]::Matches($raw, '"' + $field.Key + '"').Count
            $canonical = [regex]::Matches($raw, $field.Pattern).Count
            if ($occurrences -ne $canonical) {
                return $null
            }
        }
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
