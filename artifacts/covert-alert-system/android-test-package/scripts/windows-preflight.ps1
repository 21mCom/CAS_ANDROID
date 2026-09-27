<#
.SYNOPSIS
    Read-only Windows preflight for the CAS Pixel Gate 0A workstation.

.DESCRIPTION
    Checks the local Java, Android SDK, ADB, Gradle, and Git Bash prerequisites and writes
    JSON and Markdown results that can be attached to a CAS field-run record.
    The default mode does not install software, change device state, or send
    messages. -PrepareSdk can install missing SDK packages only after an
    explicit confirmation.

    This script never installs an APK, changes Device Owner state, reboots a
    device, sends input, sends a message, or captures evidence.
#>

[CmdletBinding()]
param(
    [ValidateSet('physical', 'emulator', 'both')]
    [string]$Target = 'physical',

    [string]$OutputDirectory = '',

    [switch]$PrepareSdk,

    [switch]$ConfirmSdkInstall,

    [switch]$StartupSmokeCheck,

    [switch]$ParserRegressionCheck
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = if ($PSScriptRoot) {
    $PSScriptRoot
} elseif ($MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
    (Get-Location).Path
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $scriptDirectory '..\preflight-results'
}
if ($StartupSmokeCheck) {
    Write-Output ('CAS_STARTUP_OK windows-preflight OutputDirectory={0}' -f [System.IO.Path]::GetFullPath($OutputDirectory))
    exit 0
}

# The validated tool-requirements.json parse is shared with the other kit
# entry points (pixel-emulator.ps1, pixel11-gate0a.ps1, mvp-install.ps1) via
# this dot-sourced library, so the declaration's shape and consistency rule
# live in exactly one place. A kit missing the library is incomplete and is
# handled as a BLOCKED tools.requirements outcome in the main flow below.
$script:SharedToolRequirementsParser = Join-Path $scriptDirectory 'cas-tool-requirements.ps1'
$script:SharedToolRequirementsParserAvailable = Test-Path $script:SharedToolRequirementsParser -PathType Leaf
if ($script:SharedToolRequirementsParserAvailable) {
    . $script:SharedToolRequirementsParser
}

$script:Checks = @()
$script:Actions = @()

function Add-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][ValidateSet('PASS', 'WARN', 'BLOCKED', 'SKIPPED')][string]$Status,
        [Parameter(Mandatory = $true)][bool]$Required,
        [string]$Observed = '',
        [string]$Expected = '',
        [string[]]$NextSteps = @()
    )

    $script:Checks += [pscustomobject]@{
        id = $Id
        name = $Name
        status = $Status
        required = $Required
        observed = $Observed
        expected = $Expected
        nextSteps = @($NextSteps)
    }

    $color = switch ($Status) {
        'PASS' { 'Green' }
        'WARN' { 'Yellow' }
        'BLOCKED' { 'Red' }
        default { 'DarkGray' }
    }
    Write-Host ('[{0}] {1}: {2}' -f $Status, $Name, $Observed) -ForegroundColor $color
}

function Find-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Name)

    try {
        $command = Get-Command $Name -ErrorAction Stop
        if ($command.Path) {
            return $command.Path
        }
        return $command.Source
    } catch {
        return $null
    }
}

function Invoke-Tool {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Arguments = @()
    )

    try {
        $output = (& $Path @Arguments 2>&1 | Out-String).Trim()
        return [pscustomobject]@{
            succeeded = ($LASTEXITCODE -eq 0)
            exitCode = $LASTEXITCODE
            output = $output
        }
    } catch {
        return [pscustomobject]@{
            succeeded = $false
            exitCode = -1
            output = $_.Exception.Message
        }
    }
}

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Arguments = ''
    )

    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $Path
        $startInfo.Arguments = $Arguments
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardError = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.CreateNoWindow = $true

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) {
            return [pscustomobject]@{
                started = $false
                exitCode = $null
                output = 'The process did not start.'
            }
        }

        $standardError = $process.StandardError.ReadToEnd()
        $standardOutput = $process.StandardOutput.ReadToEnd()
        $process.WaitForExit()
        $combinedOutput = ($standardError + [Environment]::NewLine + $standardOutput).Trim()
        return [pscustomobject]@{
            started = $true
            exitCode = $process.ExitCode
            output = $combinedOutput
        }
    } catch {
        return [pscustomobject]@{
            started = $false
            exitCode = $null
            output = $_.Exception.Message
        }
    }
}

function Get-JavaVersionInfo {
    param([string]$Text)

    if (-not $Text -or $Text -notmatch 'version\s+"(?<version>\d+(?:\.\d+)*(?:_\d+)?)"') {
        return $null
    }

    $version = $Matches['version']
    $components = @($version -split '[._]')
    $major = [int]$components[0]
    if ($major -eq 1 -and $components.Count -gt 1) {
        $major = [int]$components[1]
    }

    return [pscustomobject]@{
        version = $version
        major = $major
    }
}

function Test-JdkMeetsRequirement {
    # The Java decision consumes the declared minimum so a drift test with
    # altered requirement values exercises the same path the real check uses.
    param(
        [Parameter(Mandatory = $true)]$JavaVersion,
        [Parameter(Mandatory = $true)]$Requirements
    )

    return $JavaVersion.major -ge $Requirements.jdkMinimumMajor
}

function Get-Version {
    param([string]$Text)

    $match = [regex]::Match($Text, '(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?')
    if (-not $match.Success) {
        return $null
    }
    $patch = if ($match.Groups[3].Success) { $match.Groups[3].Value } else { '0' }
    try {
        return [version]::new(
            [int]$match.Groups[1].Value,
            [int]$match.Groups[2].Value,
            [int]$patch
        )
    } catch {
        return $null
    }
}

function Get-ExpectedGradleVersion {
    # gradle-version.txt is the single source of truth for the Gradle release
    # that CI builds with; the preflight compares the workstation against it.
    param([string]$Path)

    if (-not $Path -or -not (Test-Path $Path -PathType Leaf)) {
        return $null
    }
    return Get-Version ((Get-Content -Path $Path -Raw).Trim())
}

# Get-ToolRequirements is provided by the dot-sourced cas-tool-requirements.ps1
# library (loaded near the top of this script); do not re-add a local copy.

function Test-GradleVersionAlignment {
    param(
        [Parameter(Mandatory = $true)][version]$Actual,
        [Parameter(Mandatory = $true)][version]$Expected
    )

    if ($Actual -lt $Expected) {
        return 'older'
    }
    if ($Actual.Major -ne $Expected.Major -or $Actual.Minor -ne $Expected.Minor) {
        return 'different'
    }
    return 'aligned'
}

if ($ParserRegressionCheck) {
    $driveSdkRoot = 'C:\Users\CAS_DEV\AppData\Local\Android\Sdk'
    $resolvedSdkRoots = @(
        @($driveSdkRoot, '') |
            Where-Object { $_ -and $_.Trim() } |
            ForEach-Object { [System.IO.Path]::GetFullPath($_.Trim()) } |
            Select-Object -Unique
    )
    if ($resolvedSdkRoots.Count -ne 1 -or $resolvedSdkRoots[0] -ne $driveSdkRoot) {
        throw ('SDK root regression: expected {0}, received {1}' -f $driveSdkRoot, ($resolvedSdkRoots -join ', '))
    }

    $regressionRequirements = Get-ToolRequirements (Join-Path $scriptDirectory '..\tool-requirements.json')
    if ($null -eq $regressionRequirements) {
        throw 'Tool requirements regression: tool-requirements.json next to the package root was not parsed.'
    }
    if ($null -ne (Get-ToolRequirements (Join-Path $scriptDirectory '..\does-not-exist.json'))) {
        throw 'Tool requirements regression: a missing requirements file must not produce requirements.'
    }
    # apifloor-gate: allow-begin -- deliberate invalid-declaration fixture: it must hardcode concrete values to prove an unparsable declaration is rejected, not derived.
    $invalidRequirementsFile = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-req-invalid-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        '{"jdk":{"minimumMajor":"seventeen"},"androidSdk":{"apiLevel":35,"platform":"android-35","buildToolsMinimum":"35.0.0"}}' |
            Set-Content -Path $invalidRequirementsFile -Encoding Ascii
        if ($null -ne (Get-ToolRequirements $invalidRequirementsFile)) {
            throw 'Tool requirements regression: an invalid requirements file must not produce requirements.'
        }
    } finally {
        Remove-Item -Force $invalidRequirementsFile -ErrorAction SilentlyContinue
    }
    # apifloor-gate: allow-end

    # Missing-declaration regression: the preflight must refuse to guess tool
    # requirements. Run a copy of this script with no tool-requirements.json
    # beside it and require a BLOCKED tools.requirements outcome with exit
    # code 2 — there is no built-in fallback block anymore, so a broken kit
    # can no longer be downgraded to a WARN with substituted minimums.
    $brokenKitDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-req-missing-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $brokenKitDirectory 'scripts') | Out-Null
    try {
        $brokenPreflight = Join-Path $brokenKitDirectory 'scripts\windows-preflight.ps1'
        Copy-Item -Path $PSCommandPath -Destination $brokenPreflight
        # The preflight dot-sources the shared tool-requirements parser; copy it
        # so the only broken piece in this fixture is the missing declaration.
        Copy-Item -Path $script:SharedToolRequirementsParser -Destination (Join-Path $brokenKitDirectory 'scripts')
        $currentPowerShell = (Get-Process -Id $PID).Path
        $brokenOutput = @(& $currentPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $brokenPreflight -OutputDirectory (Join-Path $brokenKitDirectory 'results') 2>&1)
        $brokenExitCode = $LASTEXITCODE
        $brokenText = ($brokenOutput | Out-String)
        if ($brokenExitCode -ne 2) {
            throw ('Missing-declaration regression: the preflight exited {0} without tool-requirements.json; a broken kit must abort with exit 2. Output: {1}' -f $brokenExitCode, $brokenText)
        }
        if ($brokenText -notmatch '\[BLOCKED\] Tool requirements declaration') {
            throw ('Missing-declaration regression: the preflight did not fail the tools.requirements check. Output: {0}' -f $brokenText)
        }
        if ($brokenText -notmatch 'Restore the complete, unmodified test kit') {
            throw ('Missing-declaration regression: the preflight did not tell the operator to restore the kit. Output: {0}' -f $brokenText)
        }
        if ($brokenText -match 'Java command') {
            throw ('Missing-declaration regression: the preflight continued past the missing declaration and guessed tool requirements. Output: {0}' -f $brokenText)
        }
        if (Get-ChildItem -Path $brokenKitDirectory -Recurse -Filter 'cas-windows-preflight-*.json' -ErrorAction SilentlyContinue) {
            throw 'Missing-declaration regression: the preflight wrote a result file for a broken kit.'
        }
    } finally {
        Remove-Item -Recurse -Force $brokenKitDirectory -ErrorAction SilentlyContinue
    }

    # Missing-parser regression: a kit whose shared parser file was dropped is
    # just as broken as one missing the declaration. The preflight must fail
    # closed with the same BLOCKED tools.requirements outcome and exit 2
    # instead of crashing on the absent dot-source or guessing requirements.
    $parserlessKitDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-req-parserless-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $parserlessKitDirectory 'scripts') | Out-Null
    try {
        Copy-Item -Path $PSCommandPath -Destination (Join-Path $parserlessKitDirectory 'scripts\windows-preflight.ps1')
        Copy-Item -Path (Join-Path $scriptDirectory '..\tool-requirements.json') -Destination $parserlessKitDirectory
        $currentPowerShell = (Get-Process -Id $PID).Path
        $parserlessOutput = @(& $currentPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $parserlessKitDirectory 'scripts\windows-preflight.ps1') -OutputDirectory (Join-Path $parserlessKitDirectory 'results') 2>&1)
        $parserlessExitCode = $LASTEXITCODE
        $parserlessText = ($parserlessOutput | Out-String)
        if ($parserlessExitCode -ne 2) {
            throw ('Missing-parser regression: the preflight exited {0} without cas-tool-requirements.ps1; a broken kit must abort with exit 2. Output: {1}' -f $parserlessExitCode, $parserlessText)
        }
        if ($parserlessText -notmatch '\[BLOCKED\] Tool requirements declaration') {
            throw ('Missing-parser regression: the preflight did not fail the tools.requirements check. Output: {0}' -f $parserlessText)
        }
        if ($parserlessText -notmatch 'cas-tool-requirements\.ps1') {
            throw ('Missing-parser regression: the preflight did not name the missing shared parser. Output: {0}' -f $parserlessText)
        }
        if (Get-ChildItem -Path $parserlessKitDirectory -Recurse -Filter 'cas-windows-preflight-*.json' -ErrorAction SilentlyContinue) {
            throw 'Missing-parser regression: the preflight wrote a result file for a broken kit.'
        }
    } finally {
        Remove-Item -Recurse -Force $parserlessKitDirectory -ErrorAction SilentlyContinue
    }

    $javaCases = @(
        @{ Version = '17.0.2'; ExpectedMajor = 17 },
        @{ Version = '21.0.4'; ExpectedMajor = 21 },
        @{ Version = '25.0.4.1'; ExpectedMajor = 25 },
        @{ Version = '26'; ExpectedMajor = 26 },
        @{ Version = '11.0.20'; ExpectedMajor = 11 },
        @{ Version = '1.8.0_392'; ExpectedMajor = 8 }
    )
    foreach ($case in $javaCases) {
        $actual = Get-JavaVersionInfo ('openjdk version "{0}" 2026-08-18 LTS' -f $case.Version)
        if ($null -eq $actual -or $actual.version -ne $case.Version -or $actual.major -ne $case.ExpectedMajor) {
            throw ('Java version regression: {0} was not parsed as major {1}' -f $case.Version, $case.ExpectedMajor)
        }
    }

    # Drift test: an altered requirements file (different from the declared
    # values) must change the JDK pass/fail decisions. This catches a hardcoded
    # threshold in Test-JdkMeetsRequirement that a same-value comparison cannot.
    # toolreq-gate: allow-begin -- deliberate drift fixture: the altered values must differ from tool-requirements.json to prove the thresholds are not hardcoded.
    # apifloor-gate: allow-begin -- deliberate drift fixture: the altered values must hardcode non-declared numbers to prove the thresholds are derived, not fixed.
    # jdkfloor-gate: allow-begin -- deliberate drift fixture: the altered-minimum assertion compares against a non-declared JDK major to prove the threshold is derived, not fixed.
    $driftDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-req-drift-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $driftDirectory | Out-Null
    try {
        $driftFile = Join-Path $driftDirectory 'tool-requirements.json'
        '{"jdk":{"minimumMajor":21},"androidSdk":{"apiLevel":36,"platform":"android-36","buildToolsMinimum":"36.0.0"}}' |
            Set-Content -Path $driftFile -Encoding Ascii
        $driftedRequirements = Get-ToolRequirements $driftFile
        if ($null -eq $driftedRequirements -or $driftedRequirements.jdkMinimumMajor -ne 21 -or
            $driftedRequirements.apiLevel -ne 36 -or $driftedRequirements.sdkPlatform -ne 'android-36' -or
            $driftedRequirements.buildToolsMinimum -ne [version]'36.0.0') {
            throw 'Tool requirements drift regression: the altered requirements file was not parsed into the altered values.'
        }
        $driftCases = @(
            @{ Version = '17.0.2'; ExpectedPass = $false },
            @{ Version = '20.0.2'; ExpectedPass = $false },
            @{ Version = '21.0.4'; ExpectedPass = $true },
            @{ Version = '25.0.4.1'; ExpectedPass = $true }
        )
        foreach ($case in $driftCases) {
            $actual = Get-JavaVersionInfo ('openjdk version "{0}" 2026-08-18 LTS' -f $case.Version)
            if ((Test-JdkMeetsRequirement -JavaVersion $actual -Requirements $driftedRequirements) -ne $case.ExpectedPass) {
                throw ('Java minimum drift regression: {0} produced the wrong decision against an altered minimum of 21.' -f $case.Version)
            }
        }
    } finally {
        Remove-Item -Recurse -Force $driftDirectory -ErrorAction SilentlyContinue
    }
    # jdkfloor-gate: allow-end
    # apifloor-gate: allow-end
    # toolreq-gate: allow-end
    foreach ($invalidOutput in @('', 'garbage')) {
        if ($null -ne (Get-JavaVersionInfo $invalidOutput)) {
            throw ('Java invalid-output regression: expected no version for "{0}".' -f $invalidOutput)
        }
    }

    # Deliberate self-test fixtures: these concrete versions exercise the
    # alignment rules; they are not a fallback release. The preflight itself
    # fails closed when gradle-version.txt is missing (proven below).
    $gradleAlignmentCases = @(
        @{ Actual = '8.9.0'; Expected = '8.9'; Alignment = 'aligned' },
        @{ Actual = '8.9.1'; Expected = '8.9'; Alignment = 'aligned' },
        @{ Actual = '8.8.0'; Expected = '8.9'; Alignment = 'older' },
        @{ Actual = '8.10.2'; Expected = '8.9'; Alignment = 'different' },
        @{ Actual = '9.0.0'; Expected = '8.9'; Alignment = 'different' }
    )
    foreach ($case in $gradleAlignmentCases) {
        $actualAlignment = Test-GradleVersionAlignment -Actual ([version]$case.Actual) -Expected ([version]$case.Expected)
        if ($actualAlignment -ne $case.Alignment) {
            throw ('Gradle alignment regression: {0} vs {1} was {2}, expected {3}.' -f
                $case.Actual, $case.Expected, $actualAlignment, $case.Alignment)
        }
    }
    $declaredGradle = Get-ExpectedGradleVersion (Join-Path $scriptDirectory '..\gradle-version.txt')
    if ($null -eq $declaredGradle) {
        throw 'Gradle version-file regression: gradle-version.txt next to the package root was not parsed.'
    }
    if ($null -ne (Get-ExpectedGradleVersion (Join-Path $scriptDirectory '..\does-not-exist.txt'))) {
        throw 'Gradle version-file regression: a missing version file must not produce a version.'
    }

    # Missing/invalid Gradle-declaration regression: the preflight must refuse
    # to guess the Gradle release. Run a copy of this script with a valid
    # tool-requirements.json but no (or an invalid) gradle-version.txt and
    # require a BLOCKED gradle.expected-version outcome with exit code 2 —
    # there is no built-in fallback release anymore, so a broken kit can no
    # longer be downgraded to a WARN with a substituted Gradle version.
    foreach ($gradleFixture in @('missing', 'invalid')) {
        $gradleBrokenKitDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-gradle-{0}-{1}' -f $gradleFixture, [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path (Join-Path $gradleBrokenKitDirectory 'scripts') | Out-Null
        try {
            $gradleBrokenPreflight = Join-Path $gradleBrokenKitDirectory 'scripts\windows-preflight.ps1'
            Copy-Item -Path $PSCommandPath -Destination $gradleBrokenPreflight
            # The preflight dot-sources the shared tool-requirements parser and
            # reads the tool declaration; copy both so the only broken piece in
            # this fixture is the Gradle declaration.
            Copy-Item -Path $script:SharedToolRequirementsParser -Destination (Join-Path $gradleBrokenKitDirectory 'scripts')
            Copy-Item -Path (Join-Path $scriptDirectory '..\tool-requirements.json') -Destination $gradleBrokenKitDirectory
            if ($gradleFixture -eq 'invalid') {
                # apifloor-gate: allow-begin -- deliberate invalid-declaration fixture: the unparsable content must be concrete to prove the declaration is rejected, not derived.
                'not-a-gradle-release' | Set-Content -Path (Join-Path $gradleBrokenKitDirectory 'gradle-version.txt') -Encoding Ascii
                # apifloor-gate: allow-end
            }
            $currentPowerShell = (Get-Process -Id $PID).Path
            $gradleBrokenOutput = @(& $currentPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $gradleBrokenPreflight -OutputDirectory (Join-Path $gradleBrokenKitDirectory 'results') 2>&1)
            $gradleBrokenExitCode = $LASTEXITCODE
            $gradleBrokenText = ($gradleBrokenOutput | Out-String)
            if ($gradleBrokenExitCode -ne 2) {
                throw ('Missing-Gradle-declaration regression ({0}): the preflight exited {1}; a broken kit must abort with exit 2. Output: {2}' -f $gradleFixture, $gradleBrokenExitCode, $gradleBrokenText)
            }
            if ($gradleBrokenText -notmatch '\[BLOCKED\] Gradle version declaration') {
                throw ('Missing-Gradle-declaration regression ({0}): the preflight did not fail the gradle.expected-version check. Output: {1}' -f $gradleFixture, $gradleBrokenText)
            }
            if ($gradleBrokenText -notmatch 'Restore the complete, unmodified test kit') {
                throw ('Missing-Gradle-declaration regression ({0}): the preflight did not tell the operator to restore the kit. Output: {1}' -f $gradleFixture, $gradleBrokenText)
            }
            if ($gradleBrokenText -match 'Gradle command') {
                throw ('Missing-Gradle-declaration regression ({0}): the preflight continued past the missing declaration and guessed the Gradle release. Output: {1}' -f $gradleFixture, $gradleBrokenText)
            }
            if (Get-ChildItem -Path $gradleBrokenKitDirectory -Recurse -Filter 'cas-windows-preflight-*.json' -ErrorAction SilentlyContinue) {
                throw ('Missing-Gradle-declaration regression ({0}): the preflight wrote a result file for a broken kit.' -f $gradleFixture)
            }
        } finally {
            Remove-Item -Recurse -Force $gradleBrokenKitDirectory -ErrorAction SilentlyContinue
        }
    }

    $javaShimDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-java-regression-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $javaShimDirectory | Out-Null
    try {
        $javaShim = Join-Path $javaShimDirectory 'java-version.cmd'
        @(
            '@echo off',
            '>&2 echo openjdk version "25.0.4.1" 2026-08-18 LTS',
            'exit /b 0'
        ) | Set-Content -Path $javaShim -Encoding Ascii
        $capturedJava = Invoke-CapturedProcess -Path $env:ComSpec -Arguments ('/d /c ""{0}""' -f $javaShim)
        $capturedVersion = Get-JavaVersionInfo $capturedJava.output
        if (-not $capturedJava.started -or $capturedJava.exitCode -ne 0 -or
            $null -eq $capturedVersion -or $capturedVersion.version -ne '25.0.4.1') {
            throw ('Java stderr-capture regression: started={0}, exit={1}, output={2}' -f
                $capturedJava.started, $capturedJava.exitCode, $capturedJava.output)
        }
    } finally {
        Remove-Item -Recurse -Force $javaShimDirectory -ErrorAction SilentlyContinue
    }

    Write-Output 'CAS_PARSER_REGRESSION_OK windows-preflight'
    exit 0
}

function Test-PathEntry {
    param([Parameter(Mandatory = $true)][string]$PathEntry)

    $entries = @($env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') } | Where-Object { $_ })
    $wanted = $PathEntry.Trim().TrimEnd('\')
    return ($entries | Where-Object { $_ -ieq $wanted }).Count -gt 0
}

function Get-SdkManagerPath {
    param([string]$SdkRoot)

    if (-not $SdkRoot) {
        return $null
    }

    $latest = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
    if (Test-Path $latest -PathType Leaf) {
        return $latest
    }

    $cmdlineTools = Join-Path $SdkRoot 'cmdline-tools'
    if (Test-Path $cmdlineTools -PathType Container) {
        $candidate = Get-ChildItem $cmdlineTools -Directory |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin\sdkmanager.bat' } |
            Where-Object { Test-Path $_ -PathType Leaf } |
            Select-Object -First 1
        if ($candidate) {
            return $candidate
        }
    }
    return $null
}

function Get-OverallStatus {
    if (@($script:Checks | Where-Object { $_.status -eq 'BLOCKED' }).Count -gt 0) {
        return 'BLOCKED'
    }
    if (@($script:Checks | Where-Object { $_.status -eq 'WARN' }).Count -gt 0) {
        return 'WARN'
    }
    return 'PASS'
}

function Convert-ToMarkdownCell {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return ''
    }
    return (($Value.ToString() -replace '\|', '\|') -replace "`r?`n", ' ')
}

Write-Host ''
Write-Host 'CAS Pixel Gate 0A - Windows workstation preflight' -ForegroundColor Cyan
Write-Host ('Target mode: {0}' -f $Target)
Write-Host 'Default behavior is read-only. No APK, device policy, reboot, message, or evidence action is performed.'
Write-Host ''

if (-not $script:SharedToolRequirementsParserAvailable) {
    # A kit missing the shared parser was tampered with or incompletely
    # copied. Fail closed with the same BLOCKED outcome as a missing
    # declaration instead of crashing on the absent dot-source.
    Add-Check `
        -Id 'tools.requirements' `
        -Name 'Tool requirements declaration' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed ('The shared parser scripts\cas-tool-requirements.ps1 is missing from the kit at {0}.' -f $script:SharedToolRequirementsParser) `
        -Expected 'cas-tool-requirements.ps1 ships with the kit and parses tool-requirements.json for every kit script.' `
        -NextSteps @('Restore the complete, unmodified test kit, then rerun the preflight; the preflight does not guess tool requirements when its parser is missing.')
    Write-Host ''
    Write-Host 'The preflight cannot continue because scripts\cas-tool-requirements.ps1 is missing. Restore the complete, unmodified test kit and rerun.' -ForegroundColor Red
    exit 2
}

$toolRequirementsFile = Join-Path $scriptDirectory '..\tool-requirements.json'
$toolRequirements = Get-ToolRequirements $toolRequirementsFile
if ($null -eq $toolRequirements) {
    # A missing or invalid declaration means the kit was tampered with or
    # incompletely copied. There is no built-in fallback: guessing minimums
    # would downgrade a broken kit to a WARN and let a field run start from
    # unverifiable prerequisites, so the preflight stops here.
    Add-Check `
        -Id 'tools.requirements' `
        -Name 'Tool requirements declaration' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed ('{0} is missing or does not contain valid requirements.' -f $toolRequirementsFile) `
        -Expected 'tool-requirements.json declares the JDK and Android SDK prerequisites the preflight enforces.' `
        -NextSteps @('Restore the complete, unmodified test kit, then rerun the preflight; the preflight does not guess tool requirements when this file is missing.')
    Write-Host ''
    Write-Host 'The preflight cannot continue without a valid tool-requirements.json. Restore the complete, unmodified test kit and rerun.' -ForegroundColor Red
    exit 2
}
Add-Check `
    -Id 'tools.requirements' `
    -Name 'Tool requirements declaration' `
    -Status 'PASS' `
    -Required $false `
    -Observed ('JDK {0}+, {1}, build-tools {2}+' -f $toolRequirements.jdkMinimumMajor, $toolRequirements.sdkPlatform, $toolRequirements.buildToolsMinimum) `
    -Expected 'tool-requirements.json declares the JDK and Android SDK prerequisites the preflight enforces.'
$jdkRequirementText = 'JDK {0} or newer' -f $toolRequirements.jdkMinimumMajor
$buildToolsRequirementText = 'Build-tools {0} or newer' -f $toolRequirements.buildToolsMinimum

$gradleVersionFile = Join-Path $scriptDirectory '..\gradle-version.txt'
$expectedGradle = Get-ExpectedGradleVersion $gradleVersionFile
if ($null -eq $expectedGradle) {
    # A missing or invalid gradle-version.txt means the kit was tampered with
    # or incompletely copied. There is no built-in fallback: substituting a
    # guessed Gradle release would downgrade a broken kit to a WARN and let a
    # field run build with a release CI never exercised, so the preflight
    # stops here, the same way it does for a missing tool-requirements.json.
    Add-Check `
        -Id 'gradle.expected-version' `
        -Name 'Gradle version declaration' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed ('{0} is missing or does not contain a version.' -f $gradleVersionFile) `
        -Expected 'gradle-version.txt declares the Gradle release CI builds with.' `
        -NextSteps @('Restore the complete, unmodified test kit, then rerun the preflight; the preflight does not guess the Gradle release when this file is missing.')
    Write-Host ''
    Write-Host 'The preflight cannot continue without a valid gradle-version.txt. Restore the complete, unmodified test kit and rerun.' -ForegroundColor Red
    exit 2
}
$expectedGradleText = ('Gradle {0} (the release CI builds with)' -f $expectedGradle)

$sdkRoot = $null
$sdkRootCandidates = @(
    @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME) |
        Where-Object { $_ -and $_.Trim() } |
        ForEach-Object { [System.IO.Path]::GetFullPath($_.Trim()) } |
        Select-Object -Unique
)

if ($sdkRootCandidates.Count -eq 0) {
    Add-Check `
        -Id 'environment.android-sdk' `
        -Name 'Android SDK environment variables' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'ANDROID_SDK_ROOT and ANDROID_HOME are both empty.' `
        -Expected 'Set ANDROID_SDK_ROOT or ANDROID_HOME to the Android SDK folder.' `
        -NextSteps @(
            'Install Android Studio or the Android command-line tools with user consent.',
            'Set ANDROID_SDK_ROOT to the SDK folder, usually %LOCALAPPDATA%\Android\Sdk.',
            'Close and reopen this window, then run the preflight again.'
        )
} else {
    $sdkRoot = $sdkRootCandidates[0]
    $sdkVariableStatus = 'PASS'
    $sdkVariableObserved = 'Using {0}' -f $sdkRoot
    $sdkVariableNextSteps = @()
    if ($sdkRootCandidates.Count -gt 1) {
        if ($sdkRootCandidates[0].TrimEnd('\') -ine $sdkRootCandidates[1].TrimEnd('\')) {
            $sdkVariableStatus = 'BLOCKED'
            $sdkVariableObserved = 'ANDROID_SDK_ROOT and ANDROID_HOME point to different folders.'
            $sdkVariableNextSteps = @('Set both variables to the same SDK folder, or clear the older variable, then rerun this check.')
        } else {
            $sdkVariableObserved = 'ANDROID_SDK_ROOT and ANDROID_HOME agree on {0}' -f $sdkRoot
        }
    }
    Add-Check `
        -Id 'environment.android-sdk' `
        -Name 'Android SDK environment variables' `
        -Status $sdkVariableStatus `
        -Required $true `
        -Observed $sdkVariableObserved `
        -Expected 'ANDROID_SDK_ROOT or ANDROID_HOME points to the Android SDK folder.' `
        -NextSteps $sdkVariableNextSteps
}

$javaHome = $env:JAVA_HOME
$javaHomePath = if ($javaHome) { [System.IO.Path]::GetFullPath($javaHome.Trim()) } else { $null }
$javaPath = if ($javaHomePath) { Join-Path $javaHomePath 'bin\java.exe' } else { Find-CommandPath 'java.exe' }

if (-not $javaHomePath) {
    Add-Check `
        -Id 'environment.java-home' `
        -Name 'JAVA_HOME' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'JAVA_HOME is not set.' `
        -Expected ('JAVA_HOME points to a {0} installation.' -f $jdkRequirementText) `
        -NextSteps @(
            ('Install a {0} with user consent.' -f $jdkRequirementText),
            'Set JAVA_HOME to the JDK folder, not its bin folder.',
            'Close and reopen this window, then rerun the preflight.'
        )
} elseif (-not (Test-Path $javaHomePath -PathType Container)) {
    Add-Check `
        -Id 'environment.java-home' `
        -Name 'JAVA_HOME' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed ('JAVA_HOME does not exist: {0}' -f $javaHomePath) `
        -Expected ('JAVA_HOME points to a {0} installation.' -f $jdkRequirementText) `
        -NextSteps @('Correct JAVA_HOME to the installed JDK folder, then reopen this window.')
} else {
    Add-Check `
        -Id 'environment.java-home' `
        -Name 'JAVA_HOME' `
        -Status 'PASS' `
        -Required $true `
        -Observed $javaHomePath `
        -Expected ('JAVA_HOME points to a {0} installation.' -f $jdkRequirementText)
}

if (-not $javaPath -or -not (Test-Path $javaPath -PathType Leaf)) {
    Add-Check `
        -Id 'java.command' `
        -Name 'Java command' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'java.exe was not found.' `
        -Expected 'java.exe is available from JAVA_HOME\bin or PATH.' `
        -NextSteps @('Add the JDK bin folder to PATH, reopen this window, and rerun the preflight.')
} else {
    $javaResult = Invoke-CapturedProcess -Path $javaPath -Arguments '-version'
    $javaVersion = Get-JavaVersionInfo $javaResult.output
    if (-not $javaResult.started) {
        Add-Check `
            -Id 'java.command' `
            -Name 'Java command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('java.exe could not start. {0}' -f $javaResult.output) `
            -Expected ('{0}.' -f $jdkRequirementText) `
            -NextSteps @(('Install or select a working {0}, then rerun the preflight.' -f $jdkRequirementText))
    } elseif ($javaResult.exitCode -ne 0) {
        Add-Check `
            -Id 'java.command' `
            -Name 'Java command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('java.exe failed with exit code {0}. {1}' -f $javaResult.exitCode, $javaResult.output) `
            -Expected ('{0}.' -f $jdkRequirementText) `
            -NextSteps @(('Install or select a working {0}, then rerun the preflight.' -f $jdkRequirementText))
    } elseif ($null -eq $javaVersion) {
        Add-Check `
            -Id 'java.command' `
            -Name 'Java command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('java.exe did not report a version. {0}' -f $javaResult.output) `
            -Expected ('{0}.' -f $jdkRequirementText) `
            -NextSteps @(('Install or select a working {0}, then rerun the preflight.' -f $jdkRequirementText))
    } elseif (-not (Test-JdkMeetsRequirement -JavaVersion $javaVersion -Requirements $toolRequirements)) {
        Add-Check `
            -Id 'java.command' `
            -Name 'Java command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('Java {0} (major {1}) at {2}' -f $javaVersion.version, $javaVersion.major, $javaPath) `
            -Expected ('{0}.' -f $jdkRequirementText) `
            -NextSteps @(('Install {0} and point JAVA_HOME and PATH to it.' -f $jdkRequirementText))
    } else {
        Add-Check `
            -Id 'java.command' `
            -Name 'Java command' `
            -Status 'PASS' `
            -Required $true `
            -Observed ('Java {0} (major {1}) at {2}' -f $javaVersion.version, $javaVersion.major, $javaPath) `
            -Expected ('{0}.' -f $jdkRequirementText)
    }
}

$javaBin = if ($javaHomePath) { Join-Path $javaHomePath 'bin' } else { $null }
if ($javaBin -and (Test-Path $javaBin -PathType Container) -and (Test-PathEntry $javaBin)) {
    Add-Check `
        -Id 'path.java' `
        -Name 'Java PATH entry' `
        -Status 'PASS' `
        -Required $true `
        -Observed $javaBin `
        -Expected 'JAVA_HOME\bin is present in PATH.'
} else {
    Add-Check `
        -Id 'path.java' `
        -Name 'Java PATH entry' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'The JDK bin folder is not present in PATH.' `
        -Expected 'JAVA_HOME\bin is present in PATH.' `
        -NextSteps @('Add JAVA_HOME\bin to PATH, close and reopen this window, then rerun the preflight.')
}

$adbPath = Find-CommandPath 'adb.exe'
$adbExpectedPath = if ($sdkRoot) { Join-Path $sdkRoot 'platform-tools\adb.exe' } else { $null }
if (-not $sdkRoot) {
    Add-Check `
        -Id 'android.sdk-folder' `
        -Name 'Android SDK folder' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'Android SDK location is unknown.' `
        -Expected 'An existing Android SDK folder.' `
        -NextSteps @('Set ANDROID_SDK_ROOT or ANDROID_HOME, then rerun the preflight.')
} elseif (-not (Test-Path $sdkRoot -PathType Container)) {
    Add-Check `
        -Id 'android.sdk-folder' `
        -Name 'Android SDK folder' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed ('SDK folder does not exist: {0}' -f $sdkRoot) `
        -Expected 'An existing Android SDK folder.' `
        -NextSteps @('Correct the Android SDK environment variable, then rerun the preflight.')
} else {
    Add-Check `
        -Id 'android.sdk-folder' `
        -Name 'Android SDK folder' `
        -Status 'PASS' `
        -Required $true `
        -Observed $sdkRoot `
        -Expected 'An existing Android SDK folder.'
}

if ($sdkRoot -and (Test-Path $adbExpectedPath -PathType Leaf)) {
    Add-Check `
        -Id 'android.platform-tools' `
        -Name 'Android platform-tools' `
        -Status 'PASS' `
        -Required $true `
        -Observed $adbExpectedPath `
        -Expected 'platform-tools\adb.exe exists in the selected SDK.'
} else {
    Add-Check `
        -Id 'android.platform-tools' `
        -Name 'Android platform-tools' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'platform-tools\adb.exe was not found in the selected SDK.' `
        -Expected 'platform-tools\adb.exe exists in the selected SDK.' `
        -NextSteps @(
            'Install Android SDK Platform-Tools from Android Studio SDK Manager, or use the approved command-line tools.',
            'Do not download an untrusted adb.exe from a third-party site.'
        )
}

$platformToolsPath = if ($sdkRoot) { Join-Path $sdkRoot 'platform-tools' } else { $null }
if ($platformToolsPath -and (Test-PathEntry $platformToolsPath)) {
    Add-Check `
        -Id 'path.platform-tools' `
        -Name 'platform-tools PATH entry' `
        -Status 'PASS' `
        -Required $true `
        -Observed $platformToolsPath `
        -Expected 'The SDK platform-tools folder is present in PATH.'
} else {
    Add-Check `
        -Id 'path.platform-tools' `
        -Name 'platform-tools PATH entry' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'The SDK platform-tools folder is not present in PATH.' `
        -Expected 'The SDK platform-tools folder is present in PATH.' `
        -NextSteps @('Add the platform-tools folder to PATH, close and reopen this window, then rerun the preflight.')
}

if (-not $adbPath -and $adbExpectedPath -and (Test-Path $adbExpectedPath -PathType Leaf)) {
    $adbPath = $adbExpectedPath
}

if (-not $adbPath) {
    Add-Check `
        -Id 'adb.command' `
        -Name 'ADB command' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'adb.exe was not found on PATH.' `
        -Expected 'ADB is available as a working platform-tools command.' `
        -NextSteps @('Fix the platform-tools PATH entry, reopen this window, and rerun the preflight.')
} else {
    $adbResult = Invoke-Tool -Path $adbPath -Arguments @('version')
    if (-not $adbResult.succeeded) {
        Add-Check `
            -Id 'adb.command' `
            -Name 'ADB command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('ADB did not respond successfully. {0}' -f $adbResult.output) `
            -Expected 'ADB responds to adb version.' `
            -NextSteps @('Confirm the platform-tools installation is complete and rerun the preflight.')
    } else {
        $adbVersionLine = ($adbResult.output -split "`r?`n" | Where-Object { $_ -match 'Android Debug Bridge' } | Select-Object -First 1)
        Add-Check `
            -Id 'adb.command' `
            -Name 'ADB command' `
            -Status 'PASS' `
            -Required $true `
            -Observed ($adbVersionLine | ForEach-Object { $_.Trim() }) `
            -Expected 'ADB responds to adb version.'
    }
}

$buildToolsPath = if ($sdkRoot) { Join-Path $sdkRoot 'build-tools' } else { $null }
$buildTools = @()
if ($buildToolsPath -and (Test-Path $buildToolsPath -PathType Container)) {
    $buildTools = @(Get-ChildItem $buildToolsPath -Directory | Where-Object {
        $null -ne (Get-Version $_.Name)
    } | Sort-Object { Get-Version $_.Name } -Descending)
}
$minimumBuildTools = $toolRequirements.buildToolsMinimum
$selectedBuildTools = $buildTools | Where-Object { (Get-Version $_.Name) -ge $minimumBuildTools } | Select-Object -First 1
if ($selectedBuildTools) {
    Add-Check `
        -Id 'android.build-tools' `
        -Name 'Android build-tools' `
        -Status 'PASS' `
        -Required $true `
        -Observed $selectedBuildTools.Name `
        -Expected ('{0}.' -f $buildToolsRequirementText)
} else {
    Add-Check `
        -Id 'android.build-tools' `
        -Name 'Android build-tools' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed ('No build-tools {0} or newer was found.' -f $toolRequirements.buildToolsMinimum) `
        -Expected ('{0}.' -f $buildToolsRequirementText) `
        -NextSteps @(('Install Android SDK {0}, then rerun the preflight.' -f $buildToolsRequirementText))
}

$requiredPlatformJar = if ($sdkRoot) { Join-Path $sdkRoot ('platforms\{0}\android.jar' -f $toolRequirements.sdkPlatform) } else { $null }
if ($requiredPlatformJar -and (Test-Path $requiredPlatformJar -PathType Leaf)) {
    Add-Check `
        -Id 'android.api-platform' `
        -Name ('Android API {0} platform' -f $toolRequirements.apiLevel) `
        -Status 'PASS' `
        -Required $true `
        -Observed $requiredPlatformJar `
        -Expected ('platforms\{0}\android.jar exists.' -f $toolRequirements.sdkPlatform)
} else {
    Add-Check `
        -Id 'android.api-platform' `
        -Name ('Android API {0} platform' -f $toolRequirements.apiLevel) `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed ('Android API {0} was not found in the selected SDK.' -f $toolRequirements.apiLevel) `
        -Expected ('platforms\{0}\android.jar exists.' -f $toolRequirements.sdkPlatform) `
        -NextSteps @(('Install Android SDK Platform {0}, then rerun the preflight.' -f $toolRequirements.apiLevel))
}

$bashCandidates = @(
    (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
    (Join-Path $env:ProgramFiles 'Git\usr\bin\bash.exe')
)
if (${env:ProgramFiles(x86)}) {
    $bashCandidates += Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'
}
$bashPath = $bashCandidates |
    Where-Object { $_ -and (Test-Path $_ -PathType Leaf) } |
    Select-Object -First 1
if (-not $bashPath) {
    $bashPath = Find-CommandPath 'bash.exe'
}
if ($bashPath) {
    Add-Check `
        -Id 'git-bash.command' `
        -Name 'Git Bash command' `
        -Status 'PASS' `
        -Required $true `
        -Observed $bashPath `
        -Expected 'Git Bash is available for the guarded Pixel 11 Gate 0A runner.'
} else {
    Add-Check `
        -Id 'git-bash.command' `
        -Name 'Git Bash command' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'Git Bash bash.exe was not found.' `
        -Expected 'Git Bash is available for the guarded Pixel 11 Gate 0A runner.' `
        -NextSteps @('Install approved Git for Windows, close and reopen this window, then rerun the preflight.')
}

# The Gradle declaration was validated fail-closed next to the tool
# requirements above: a kit that reached this line carries a parsed
# gradle-version.txt in $expectedGradle / $expectedGradleText.
$gradlePath = Find-CommandPath 'gradle.exe'
if (-not $gradlePath) {
    $gradlePath = Find-CommandPath 'gradle'
}
if (-not $gradlePath) {
    Add-Check `
        -Id 'gradle.command' `
        -Name 'Gradle command' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'gradle was not found on PATH.' `
        -Expected ('{0} is available on PATH.' -f $expectedGradleText) `
        -NextSteps @(
            ('Install the approved {0} distribution with user consent.' -f $expectedGradleText),
            'Add its bin folder to PATH, close and reopen this window, then rerun the preflight.'
        )
} else {
    $gradleResult = Invoke-Tool -Path $gradlePath -Arguments @('--version')
    $gradleVersion = Get-Version $gradleResult.output
    if (-not $gradleResult.succeeded -or $null -eq $gradleVersion) {
        Add-Check `
            -Id 'gradle.command' `
            -Name 'Gradle command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('Gradle did not report a version. {0}' -f $gradleResult.output) `
            -Expected $expectedGradleText `
            -NextSteps @('Install or select a working Gradle distribution matching the declared version, then rerun the preflight.')
    } else {
        $gradleAlignment = Test-GradleVersionAlignment -Actual $gradleVersion -Expected $expectedGradle
        if ($gradleAlignment -eq 'older') {
            Add-Check `
                -Id 'gradle.command' `
                -Name 'Gradle command' `
                -Status 'BLOCKED' `
                -Required $true `
                -Observed ('Gradle {0}' -f $gradleVersion) `
                -Expected $expectedGradleText `
                -NextSteps @(('Upgrade Gradle to {0} or newer, then rerun the preflight.' -f $expectedGradle))
        } elseif ($gradleAlignment -eq 'different') {
            Add-Check `
                -Id 'gradle.command' `
                -Name 'Gradle command' `
                -Status 'WARN' `
                -Required $true `
                -Observed ('Gradle {0} at {1}' -f $gradleVersion, $gradlePath) `
                -Expected ('Gradle {0}.x, matching the CI-pinned release in gradle-version.txt.' -f $expectedGradle) `
                -NextSteps @(
                    ('CI builds this package with Gradle {0}; a different major.minor on this workstation was never exercised by CI.' -f $expectedGradle),
                    ('Install the approved Gradle {0} distribution, or document this WARN in the field-run record before building.' -f $expectedGradle)
                )
        } else {
            Add-Check `
                -Id 'gradle.command' `
                -Name 'Gradle command' `
                -Status 'PASS' `
                -Required $true `
                -Observed ('Gradle {0} at {1}' -f $gradleVersion, $gradlePath) `
                -Expected $expectedGradleText
        }
    }
}

$sdkManagerPath = Get-SdkManagerPath $sdkRoot
if ($sdkManagerPath) {
    Add-Check `
        -Id 'android.command-line-tools' `
        -Name 'Android command-line tools' `
        -Status 'PASS' `
        -Required $false `
        -Observed $sdkManagerPath `
        -Expected 'sdkmanager.bat is available for optional, confirmed SDK preparation.'
} else {
    $commandLineToolsStatus = if ($PrepareSdk) { 'BLOCKED' } else { 'SKIPPED' }
    $commandLineToolsNextSteps = if ($PrepareSdk) {
        @('Install the official Android SDK Command-line Tools before using -PrepareSdk.')
    } else {
        @()
    }
    Add-Check `
        -Id 'android.command-line-tools' `
        -Name 'Android command-line tools' `
        -Status $commandLineToolsStatus `
        -Required $false `
        -Observed 'sdkmanager.bat was not found.' `
        -Expected 'sdkmanager.bat is available if this script will prepare SDK packages.' `
        -NextSteps $commandLineToolsNextSteps
}

if ($Target -eq 'physical' -or $Target -eq 'both') {
    if (-not $adbPath) {
        Add-Check `
            -Id 'device.physical' `
            -Name 'Physical-device ADB status' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed 'ADB is unavailable, so the physical-device status cannot be read.' `
            -Expected 'An authorized physical device appears as device in adb devices -l.' `
            -NextSteps @('Complete the ADB checks above before connecting the approved Pixel.')
    } else {
        $deviceOutput = (Invoke-Tool -Path $adbPath -Arguments @('devices', '-l')).output
        $physicalLines = @($deviceOutput -split "`r?`n" | Where-Object {
            $_ -match '^[^\s]+(\s+device|\s+unauthorized|\s+offline)(\s|$)' -and $_ -notmatch '^emulator-'
        })
        $authorizedPhysical = @($physicalLines | Where-Object { $_ -match '^\S+\s+device(\s|$)' })
        $unauthorizedPhysical = @($physicalLines | Where-Object { $_ -match '^\S+\s+(unauthorized|offline)(\s|$)' })
        if ($authorizedPhysical.Count -gt 0) {
            Add-Check `
                -Id 'device.physical' `
                -Name 'Physical-device ADB status' `
                -Status 'PASS' `
                -Required $true `
                -Observed ('Authorized physical device detected: {0}' -f ($authorizedPhysical -join '; ')) `
                -Expected 'An authorized physical device appears as device in adb devices -l.'
        } elseif ($unauthorizedPhysical.Count -gt 0) {
            Add-Check `
                -Id 'device.physical' `
                -Name 'Physical-device ADB status' `
                -Status 'BLOCKED' `
                -Required $true `
                -Observed ('Physical device is not authorized: {0}' -f ($unauthorizedPhysical -join '; ')) `
                -Expected 'An authorized physical device appears as device in adb devices -l.' `
                -NextSteps @(
                    'Unlock the device and accept the RSA debugging prompt on the device screen.',
                    'If no prompt appears, revoke USB debugging authorizations in Developer options, reconnect, and retry.',
                    'Do not use this script to change Device Owner state or install an APK.'
                )
        } else {
            Add-Check `
                -Id 'device.physical' `
                -Name 'Physical-device ADB status' `
                -Status 'BLOCKED' `
                -Required $true `
                -Observed 'No physical device is currently visible to ADB.' `
                -Expected 'An authorized physical device appears as device in adb devices -l.' `
                -NextSteps @(
                    'For a physical run, connect the approved Pixel with USB debugging enabled.',
                    'Unlock it and accept the RSA prompt, then rerun this preflight.',
                    'If this is only a workstation setup check, this warning can be resolved at the field site.'
                )
        }
    }
} else {
    Add-Check `
        -Id 'device.physical' `
        -Name 'Physical-device ADB status' `
        -Status 'SKIPPED' `
        -Required $false `
        -Observed 'Skipped because target mode is emulator.' `
        -Expected 'Not evaluated.'
}

if ($Target -eq 'emulator' -or $Target -eq 'both') {
    $emulatorPath = if ($sdkRoot) { Join-Path $sdkRoot 'emulator\emulator.exe' } else { $null }
    if ($emulatorPath -and (Test-Path $emulatorPath -PathType Leaf)) {
        Add-Check `
            -Id 'android.emulator' `
            -Name 'Android Emulator tool' `
            -Status 'PASS' `
            -Required $true `
            -Observed $emulatorPath `
            -Expected 'emulator\emulator.exe exists in the selected SDK.'
    } else {
        Add-Check `
            -Id 'android.emulator' `
            -Name 'Android Emulator tool' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed 'emulator.exe was not found in the selected SDK.' `
            -Expected 'emulator\emulator.exe exists in the selected SDK.' `
            -NextSteps @('Install the Android Emulator package with user consent, then rerun the preflight.')
    }

    if (-not $adbPath) {
        Add-Check `
            -Id 'device.emulator' `
            -Name 'Emulator ADB status' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed 'ADB is unavailable, so emulator status cannot be read.' `
            -Expected 'A running emulator appears as an authorized adb device.' `
            -NextSteps @('Complete the ADB checks above before starting the approved emulator.')
    } else {
        $deviceOutput = (Invoke-Tool -Path $adbPath -Arguments @('devices', '-l')).output
        $emulatorLines = @($deviceOutput -split "`r?`n" | Where-Object {
            $_ -match '^emulator-\S+\s+(device|unauthorized|offline)(\s|$)'
        })
        $authorizedEmulator = @($emulatorLines | Where-Object { $_ -match '^emulator-\S+\s+device(\s|$)' })
        if ($authorizedEmulator.Count -gt 0) {
            Add-Check `
                -Id 'device.emulator' `
                -Name 'Emulator ADB status' `
                -Status 'PASS' `
                -Required $true `
                -Observed ('Authorized emulator detected: {0}' -f ($authorizedEmulator -join '; ')) `
                -Expected 'A running emulator appears as an authorized adb device.'
        } else {
            Add-Check `
                -Id 'device.emulator' `
                -Name 'Emulator ADB status' `
                -Status 'BLOCKED' `
                -Required $true `
                -Observed 'No running authorized emulator is currently visible to ADB.' `
                -Expected 'A running emulator appears as an authorized adb device.' `
                -NextSteps @(
                    'Start the approved pinned emulator from Android Studio or the approved emulator procedure.',
                    'Rerun this preflight after the emulator reaches the home screen.'
                )
        }
    }
} else {
    Add-Check `
        -Id 'android.emulator' `
        -Name 'Android Emulator tool' `
        -Status 'SKIPPED' `
        -Required $false `
        -Observed 'Skipped because target mode is physical.' `
        -Expected 'Not evaluated.'
    Add-Check `
        -Id 'device.emulator' `
        -Name 'Emulator ADB status' `
        -Status 'SKIPPED' `
        -Required $false `
        -Observed 'Skipped because target mode is physical.' `
        -Expected 'Not evaluated.'
}

if ($PrepareSdk) {
    if (-not $sdkManagerPath) {
        Add-Check `
            -Id 'prepare.sdk' `
            -Name 'Optional SDK preparation' `
            -Status 'BLOCKED' `
            -Required $false `
            -Observed 'Cannot prepare packages because sdkmanager.bat is unavailable.' `
            -Expected 'Official Android SDK Command-line Tools are installed.' `
            -NextSteps @('Install the official command-line tools, then rerun with -PrepareSdk.')
    } else {
        $packages = @(
            'platform-tools',
            ('platforms;{0}' -f $toolRequirements.sdkPlatform),
            ('build-tools;{0}' -f $toolRequirements.buildToolsMinimum)
        )
        if ($Target -eq 'emulator' -or $Target -eq 'both') {
            $packages += @(
                'emulator',
                # The system image follows the pinned emulator contract owned by
                # pixel-emulator.ps1, which tracks the SDK platform declared in
                # tool-requirements.json.
                ('system-images;{0};google_apis;x86_64' -f $toolRequirements.sdkPlatform)
            )
        }

        $approved = $false
        if ($ConfirmSdkInstall) {
            $approved = $true
        } else {
            Write-Host ''
            Write-Host 'The next command will install or update only these Android SDK packages:' -ForegroundColor Yellow
            $packages | ForEach-Object { Write-Host ('  - {0}' -f $_) }
            Write-Host 'It will not install an APK, change Device Owner state, reboot a device, or send messages.'
            $answer = Read-Host 'Type INSTALL to continue, or press Enter to cancel'
            $approved = ($answer -ceq 'INSTALL')
        }

        if (-not $approved) {
            $script:Actions += 'SDK preparation was offered but not approved; no SDK packages were changed.'
            Add-Check `
                -Id 'prepare.sdk' `
                -Name 'Optional SDK preparation' `
                -Status 'WARN' `
                -Required $false `
                -Observed 'Skipped because explicit confirmation was not provided.' `
                -Expected 'No installation occurs without an explicit INSTALL confirmation.' `
                -NextSteps @('Rerun with -PrepareSdk and type INSTALL if the approved SDK packages need to be prepared.')
        } else {
            try {
                $script:Actions += 'SDK preparation was explicitly approved by the operator.'
                $sdkResult = Invoke-Tool -Path $sdkManagerPath -Arguments (@("--sdk_root=$sdkRoot") + $packages)
                if ($sdkResult.succeeded) {
                    $script:Actions += 'sdkmanager completed for the approved package list.'
                    Add-Check `
                        -Id 'prepare.sdk' `
                        -Name 'Optional SDK preparation' `
                        -Status 'PASS' `
                        -Required $false `
                        -Observed ('sdkmanager completed for: {0}' -f ($packages -join ', ')) `
                        -Expected 'Only explicitly approved SDK packages are installed or updated.'
                } else {
                    $script:Actions += 'sdkmanager returned a failure; no device action was attempted.'
                    Add-Check `
                        -Id 'prepare.sdk' `
                        -Name 'Optional SDK preparation' `
                        -Status 'WARN' `
                        -Required $false `
                        -Observed ('sdkmanager failed with exit code {0}: {1}' -f $sdkResult.exitCode, $sdkResult.output) `
                        -Expected 'Only explicitly approved SDK packages are installed or updated.' `
                        -NextSteps @('Review the sdkmanager message, fix permissions or network access, and rerun the preflight.')
                }
            } catch {
                Add-Check `
                    -Id 'prepare.sdk' `
                    -Name 'Optional SDK preparation' `
                    -Status 'WARN' `
                    -Required $false `
                    -Observed $_.Exception.Message `
                    -Expected 'Only explicitly approved SDK packages are installed or updated.' `
                    -NextSteps @('Review the SDK installation permissions and rerun the preflight.')
            }
        }
    }
}

$overallStatus = Get-OverallStatus
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
$jsonPath = Join-Path $outputPath ('cas-windows-preflight-{0}.json' -f $timestamp)
$markdownPath = Join-Path $outputPath ('cas-windows-preflight-{0}.md' -f $timestamp)

$result = [ordered]@{
    schemaVersion = 'cas-windows-preflight-v1'
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    overallStatus = $overallStatus
    targetMode = $Target
    host = [ordered]@{
        computerName = $env:COMPUTERNAME
        operatingSystem = $env:OS
        powershellVersion = $PSVersionTable.PSVersion.ToString()
        powershellEdition = $PSVersionTable.PSEdition
    }
    contract = [ordered]@{
        java = $jdkRequirementText
        androidSdk = ('Android SDK with API {0}' -f $toolRequirements.apiLevel)
        platformTools = 'Android platform-tools with adb'
        buildTools = ('Android {0}' -f $buildToolsRequirementText.ToLowerInvariant())
        gradle = $expectedGradleText
        environment = 'JAVA_HOME plus ANDROID_SDK_ROOT or ANDROID_HOME; Java and platform-tools on PATH'
    }
    checks = @($script:Checks)
    actions = @($script:Actions)
    safety = [ordered]@{
        deviceActionsPerformed = $false
        apkInstalled = $false
        deviceOwnerChanged = $false
        deviceRebooted = $false
        messagesSent = $false
        evidenceCaptured = $false
    }
    attachments = @(
        [System.IO.Path]::GetFileName($jsonPath),
        [System.IO.Path]::GetFileName($markdownPath)
    )
}

$result | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath -Encoding UTF8

$markdown = @(
    '# CAS Pixel Gate 0A Windows preflight',
    '',
    ('- **Overall status:** `{0}`' -f $overallStatus),
    ('- **Generated (UTC):** `{0}`' -f $result.generatedAtUtc),
    ('- **Target mode:** `{0}`' -f $Target),
    ('- **Computer:** `{0}`' -f $env:COMPUTERNAME),
    '',
    '## Checks',
    '',
    '| Status | Required | Check | Observed | Expected |',
    '| --- | --- | --- | --- | --- |'
)
foreach ($check in $script:Checks) {
    $markdown += ('| {0} | {1} | {2} | {3} | {4} |' -f `
        (Convert-ToMarkdownCell $check.status), `
        (Convert-ToMarkdownCell $check.required), `
        (Convert-ToMarkdownCell $check.name), `
        (Convert-ToMarkdownCell $check.observed), `
        (Convert-ToMarkdownCell $check.expected))
    if (@($check.nextSteps).Count -gt 0) {
        foreach ($step in $check.nextSteps) {
            $markdown += ('|  |  | Next step | {0} |  |' -f (Convert-ToMarkdownCell $step))
        }
    }
}
$markdown += @(
    '',
    '## Safety record',
    '',
    '- This preflight does not install an APK, change Device Owner state, reboot a device, send a message, or capture evidence.',
    ('- Device actions performed: `{0}`' -f $result.safety.deviceActionsPerformed),
    ('- SDK preparation actions: `{0}`' -f ($(if ($script:Actions.Count -gt 0) { $script:Actions -join ' ' } else { 'None' }))),
    '',
    '## Attachments',
    '',
    'Attach this Markdown file and the matching JSON file to the CAS field-run record. A `BLOCKED` result means the Gate 0A run must not continue. A `WARN` result requires the operator to resolve or document the warning before the field run.'
)
$markdown | Set-Content -Path $markdownPath -Encoding UTF8

Write-Host ''
Write-Host ('Overall status: {0}' -f $overallStatus) -ForegroundColor $(switch ($overallStatus) {
    'PASS' { 'Green' }
    'WARN' { 'Yellow' }
    default { 'Red' }
})
Write-Host ('JSON result: {0}' -f $jsonPath)
Write-Host ('Markdown result: {0}' -f $markdownPath)
Write-Host 'Attach both files to the CAS field-run record.'

if ($overallStatus -eq 'BLOCKED') {
    exit 2
}
if ($overallStatus -eq 'WARN') {
    exit 1
}
exit 0