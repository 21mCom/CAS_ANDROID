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
# Gradle release pinned in gradle-version.txt (matching Android Gradle Plugin 8.7.3).
$gradleVersionFile = Join-Path $PackageRoot 'gradle-version.txt'
$expectedGradle = $null
if (Test-Path $gradleVersionFile -PathType Leaf) {
    $expectedGradle = (Get-Content -Path $gradleVersionFile -Raw).Trim()
}
if ([string]::IsNullOrWhiteSpace($expectedGradle)) {
    $expectedGradle = '(unreadable: check gradle-version.txt at the package root)'
}
$gradleCommand = Get-Command gradle -ErrorAction SilentlyContinue
if ($null -eq $gradleCommand) {
    throw ('Gradle was not found on PATH. Install the Gradle release pinned in android-test-package\gradle-version.txt (currently {0}; and an Android SDK with ANDROID_HOME set) before packaging, or rerun packaging with -SkipApkBuild to bypass the APK build gate.' -f $expectedGradle)
}
$gradle = $gradleCommand.Source

$signingConfigured = -not [string]::IsNullOrWhiteSpace($env:CAS_RELEASE_KEYSTORE_B64)
if ($signingConfigured -and [string]::IsNullOrWhiteSpace($env:CAS_RELEASE_KEYSTORE_PASSWORD)) {
    throw 'CAS_RELEASE_KEYSTORE_B64 is set but CAS_RELEASE_KEYSTORE_PASSWORD is not; export both (see HANDOFF-TEST-KIT.md T1) or unset both for a debug-signed build.'
}
if (-not $signingConfigured) {
    throw 'CAS_RELEASE_KEYSTORE_B64 is not set; refusing to package a DEBUG-signed APK — it could never take an in-place update on a field phone. Export CAS_RELEASE_KEYSTORE_B64 and CAS_RELEASE_KEYSTORE_PASSWORD (see HANDOFF-TEST-KIT.md T1) and rerun, or rerun the packager with -SkipApkBuild to bypass the APK build gate.'
}
Write-Host 'Field release signing key detected (CAS_RELEASE_KEYSTORE_B64); the APK will be signed with the pinned field key.'

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

$apkPath = Join-Path $PackageRoot 'app/build/outputs/apk/debug/app-debug.apk'
if (-not (Test-Path $apkPath -PathType Leaf)) {
    throw ('Gradle reported success but the debug APK is missing: {0}' -f $apkPath)
}

# Signature identity gate: when the pinned field key is configured, the built
# APK MUST be signed by exactly that certificate — a successful compile alone
# says nothing about update compatibility with phones already in the field.
if ($signingConfigured) {
    $pinHelper = Join-Path $PackageRoot 'scripts/cas-signing-pin.ps1'
    if (-not (Test-Path -LiteralPath $pinHelper -PathType Leaf)) {
        throw ('The shared signature-pin check is missing: {0}. Restore the complete, unmodified test kit before packaging.' -f $pinHelper)
    }
    . $pinHelper
    $verifiedDigest = Assert-ApkMatchesFieldSigningPin -ApkPath $apkPath -PackageRoot $PackageRoot
    Write-Host ('Signature identity verified: APK signed with the pinned field key (SHA-256 {0}).' -f $verifiedDigest) -ForegroundColor Green
}
Write-Host ('Debug APK built: {0}' -f $apkPath) -ForegroundColor Green
