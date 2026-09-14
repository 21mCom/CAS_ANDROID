[CmdletBinding()]
param(
    [string]$OutputPath = '',
    [switch]$SkipApkBuild
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory '..'))
$packageRoot = Join-Path $artifactRoot 'android-test-package'
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $artifactRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $workspaceRoot 'deliverables\CAS-Pixel11-Windows-Test-Kit-v6.zip'
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)

& (Join-Path $scriptDirectory 'test-windows-entrypoints.ps1') -PackageRoot $packageRoot

if ($SkipApkBuild) {
    Write-Warning 'Skipping the APK build gate. The CI "Android test package build" workflow must have passed on this exact kit revision before the ZIP is used in the field.'
} else {
    # The 2026-09-14 field run failed because kit Kotlin never compiled in the
    # workspace. Packaging now refuses to ship a kit whose APK does not build.
    & (Join-Path $scriptDirectory 'build-android-test-apk.ps1') -PackageRoot $packageRoot
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('cas-windows-package-' + [guid]::NewGuid().ToString('N'))
$stagedPackage = Join-Path $stagingRoot 'CAS-Pixel11-Windows-Test-Kit-v6'
try {
    New-Item -ItemType Directory -Path $stagedPackage -Force | Out-Null
    Copy-Item -Path (Join-Path $packageRoot '*') -Destination $stagedPackage -Recurse -Force
    # The APK build gate above produces Gradle outputs; never ship them in the kit.
    foreach ($buildOutput in @('.gradle', 'app\build')) {
        $stagedOutput = Join-Path $stagedPackage $buildOutput
        if (Test-Path $stagedOutput) {
            Remove-Item -Recurse -Force $stagedOutput
        }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
    Remove-Item $OutputPath -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path $stagedPackage -DestinationPath $OutputPath -CompressionLevel Optimal
    Write-Host ('Windows test kit created: {0}' -f $OutputPath) -ForegroundColor Green
} finally {
    Remove-Item -Recurse -Force $stagingRoot -ErrorAction SilentlyContinue
}