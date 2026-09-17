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
    # Capture with $ErrorActionPreference = 'Continue': under Windows PowerShell
    # 5.1 a native stderr write inside a 2>&1 capture running under 'Stop'
    # throws NativeCommandError and aborts the capture, hiding the descriptive
    # assertion below; an innocuous launcher warning on stderr is exactly the
    # case this check must diagnose cleanly.
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath -StartupSmokeCheck 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
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

    # Capture with $ErrorActionPreference = 'Continue': under Windows PowerShell
    # 5.1 a native stderr write inside a 2>&1 capture running under 'Stop'
    # throws NativeCommandError and aborts the capture, hiding the descriptive
    # assertion below; an innocuous launcher warning on stderr is exactly the
    # case this check must diagnose cleanly.
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath -ParserRegressionCheck 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
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

$temporaryWorkingDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-windows-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryWorkingDirectory | Out-Null
try {
    $entrypoints = @(
        @{ Name = 'windows-preflight.ps1'; Marker = 'CAS_STARTUP_OK windows-preflight' },
        @{ Name = 'pixel-emulator.ps1'; Marker = 'CAS_STARTUP_OK pixel-emulator' },
        @{ Name = 'pixel11-gate0a.ps1'; Marker = 'CAS_STARTUP_OK pixel11-gate0a' }
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

    $gate0aLauncherPath = Join-Path $entrypointDirectory 'pixel11-gate0a.ps1'
    Invoke-HarnessFailurePropagationCheck -ScriptPath $gate0aLauncherPath -LauncherName 'pixel11-gate0a.ps1' | Write-Host

    $emulatorLauncherPath = Join-Path $entrypointDirectory 'pixel-emulator.ps1'
    $emulatorNegativeOutput = Join-Path $temporaryWorkingDirectory 'emulator-negative-results'
    Invoke-BlockedRunPropagationCheck -ScriptPath $emulatorLauncherPath -LauncherName 'pixel-emulator.ps1' -OutputDirectory $emulatorNegativeOutput | Write-Host

    $wrapper = Join-Path $entrypointDirectory 'run-windows-preflight.cmd'
    $env:CAS_NO_PAUSE = '1'
    Push-Location $temporaryWorkingDirectory
    # Capture with $ErrorActionPreference = 'Continue': under Windows PowerShell
    # 5.1 a native stderr write inside a 2>&1 capture running under 'Stop'
    # throws NativeCommandError and aborts the capture, hiding the descriptive
    # assertion below; an innocuous launcher warning on stderr is exactly the
    # case this check must diagnose cleanly.
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $wrapperOutput = @(& $env:ComSpec /d /c "`"$wrapper`" -StartupSmokeCheck" 2>&1)
        $wrapperExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
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