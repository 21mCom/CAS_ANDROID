[CmdletBinding()]
param(
    [string]$PackageRoot = ''
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
    $PackageRoot = Join-Path $scriptDirectory '..\android-test-package'
}
$PackageRoot = [System.IO.Path]::GetFullPath($PackageRoot)
$entrypointDirectory = Join-Path $PackageRoot 'scripts'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source

function Invoke-StartupCheck {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$ExpectedMarker
    )

    Push-Location $WorkingDirectory
    try {
        $output = @(& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath -StartupSmokeCheck 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $text = ($output | Out-String).Trim()
    if ($exitCode -ne 0) {
        throw ('PowerShell startup failed for {0} from {1} (exit {2}): {3}' -f $ScriptPath, $WorkingDirectory, $exitCode, $text)
    }
    if ($text -notmatch [regex]::Escape($ExpectedMarker)) {
        throw ('PowerShell startup marker was missing for {0}: {1}' -f $ScriptPath, $text)
    }
    return $text
}

function Invoke-ParserRegressionCheck {
    param([Parameter(Mandatory = $true)][string]$ScriptPath)

    $output = @(& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath -ParserRegressionCheck 2>&1)
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String).Trim()
    if ($exitCode -ne 0 -or $text -notmatch 'CAS_PARSER_REGRESSION_OK windows-preflight') {
        throw ('PowerShell parser regression check failed for {0} (exit {1}): {2}' -f $ScriptPath, $exitCode, $text)
    }
    return $text
}

function Invoke-HarnessFailurePropagationCheck {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string]$LauncherName
    )

    # The launcher runs a stub harness invocation that exits non-zero. The build
    # must fail if the launcher swallows that failure and exits 0 or prints the
    # success message, because a failed field run would then look successful.
    # Capture with $ErrorActionPreference = 'Continue': under Windows PowerShell
    # 5.1 a native stderr write inside a 2>&1 capture running under 'Stop'
    # throws NativeCommandError and aborts the capture, hiding the descriptive
    # assertion below; a launcher reporting a failure over stderr is exactly
    # the case this check must diagnose cleanly.
    $env:CAS_NO_PAUSE = '1'
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath -HarnessFailureSimulation 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
        Remove-Item Env:\CAS_NO_PAUSE -ErrorAction SilentlyContinue
    }
    $text = ($output | Out-String).Trim()
    if ($exitCode -eq 0) {
        throw ('{0} exited 0 although the Gate 0A harness invocation failed; a failed field run would look successful. Output: {1}' -f $LauncherName, $text)
    }
    if ($text -match 'Run completed') {
        throw ('{0} printed the success message although the Gate 0A harness invocation failed: {1}' -f $LauncherName, $text)
    }
    if ($text -notmatch 'exited with code') {
        throw ('{0} did not report the failing harness exit code: {1}' -f $LauncherName, $text)
    }
    return $text
}

function Invoke-RealHarnessFailurePropagationCheck {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string]$LauncherName,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    # The stub-based HarnessFailureSimulation check proves the launcher propagates
    # a non-zero exit code, but not that a real measure-gate0a.sh failure is
    # surfaced. Here the launcher invokes the real harness in --report-self-test
    # mode (no device) while a broken python3 shim shadows the interpreter, so the
    # report write fails — the same forced failure as the git-bash-report workflow
    # job. The build must fail if the launcher exits 0 or prints the success
    # message, because a failed field run would then look successful.
    $shimDirectory = Join-Path $WorkingDirectory 'broken-python3'
    New-Item -ItemType Directory -Path $shimDirectory | Out-Null
    Set-Content -Path (Join-Path $shimDirectory 'python3') -Value "#!/usr/bin/env bash`nexit 1`n" -NoNewline -Encoding Ascii
    $outParent = Join-Path $WorkingDirectory 'real-harness-negative'

    $savedPath = $env:PATH
    $savedOutDir = $env:CAS_GATE0A_SELF_TEST_OUT_DIR
    $env:PATH = "$shimDirectory;$env:PATH"
    $env:CAS_GATE0A_SELF_TEST_OUT_DIR = $outParent
    $env:CAS_NO_PAUSE = '1'
    try {
        $output = @(& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath -RealHarnessFailureSimulation 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $env:PATH = $savedPath
        if ($null -ne $savedOutDir) {
            $env:CAS_GATE0A_SELF_TEST_OUT_DIR = $savedOutDir
        } else {
            Remove-Item Env:\CAS_GATE0A_SELF_TEST_OUT_DIR -ErrorAction SilentlyContinue
        }
        Remove-Item Env:\CAS_NO_PAUSE -ErrorAction SilentlyContinue
    }
    $text = ($output | Out-String).Trim()
    if ($exitCode -eq 0) {
        throw ('{0} exited 0 although the real Gate 0A harness failed; a failed field run would look successful. Output: {1}' -f $LauncherName, $text)
    }
    if ($text -match 'Run completed') {
        throw ('{0} printed the success message although the real Gate 0A harness failed: {1}' -f $LauncherName, $text)
    }
    if ($text -notmatch 'exited with code') {
        throw ('{0} did not report the failing harness exit code: {1}' -f $LauncherName, $text)
    }
    # Independent verification: the real harness must actually have run and failed
    # its report write — never trust the launcher's exit code alone.
    if ($text -notmatch 'report generation failed') {
        throw ('{0} did not surface the real harness report-write failure; the forced failure may not have reached measure-gate0a.sh: {1}' -f $LauncherName, $text)
    }
    $hostLogs = @(Get-ChildItem -Path $outParent -Recurse -Filter 'host.log' -File -ErrorAction SilentlyContinue)
    if ($hostLogs.Count -eq 0) {
        throw ('The real harness did not start a run under {0}; the forced failure did not exercise measure-gate0a.sh. Output: {1}' -f $outParent, $text)
    }
    $reportFiles = @($hostLogs | ForEach-Object { $_.Directory } | ForEach-Object {
        Get-ChildItem -Path $_.FullName -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq 'report.json' -or $_.Name -eq 'report.md' }
    })
    if ($reportFiles.Count -gt 0) {
        throw ('A report file exists under {0} even though the report write failed.' -f $outParent)
    }
    return $text
}

function Invoke-BlockedRunPropagationCheck {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string]$LauncherName,
        [Parameter(Mandatory = $true)][string]$OutputDirectory
    )

    # With no Android SDK configured the launcher run is blocked. The build must
    # fail if the launcher reports that blocked run with exit code 0.
    # Capture with $ErrorActionPreference = 'Continue': under Windows PowerShell
    # 5.1 a native stderr write inside a 2>&1 capture running under 'Stop'
    # throws NativeCommandError and aborts the capture, hiding the descriptive
    # assertion below; a launcher reporting a blocked run over stderr is
    # exactly the case this check must diagnose cleanly.
    $savedSdkRoot = $env:ANDROID_SDK_ROOT
    $savedAndroidHome = $env:ANDROID_HOME
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Remove-Item Env:\ANDROID_SDK_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:\ANDROID_HOME -ErrorAction SilentlyContinue
    try {
        $output = @(& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath -Action status -OutputDirectory $OutputDirectory 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
        if ($null -ne $savedSdkRoot) { $env:ANDROID_SDK_ROOT = $savedSdkRoot }
        if ($null -ne $savedAndroidHome) { $env:ANDROID_HOME = $savedAndroidHome }
    }
    $text = ($output | Out-String).Trim()
    if ($exitCode -eq 0) {
        throw ('{0} exited 0 although the run was blocked (no Android SDK); a failed field run would look successful. Output: {1}' -f $LauncherName, $text)
    }
    # Independent verification: the launcher must also record the blocked run as
    # BLOCKED in its JSON result, not just exit non-zero.
    $resultFile = Get-ChildItem -Path $OutputDirectory -Filter 'cas-pixel-emulator-*.json' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $resultFile) {
        throw ('{0} did not write a JSON result for the blocked run. Output: {1}' -f $LauncherName, $text)
    }
    $resultText = (Get-Content $resultFile.FullName -Raw)
    if ($resultText -notmatch '"overallStatus":\s*"BLOCKED"') {
        throw ('{0} recorded the blocked run without a BLOCKED overall status: {1}' -f $LauncherName, $resultText)
    }
    return $text
}

function Invoke-MvpInstallBlockedExitCheck {
    param(
        [Parameter(Mandatory = $true)][string]$EntrypointDirectory,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    # mvp-install.ps1 documents exit code 2 for a blocked install. Its Stop-Run
    # used to Read-Host before exiting, so in a non-interactive run the prompt
    # threw and the process exited 1 instead — a blocked MVP install was
    # indistinguishable from a script error and CI could not assert it. With
    # CAS_NO_PAUSE set, a missing or invalid tool-requirements.json must exit
    # exactly 2 with the BLOCKED message, the same escape hatch the other kit
    # launchers honor.
    $scenarios = @(
        @{ Name = 'missing'; WriteInvalid = $false },
        @{ Name = 'invalid'; WriteInvalid = $true }
    )
    foreach ($scenario in $scenarios) {
        $packageCopy = Join-Path $WorkingDirectory ('mvp-install-blocked-' + $scenario.Name)
        $scriptsCopy = Join-Path $packageCopy 'scripts'
        New-Item -ItemType Directory -Path $scriptsCopy -Force | Out-Null
        Copy-Item -Path (Join-Path $EntrypointDirectory '*.ps1') -Destination $scriptsCopy
        if ($scenario.WriteInvalid) {
            Set-Content -Path (Join-Path $packageCopy 'tool-requirements.json') -Value '{ this is not valid json' -Encoding Ascii
        }
        $env:CAS_NO_PAUSE = '1'
        try {
            $output = @(& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $scriptsCopy 'mvp-install.ps1') 2>&1)
            $exitCode = $LASTEXITCODE
        } finally {
            Remove-Item Env:\CAS_NO_PAUSE -ErrorAction SilentlyContinue
        }
        $text = ($output | Out-String).Trim()
        if ($exitCode -ne 2) {
            throw ('mvp-install.ps1 exited {0} instead of the documented blocked exit code 2 with a {1} tool-requirements.json; a blocked MVP install is indistinguishable from a script error. Output: {2}' -f $exitCode, $scenario.Name, $text)
        }
        if ($text -notmatch 'BLOCKED') {
            throw ('mvp-install.ps1 did not print the BLOCKED message with a {0} tool-requirements.json: {1}' -f $scenario.Name, $text)
        }
        if ($text -notmatch 'tool-requirements\.json') {
            throw ('mvp-install.ps1 did not name tool-requirements.json in its BLOCKED message with a {0} declaration: {1}' -f $scenario.Name, $text)
        }
    }
    return 'mvp-install.ps1 blocked exits verified (exit 2 + BLOCKED message for missing and invalid tool-requirements.json).'
}

$temporaryWorkingDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-windows-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryWorkingDirectory | Out-Null
try {
    # Every PowerShell entry point dot-sources the shared tool-requirements
    # parser; a packaging regression that drops it would only surface on the
    # field workstation, so require it in the packaged kit here.
    $sharedParser = Join-Path $entrypointDirectory 'cas-tool-requirements.ps1'
    if (-not (Test-Path $sharedParser -PathType Leaf)) {
        throw ('The shared tool-requirements parser is missing from the packaged kit: {0}' -f $sharedParser)
    }

    $entrypoints = @(
        @{ Name = 'windows-preflight.ps1'; Marker = 'CAS_STARTUP_OK windows-preflight' },
        @{ Name = 'pixel-emulator.ps1'; Marker = 'CAS_STARTUP_OK pixel-emulator' },
        @{ Name = 'pixel11-gate0a.ps1'; Marker = 'CAS_STARTUP_OK pixel11-gate0a' },
        @{ Name = 'mvp-install.ps1'; Marker = 'CAS_STARTUP_OK mvp-install' }
    )
    foreach ($entrypoint in $entrypoints) {
        $path = Join-Path $entrypointDirectory $entrypoint.Name
        if (-not (Test-Path $path -PathType Leaf)) {
            throw ('Required PowerShell entry point is missing: {0}' -f $path)
        }
        Invoke-StartupCheck -ScriptPath $path -WorkingDirectory $temporaryWorkingDirectory -ExpectedMarker $entrypoint.Marker | Write-Host
    }

    $preflightPath = Join-Path $entrypointDirectory 'windows-preflight.ps1'
    Invoke-ParserRegressionCheck -ScriptPath $preflightPath | Write-Host

    Invoke-MvpInstallBlockedExitCheck -EntrypointDirectory $entrypointDirectory -WorkingDirectory $temporaryWorkingDirectory | Write-Host

    $gate0aLauncherPath = Join-Path $entrypointDirectory 'pixel11-gate0a.ps1'
    Invoke-HarnessFailurePropagationCheck -ScriptPath $gate0aLauncherPath -LauncherName 'pixel11-gate0a.ps1' | Write-Host
    Invoke-RealHarnessFailurePropagationCheck -ScriptPath $gate0aLauncherPath -LauncherName 'pixel11-gate0a.ps1' -WorkingDirectory $temporaryWorkingDirectory | Write-Host

    $emulatorLauncherPath = Join-Path $entrypointDirectory 'pixel-emulator.ps1'
    $emulatorNegativeOutput = Join-Path $temporaryWorkingDirectory 'emulator-negative-results'
    Invoke-BlockedRunPropagationCheck -ScriptPath $emulatorLauncherPath -LauncherName 'pixel-emulator.ps1' -OutputDirectory $emulatorNegativeOutput | Write-Host

    $wrapper = Join-Path $entrypointDirectory 'run-windows-preflight.cmd'
    $env:CAS_NO_PAUSE = '1'
    Push-Location $temporaryWorkingDirectory
    try {
        $wrapperOutput = @(& $env:ComSpec /d /c "`"$wrapper`" -StartupSmokeCheck" 2>&1)
        $wrapperExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        Remove-Item Env:\CAS_NO_PAUSE -ErrorAction SilentlyContinue
    }
    $wrapperText = ($wrapperOutput | Out-String).Trim()
    if ($wrapperExitCode -ne 0 -or $wrapperText -notmatch 'CAS_STARTUP_OK windows-preflight') {
        throw ('CMD wrapper startup failed for {0} (exit {1}): {2}' -f $wrapper, $wrapperExitCode, $wrapperText)
    }

    $expectedOutput = [System.IO.Path]::GetFullPath((Join-Path $PackageRoot 'preflight-results'))
    if ($wrapperText -notmatch [regex]::Escape(('OutputDirectory=' + $expectedOutput))) {
        throw ('CMD wrapper resolved the default output directory incorrectly. Expected {0}. Output: {1}' -f $expectedOutput, $wrapperText)
    }
    Write-Host $wrapperText
    Write-Host 'All Windows PowerShell entry points passed startup smoke checks.' -ForegroundColor Green
} finally {
    Remove-Item -Recurse -Force $temporaryWorkingDirectory -ErrorAction SilentlyContinue
}