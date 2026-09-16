[CmdletBinding()]
param(
    [string]$Serial = '',
    [switch]$StartupSmokeCheck
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = if ($PSScriptRoot) {
    $PSScriptRoot
} elseif ($MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
    (Get-Location).Path
}
$packageRoot = Split-Path -Parent $scriptDirectory
if ($StartupSmokeCheck) {
    Write-Output ('CAS_STARTUP_OK mvp-install PackageRoot={0}' -f [System.IO.Path]::GetFullPath($packageRoot))
    exit 0
}

function Stop-Run {
    param([string]$Message)
    Write-Host ''
    Write-Host "BLOCKED: $Message" -ForegroundColor Red
    if (-not $env:CAS_NO_PAUSE) {
        Read-Host 'Press Enter to close'
    }
    exit 2
}

# The minimum Android API floor derives from tool-requirements.json at the
# package root (the same declaration the Windows preflight, the Gradle build,
# and GitHub Actions read), parsed by the shared kit parser so this install
# gate moves with the declared SDK platform instead of drifting from it.
$sharedParserPath = Join-Path $scriptDirectory 'cas-tool-requirements.ps1'
if (-not (Test-Path $sharedParserPath -PathType Leaf)) {
    Stop-Run "The shared tool-requirements parser is missing at $sharedParserPath; restore the complete, unmodified test kit before installing the MVP app."
}
. $sharedParserPath
$toolRequirementsPath = Join-Path $scriptDirectory '..\tool-requirements.json'
$toolRequirements = Get-ToolRequirements $toolRequirementsPath
if ($null -eq $toolRequirements) {
    Stop-Run "tool-requirements.json is missing or invalid at $toolRequirementsPath; restore the complete, unmodified test kit before installing the MVP app."
}
$minimumApiLevel = $toolRequirements.apiLevel

Write-Host ''
Write-Host 'CAS Pixel 11 - MVP app install' -ForegroundColor Cyan
Write-Host 'Builds the debug APK and installs it on the approved Pixel 11.'
Write-Host 'No harness run, no reboot, no Device Owner change, no message sending.'
Write-Host ''

$gradle = Get-Command gradle -ErrorAction SilentlyContinue
if (-not $gradle) {
    $gradle = Get-Command gradle.bat -ErrorAction SilentlyContinue
}
if (-not $gradle) {
    Stop-Run 'Gradle was not found. Run run-windows-preflight.cmd first.'
}

$adb = Get-Command adb.exe -ErrorAction SilentlyContinue
if (-not $adb) {
    Stop-Run 'adb.exe was not found. Run run-windows-preflight.cmd first.'
}

if (-not $Serial) {
    $authorized = @(
        & $adb.Source devices 2>&1 |
            Select-Object -Skip 1 |
            Where-Object { $_ -match '^\S+\s+device(?:\s|$)' } |
            ForEach-Object { ($_ -split '\s+')[0] }
    )
    if ($authorized.Count -ne 1) {
        Stop-Run "Expected exactly one authorized ADB device; found $($authorized.Count)."
    }
    $Serial = $authorized[0]
}

$model = (& $adb.Source -s $Serial shell getprop ro.product.model 2>&1 | Out-String).Trim()
$api = (& $adb.Source -s $Serial shell getprop ro.build.version.sdk 2>&1 | Out-String).Trim()
if ($model -ne 'Pixel 11') {
    Stop-Run "Expected the approved Pixel 11, but ADB reported '$model'."
}
if ($api -notmatch '^\d+$' -or [int]$api -lt $minimumApiLevel) {
    Stop-Run "Expected Android API $minimumApiLevel or newer (declared in tool-requirements.json), but ADB reported '$api'."
}

Write-Host "Target: $model / serial $Serial / API $api" -ForegroundColor Green
$confirmation = Read-Host 'Type INSTALL MVP to build and install on this phone'
if ($confirmation -cne 'INSTALL MVP') {
    Stop-Run 'Operator confirmation was not provided.'
}

Push-Location $packageRoot
try {
    & $gradle.Source :app:assembleDebug
    if ($LASTEXITCODE -ne 0) {
        Stop-Run "Gradle build failed with exit code $LASTEXITCODE."
    }
    $apk = Join-Path $packageRoot 'app\build\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path $apk -PathType Leaf)) {
        Stop-Run "The build finished but the APK is missing: $apk"
    }
    & $adb.Source -s $Serial install -r $apk
    if ($LASTEXITCODE -ne 0) {
        Stop-Run "adb install failed with exit code $LASTEXITCODE."
    }
    Write-Host ''
    Write-Host "MVP app installed on $model ($Serial)." -ForegroundColor Green
    Write-Host 'Next on the phone: open the CAS app, paste the alert server URL, tap Save alert server, then Send MVP alert now.'
} finally {
    Pop-Location
}
