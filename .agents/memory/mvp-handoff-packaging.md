---
name: MVP handoff packaging constraints
description: Rules for building operator-facing ZIP deliverables for the CAS Pixel kit without breaking the CI freshness gate.
---

Constraints when producing CAS Pixel field/handoff ZIPs:

- The CI `mvp-handoff-freshness` job (windows-test-kit-entrypoints.yml) requires **exactly one** file matching `CAS-Pixel11-MVP-Handoff-v*-mvp.zip` in `deliverables/`. Any additional run pack must use a different name pattern or CI fails with "Expected exactly one committed MVP handoff ZIP".
- The official packager `artifacts/covert-alert-system/scripts/package-mvp-handoff.ps1` is PowerShell-only and also needs `google-services.json`-free tree, the committed `gate0a-run-guide.pdf`, and its three Python gates + the Bash parity gate. On Linux its gates can be run standalone: `.github/scripts/check-tool-requirements-{drift,hardcoded-api-floor,hardcoded-jdk-minimum}.py <staged-kit>` and `scripts/check-tool-requirements-parity.sh --kit-root <staged-kit>` (parity needs pwsh AND its fixtures under `scripts/fixtures/tool-requirements-parity`).
- Manifest format the freshness comparison expects: `SHA256SUMS.txt` lines `<sha256>  <relative-path>` (forward slashes, LF, sorted by path) covering every payload file plus `PACKAGE-INFO.txt`; `PACKAGE-INFO.txt` carries a content fingerprint derived only from the payload sums (never the clock).
- Generated Gradle reports are tracked in the kit tree; packaging with the APK build gate regenerates them before staging, so commit their post-build state with the ZIP or the skip-APK CI freshness rebuild mismatches. Version bumps must edit the packager's `param` default: the CI rebuild embeds it in the hash-compared `PACKAGE-INFO.txt`.

**Why:** the 2026-09-16 hand-built handoff ZIP went stale within hours and a later repack shipped different content under one filename; the gates exist so ZIPs are always scripted, gated outputs. Also: a gated packager run takes 15-25 min on this workspace (pwsh cold starts + Gradle), long enough for concurrent task merges to land mid-run and silently stale the ZIP against the final tree — a completion review caught exactly that. After any long packager run, re-sync with mainline and diff the extracted ZIP against the current tree (excluding .gradle/.kotlin/app build outputs), not just the archive's internal SHA256SUMS, before committing.

**How to apply:** for one-off run packs, stage from the leading-edge branch via `git archive <branch> -- <paths>`, run the four gates against the staged copy, generate the manifest in the exact format above, and name the ZIP outside the `CAS-Pixel11-MVP-Handoff-v*-mvp.zip` pattern.

Field-proofs pack convention: version is `<bundled app versionName>-field.<n>` (e.g. `0.8.0-selfupdate-field.1`) and the filename tracks the bundled app version. Always re-stage android-test-package from the current tree when repacking — shipping new run-sheet steps against a stale bundled kit fails review, because the sheet defers to the bundled kit doc and the operator builds the app from the pack.
