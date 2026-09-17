[CmdletBinding()]
param(
    [ValidateSet('qualification', 'full')]
    [string]$Action = 'qualification',
    [string]$Serial = '',
    [switch]$StartupSmokeCheck,
    # CI-only: replaces the device gates and the real harness with a stub harness
    # invocation that exits non-zero, proving the launcher surfaces a failed run
    # as a non-zero exit instead of reporting success.
    [switch]$HarnessFailureSimulation,
    # CI-only: skips the device gates but keeps the real scripts/measure-gate0a.sh
    # invocation in --report-self-test mode. CI shadows python3 with a broken shim
    # so the real harness fails its report write, proving the launcher surfaces an
    # actual harness failure (not just the stub) as a non-zero exit without the
    # success message. CAS_GATE0A_SELF_TEST_OUT_DIR overrides the self-test output
    # parent directory so the check can inspect what the harness wrote.
    [switch]$RealHarnessFailureSimulation
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
    Write-Output ('CAS_STARTUP_OK pixel11-gate0a PackageRoot={0}' -f [System.IO.Path]::GetFullPath($packageRoot))
    exit 0
}

function Stop-Run {
    param([string]$Message)
    Write-Host ''
    Write-Host "BLOCKED: $Message" -ForegroundColor Red
    Write-Host 'No Gate 0A pass was recorded.' -ForegroundColor Yellow
    if (-not $env:CAS_NO_PAUSE) {
        Read-Host 'Press Enter to close'
    }
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

$bash = Find-GitBash
if (-not $bash) {
    Stop-Run 'Git Bash was not found. Install approved Git for Windows and rerun the Windows preflight.'
}

if ($HarnessFailureSimulation) {
    Write-Host 'Harness failure simulation: no device is touched. A stub harness invocation exits non-zero' -ForegroundColor Yellow
    Write-Host 'so CI can prove this launcher surfaces a failed Gate 0A run as a non-zero exit.' -ForegroundColor Yellow
    # Windows PowerShell 5.1 mangles embedded double quotes when it builds the
    # native command line, and a native stderr write aborts 2>&1 captures that
    # run under $ErrorActionPreference = 'Stop' (NativeCommandError). Keep the
    # stub command quote-free and on stdout so the simulated failure reliably
    # reaches this launcher's exit-code handling.
    $arguments = @('-c', 'echo CAS simulated Gate 0A harness failure; exit 3')
} elseif ($RealHarnessFailureSimulation) {
    Write-Host 'Real-harness failure simulation: no device is touched. The launcher invokes the real' -ForegroundColor Yellow
    Write-Host 'scripts/measure-gate0a.sh report self-test; CI shadows python3 to force the failure.' -ForegroundColor Yellow
    $selfTestOutDir = $env:CAS_GATE0A_SELF_TEST_OUT_DIR
    if ([string]::IsNullOrWhiteSpace($selfTestOutDir)) {
        $selfTestOutDir = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-gate0a-real-harness-' + [guid]::NewGuid().ToString('N'))
    }
    $arguments = @(
        'scripts/measure-gate0a.sh',
        '--report-self-test',
        '--out-dir', ($selfTestOutDir -replace '\\', '/')
    )
} else {
    $adb = Get-Command adb.exe -ErrorAction SilentlyContinue
    if (-not $adb) {
        Stop-Run 'adb.exe was not found. Run run-windows-preflight.cmd first.'
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

    # The minimum API level derives from the Android SDK platform declared in
    # tool-requirements.json at the package root (the same declaration the
    # preflight, the Gradle build, and GitHub Actions read), parsed by the
    # shared kit parser so this device gate moves with the declared platform
    # instead of drifting from it.
    $sharedParserPath = Join-Path $scriptDirectory 'cas-tool-requirements.ps1'
    if (-not (Test-Path $sharedParserPath -PathType Leaf)) {
        Stop-Run "The shared tool-requirements parser is missing at $sharedParserPath. Restore the complete, unmodified test kit."
    }
    . $sharedParserPath
    $toolRequirementsPath = Join-Path $packageRoot 'tool-requirements.json'
    $toolRequirements = Get-ToolRequirements $toolRequirementsPath
    if ($null -eq $toolRequirements) {
        Stop-Run "tool-requirements.json is missing or invalid at $toolRequirementsPath. Restore the complete, unmodified test kit."
    }
    $minimumApiLevel = $toolRequirements.apiLevel

    $model = (& $adb.Source -s $Serial shell getprop ro.product.model 2>&1 | Out-String).Trim()
    $api = (& $adb.Source -s $Serial shell getprop ro.build.version.sdk 2>&1 | Out-String).Trim()
    if ($model -ne 'Pixel 11') {
        Stop-Run "Expected the approved Pixel 11, but ADB reported '$model'."
    }
    if ($api -notmatch '^\d+$' -or [int]$api -lt $minimumApiLevel) {
        Stop-Run "Expected Android API $minimumApiLevel or newer (declared in tool-requirements.json), but ADB reported '$api'."
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
if (-not $env:CAS_NO_PAUSE) {
    Read-Host 'Press Enter to close'
}
