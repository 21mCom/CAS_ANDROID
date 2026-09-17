[CmdletBinding()]
param(
    [string]$OutputPath = '',
    # Handoff iteration baked into the deliverable filename. Bump it when the
    # operator-facing package intentionally changes; the CI freshness gate
    # compares ZIP contents, not the name.
    [string]$Version = '0.4.0',
    [switch]$SkipApkBuild,
    # The entry-point gate needs Windows PowerShell (powershell.exe) and a CMD
    # wrapper, so it cannot run on a Linux packager. Only skip it there; the
    # windows-test-kit-entrypoints workflow runs the same gate against the
    # packaged kit on windows-latest.
    [switch]$SkipWindowsEntryPointGate
)

# The 2026-09-16 MVP handoff ZIP was assembled by hand and went stale within
# hours of a merge: package-windows-test-kit.ps1 only produces the older
# CAS-Pixel11-Windows-Test-Kit-v6 layout, and nothing rebuilt or freshness-
# checked the CAS-Pixel11-MVP layout (android-test-package +
# gate0a-run-guide.pdf + SHA256SUMS.txt). This script makes the handoff a
# scripted output: the same entry-point, drift, hardcode-floor, and
# validator-parity gates that guard the Windows kit run against the staged
# handoff package BEFORE the ZIP is written, and the workflow's
# mvp-handoff-freshness job fails when the committed deliverable no longer
# matches a fresh rebuild from the current tree.

$ErrorActionPreference = 'Stop'
# Compress-Archive spins on progress-bar updates when output is redirected
# (CI logs); silence progress records — gate output still flows via Write-Host.
$ProgressPreference = 'SilentlyContinue'
# pwsh 7.4+ turns non-zero native exits into terminating errors when
# $ErrorActionPreference is Stop; the gates below are checked via
# $LASTEXITCODE so their output stays visible in the failure message.
$PSNativeCommandUseErrorActionPreference = $false

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory '..'))
$packageRoot = Join-Path $artifactRoot 'android-test-package'
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $artifactRoot '..\..'))
$guidePdf = Join-Path $artifactRoot 'public\gate0a-run-guide.pdf'
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $workspaceRoot ('deliverables\CAS-Pixel11-MVP-Handoff-v{0}-mvp.zip' -f $Version)
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)

if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
    throw ('The Android test package is missing: {0}' -f $packageRoot)
}
if (-not (Test-Path -LiteralPath $guidePdf -PathType Leaf)) {
    # The guide generator needs Chromium and only runs in the Replit workspace;
    # packaging ships the committed render and refuses to guess.
    throw ('The committed Gate 0A run guide is missing: {0}. Regenerate it with scripts/generate-gate0a-guide-readable.mjs in the workspace before packaging.' -f $guidePdf)
}

if ($SkipApkBuild) {
    Write-Warning 'Skipping the APK build gate. The CI "Android test package build" workflow must have passed on this exact kit revision before the ZIP is used in the field.'
} else {
    # The 2026-09-14 field run failed because kit Kotlin never compiled in the
    # workspace. Packaging now refuses to ship a kit whose APK does not build.
    & (Join-Path $scriptDirectory 'build-android-test-apk.ps1') -PackageRoot $packageRoot
    if ($LASTEXITCODE -ne 0) { throw ('build-android-test-apk.ps1 exited {0}' -f $LASTEXITCODE) }
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-mvp-handoff-' + [guid]::NewGuid().ToString('N'))
$stagedHandoff = Join-Path $stagingRoot 'CAS-Pixel11-MVP'
$stagedPackage = Join-Path $stagedHandoff 'android-test-package'
try {
    New-Item -ItemType Directory -Path $stagedPackage -Force | Out-Null
    Copy-Item -Path (Join-Path $packageRoot '*') -Destination $stagedPackage -Recurse -Force
    # The APK build gate above produces Gradle outputs; never ship them.
    foreach ($buildOutput in @('.gradle', 'app\build')) {
        $stagedOutput = Join-Path $stagedPackage $buildOutput
        if (Test-Path $stagedOutput) {
            Remove-Item -Recurse -Force $stagedOutput
        }
    }

    if ($SkipWindowsEntryPointGate) {
        Write-Warning 'Skipping the Windows entry-point gate (non-Windows packager). The windows-test-kit-entrypoints workflow runs it against the packaged kit on windows-latest.'
    } else {
        # Gate the staged copy, so the exact bytes that ship are the bytes that
        # passed; a packaging regression that drops a script fails here.
        & (Join-Path $scriptDirectory 'test-windows-entrypoints.ps1') -PackageRoot $stagedPackage
        if ($LASTEXITCODE -ne 0) { throw ('test-windows-entrypoints.ps1 exited {0}' -f $LASTEXITCODE) }
    }

    # Drift and hardcode-floor gates (Python) against the staged package: the
    # docs/scripts in the ZIP must agree with its own tool-requirements.json
    # and must not re-hardcode the declared floors.
    $python = $null
    foreach ($candidate in @('python', 'python3')) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) { $python = $command.Source; break }
    }
    if (-not $python) {
        throw 'Python is required to run the tool-requirements drift and hardcode-floor gates, but neither python nor python3 is on PATH. Install Python 3 or package from a machine that has it.'
    }
    foreach ($gate in @('check-tool-requirements-drift.py', 'check-hardcoded-api-floor.py', 'check-hardcoded-jdk-minimum.py')) {
        $gatePath = Join-Path $workspaceRoot ('.github\scripts\' + $gate)
        if (-not (Test-Path -LiteralPath $gatePath -PathType Leaf)) {
            throw ('The drift gate script is missing from the checkout: {0}' -f $gatePath)
        }
        $gateOutput = @(& $python $gatePath $stagedPackage 2>&1 | Out-String)
        $gateExitCode = $LASTEXITCODE
        Write-Host $gateOutput
        if ($gateExitCode -ne 0) {
            throw ('{0} rejected the staged handoff package (exit {1}). The handoff ZIP was not written.' -f $gate, $gateExitCode)
        }
    }

    # Validator parity gate (Bash): the staged PowerShell parser and the Bash
    # harness must accept/reject the same tool-requirements declarations.
    $bash = Get-Command bash -ErrorAction SilentlyContinue
    if (-not $bash) {
        throw 'Bash is required to run the tool-requirements validator-parity gate, but bash is not on PATH. On Windows use Git Bash, WSL, or another approved Bash environment.'
    }
    $parityScript = Join-Path $workspaceRoot 'scripts\check-tool-requirements-parity.sh'
    if (-not (Test-Path -LiteralPath $parityScript -PathType Leaf)) {
        throw ('The validator-parity script is missing from the checkout: {0}' -f $parityScript)
    }
    # Git Bash cannot consume a Windows path as --kit-root; convert when
    # cygpath is available (Windows), pass through otherwise (Linux/macOS).
    $cygpath = Get-Command cygpath -ErrorAction SilentlyContinue
    $parityKitRoot = $stagedPackage
    if ($cygpath) {
        $parityKitRoot = (& $cygpath.Source $stagedPackage).Trim()
    }
    $parityOutput = @(& $bash.Source $parityScript --kit-root $parityKitRoot 2>&1 | Out-String)
    $parityExitCode = $LASTEXITCODE
    Write-Host $parityOutput
    if ($parityExitCode -ne 0) {
        throw ('check-tool-requirements-parity.sh rejected the staged handoff package (exit {0}). The handoff ZIP was not written.' -f $parityExitCode)
    }

    Copy-Item -LiteralPath $guidePdf -Destination (Join-Path $stagedHandoff 'gate0a-run-guide.pdf') -Force

    # Manifest over EVERY file that ships (including the guide), in sha256sum
    # format with LF endings, so the operator can verify the extract with
    # `sha256sum -c SHA256SUMS.txt` and CI can diff manifests byte-for-byte.
    $sumsLines = @(Get-ChildItem -LiteralPath $stagedHandoff -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($stagedHandoff.Length).TrimStart('\', '/') -replace '\\', '/'
        [pscustomobject]@{
            Relative = $relative
            Line     = '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
        }
    } | Sort-Object -Property Relative | ForEach-Object { $_.Line })
    $sumsText = ($sumsLines -join "`n") + "`n"
    [System.IO.File]::WriteAllText((Join-Path $stagedHandoff 'SHA256SUMS.txt'), $sumsText, (New-Object System.Text.UTF8Encoding($false)))

    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
    Remove-Item $OutputPath -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path $stagedHandoff -DestinationPath $OutputPath -CompressionLevel Optimal
    Write-Host ('MVP handoff package created: {0} ({1} hashed files)' -f $OutputPath, $sumsLines.Count) -ForegroundColor Green
} finally {
    Remove-Item -Recurse -Force $stagingRoot -ErrorAction SilentlyContinue
}
