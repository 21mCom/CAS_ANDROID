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

if (-not (Test-Path (Join-Path $PackageRoot 'settings.gradle.kts') -PathType Leaf)) {
    throw ('Android test package root not found or incomplete: {0}' -f $PackageRoot)
}

# The package intentionally ships no Gradle wrapper; use the workstation or CI
# Gradle (8.9 or newer, matching Android Gradle Plugin 8.7.3).
$gradleCommand = Get-Command gradle -ErrorAction SilentlyContinue
if ($null -eq $gradleCommand) {
    throw ('Gradle was not found on PATH. Install Gradle 8.9 or newer (and an Android SDK with ANDROID_HOME set) before packaging, or rerun packaging with -SkipApkBuild to bypass the APK build gate.')
}
$gradle = $gradleCommand.Source

Write-Host ('Building Gate 0A debug APK with {0} ...' -f $gradle)
Push-Location $PackageRoot
try {
    & $gradle ':app:assembleDebug' --no-daemon
    if ($LASTEXITCODE -ne 0) {
        throw ('Gradle :app:assembleDebug failed with exit code {0}. The kit cannot be packaged until the APK compiles.' -f $LASTEXITCODE)
    }
} finally {
    Pop-Location
}

$apkPath = Join-Path $PackageRoot 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $apkPath -PathType Leaf)) {
    throw ('Gradle reported success but the debug APK is missing: {0}' -f $apkPath)
}
Write-Host ('Debug APK built: {0}' -f $apkPath) -ForegroundColor Green
