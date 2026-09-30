---
name: CAS field signing key
description: All field-kit APKs are pinned to one release key; key material lives only in workspace secrets, the committed pin is the cert fingerprint.
---

Field-kit APKs are signed with one pinned release key — the single PrivateKeyEntry in the keystore stored as the workspace secret `CAS_RELEASE_KEYSTORE_B64` (base64) + `CAS_RELEASE_KEYSTORE_PASSWORD`; the build reads the key alias out of the keystore, so the alias is never hardcoded. Key material is never committed; `.gitignore` blocks `*.keystore`/`*.jks`. The committed half of the pin is the cert SHA-256 fingerprint in `android-test-package/signing/field-release-cert.sha256.txt`, and the pin must match whatever keystore is in the secret (the owner may supply their own keystore — re-pin the fingerprint to it rather than rejecting it).

**Why:** Android accepts an update only when signed with the SAME certificate; a second key strands every field phone on a manual uninstall/reinstall that wipes enrollment. The packaging gate therefore fails CLOSED: no secrets → refuse to package (debug fallback exists only so CI/emulator builds keep working), wrong key → SIGNATURE MISMATCH against the committed fingerprint.

**How to apply:** never commit or print keystore material; keep the fingerprint file in sync if the key is ever rotated (rotation = forced reinstall on all field phones, a deliberate event). Phones installed before this pin (debug-signed) need the one-time migration in HANDOFF-TEST-KIT.md T1. `mvp-install.ps1` also refuses to install without the signing secrets. Verification nuance: `apksigner verify --print-certs` prints the digest colon-less lowercase, `keytool -printcert` prints colon-separated uppercase — normalize before comparing.
