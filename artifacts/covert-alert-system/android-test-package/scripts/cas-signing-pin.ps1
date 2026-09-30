# Shared signature-identity check for the pinned field release key.
#
# Dot-sourced by scripts/build-android-test-apk.ps1 (packaging gate, one level
# above the package) and android-test-package/scripts/mvp-install.ps1 (phone
# installer). Both paths must prove the SAME thing before an APK can ship to a
# field phone: the APK's signing certificate matches the committed pin, or the
# phone is stranded on a signing identity no future kit build can update.
#
# The pin file carries only the certificate's SHA-256 fingerprint — public
# information, safe to commit. Key material never enters this repo.

function Assert-ApkMatchesFieldSigningPin {
    param(
        [Parameter(Mandatory = $true)][string]$ApkPath,
        [Parameter(Mandatory = $true)][string]$PackageRoot
    )

    $pinFile = Join-Path $PackageRoot 'signing/field-release-cert.sha256.txt'
    if (-not (Test-Path -LiteralPath $pinFile -PathType Leaf)) {
        throw ('The signing-key pin is missing: {0}. Restore the complete, unmodified test kit before continuing.' -f $pinFile)
    }
    $pinMatch = [regex]::Match((Get-Content -LiteralPath $pinFile -Raw), 'SHA256:\s*([0-9A-Fa-f:]+)')
    if (-not $pinMatch.Success) {
        throw ('No SHA256 fingerprint found in {0}; the pin file is corrupt.' -f $pinFile)
    }
    # Normalize to colon-less uppercase: keytool prints colon-separated hex,
    # apksigner prints plain lowercase hex for the same digest.
    $expected = $pinMatch.Groups[1].Value.Replace(':', '').ToUpperInvariant()

    # Preferred: apksigner from the declared build-tools (reads the v2/v3 APK
    # Signature Scheme; keytool -printcert only sees v1 JAR signatures).
    $sdkRoot = if (-not [string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
    $apksigner = $null
    if (-not [string]::IsNullOrWhiteSpace($sdkRoot) -and (Test-Path -LiteralPath (Join-Path $sdkRoot 'build-tools'))) {
        $apksigner = Get-ChildItem -Path (Join-Path $sdkRoot 'build-tools') -Recurse -File |
            Where-Object { $_.Name -eq 'apksigner' -or $_.Name -eq 'apksigner.bat' } |
            Sort-Object { $_.FullName } -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    $apkCert = $null
    if ($null -ne $apksigner) {
        $apkCert = & $apksigner verify --print-certs $ApkPath 2>&1 | Out-String
    } else {
        Write-Host 'apksigner not found under ANDROID_HOME build-tools; falling back to keytool -printcert (v1 signatures only).' -ForegroundColor Yellow
        $apkCert = & keytool -printcert -jarfile $ApkPath 2>&1 | Out-String
    }
    $actualMatch = [regex]::Match($apkCert, 'SHA-?256[^:]*:\s*([0-9A-Fa-f]{2}:?)+')
    if (-not $actualMatch.Success) {
        throw ('Could not read a SHA-256 signing certificate from the APK at {0} — it is unsigned or the verifier failed. Output: {1}' -f $ApkPath, $apkCert)
    }
    $actual = ($actualMatch.Value -replace '.*:\s*', '').Replace(':', '').ToUpperInvariant()
    if ($actual -ne $expected) {
        throw ('SIGNATURE MISMATCH: the APK was signed with certificate SHA-256 {0}, but the pinned field key is {1}. The keystore in CAS_RELEASE_KEYSTORE_B64 does not match the committed pin (signing/field-release-cert.sha256.txt) — installing this APK would strand the phone on a one-off key that no future kit build can update. Restore the pinned keystore secret and rebuild.' -f $actual, $expected)
    }
    return $actual
}
