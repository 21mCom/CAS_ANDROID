[CmdletBinding()]
param(
    [ValidateSet('qualification', 'full')]
    [string]$Action = 'qualification',
    [string]$Serial = ''
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot

function Stop-Run {
    param([string]$Message)
    Write-Host ''
    Write-Host "BLOCKED: $Message" -ForegroundColor Red
    Write-Host 'No Gate 0A pass was recorded.' -ForegroundColor Yellow
    Read-Host 'Press Enter to close'
    exit 2
}

function Find-GitBash {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
        (Join-Path $env:ProgramFiles 'Git\usr\bin\bash.exe')
    )
    if (${env:ProgramFiles(x86)}) {
        $candidates += Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate -PathType Leaf)) {
            return $candidate
        }
    }
    $command = Get-Command bash.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    return $null
}

Write-Host ''
Write-Host 'CAS Pixel 11 Gate 0A' -ForegroundColor Cyan
Write-Host "Run type: $Action"
Write-Host 'This script may install the disposable APK, force-stop it, change screen state, and reboot the approved test phone.'
Write-Host 'It does not factory-reset, provision Device Owner, send messages, or enable production behavior.'
Write-Host ''

$adb = Get-Command adb.exe -ErrorAction SilentlyContinue
if (-not $adb) {
    Stop-Run 'adb.exe was not found. Run run-windows-preflight.cmd first.'
}

$bash = Find-GitBash
if (-not $bash) {
    Stop-Run 'Git Bash was not found. Install approved Git for Windows and rerun the Windows preflight.'
}

if (-not $Serial) {
    $deviceLines = @(& $adb.Source devices 2>&1)
    $authorized = @(
        $deviceLines |
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
if ($api -notmatch '^\d+$' -or [int]$api -lt 35) {
    Stop-Run "Expected Android API 35 or newer, but ADB reported '$api'."
}

Write-Host "Authorized target: $model / serial $Serial / API $api" -ForegroundColor Green
$confirmation = Read-Host 'Type RUN PIXEL 11 to continue'
if ($confirmation -cne 'RUN PIXEL 11') {
    Stop-Run 'Operator confirmation was not provided.'
}

$repeat = if ($Action -eq 'qualification') { '1' } else { '200' }
$arguments = @(
    'scripts/measure-gate0a.sh',
    '--target', 'physical',
    '--serial', $Serial,
    '--confirm-device', 'Pixel 11',
    '--confirm-destructive',
    '--repeat', $repeat
)
if ($Action -eq 'qualification') {
    $arguments += @('--build', '--install')
}

Push-Location $packageRoot
try {
    & $bash @arguments
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($exitCode -ne 0) {
    Stop-Run "The Gate 0A runner exited with code $exitCode. Review the newest gate0a-results folder."
}

Write-Host ''
Write-Host 'Run completed. Review report.md and every warning in the newest gate0a-results folder.' -ForegroundColor Green
if ($Action -eq 'qualification') {
    Write-Host 'Do not start the full run until the qualification evidence is acceptable.'
}
Read-Host 'Press Enter to close'
