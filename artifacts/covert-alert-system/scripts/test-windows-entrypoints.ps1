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