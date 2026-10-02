# One-tap self-update field proof — Pixel 11 (build N → N+1)

Proves on real hardware that a field phone updates itself with ONE tap: the app
notices the newer build on the server, downloads it (asking first on mobile
data), verifies it, and Android shows exactly one confirmation prompt. Also
proves a wrong-key package is refused.

This is the CANONICAL SOURCE of the run guide. The shipped pack
(deliverables/CAS-Pixel11-OneTap-Update-Proof-*.zip, staged in
.cache/onetap-pack) carries a copy — regenerate the pack from here.

**The pack's baseline build N must journal the metered-consent beats** (any
build from source containing `UpdateCheck.consentViolations`). CaptureJournal
fails on journals without the `metered` marker, so a pack rebuilt around an
older baseline cannot pass — that is what makes the proof self-verifying.

**Keep this Repl open and running during the whole run** — the phone's alert
server is this workspace's dev URL, and the update is published there.

## What's in this pack

| File | What it is |
|---|---|
| `app-vN-release-signed.apk` | Build N — the baseline, field release key |
| `app-v(N+1)-crosskey.apk` | Same code as the update but signed with the throwaway Android debug key — used ONLY for the refusal proof |
| `Install-Update-Proof.ps1` | Runner: InstallN / CrossKey / CaptureJournal / SelfTest |

The update itself (build N+1) is NOT in this pack on purpose — the phone
must download it from the server, because that download is the thing being
proven. It is already published on the alert server.

## Before you start

1. Pixel 11 charged, USB cable connected, USB debugging authorized.
2. Workstation: platform-tools (adb) on PATH.
3. Phone on **Wi-Fi** for steps 1–4.

## Steps

1. **Remove the old app and install build N.**
   `powershell -ExecutionPolicy Bypass -File .\Install-Update-Proof.ps1 -Step InstallN`
   (The uninstall wipes the old debug-signed install — one-time, expected.
   Any "unknown package" message from the uninstall is fine.)
2. **Enroll.** Open the app, save the alert server URL (this Repl's dev URL,
   same as previous field runs) and the alert credential, and enroll.
3. **Check the baseline.** With the app open, the App updates line should say
   you're on build N — and it may already offer N+1. Don't tap yet.
4. **Switch to mobile data.** Settings → turn Wi-Fi **OFF** (this is what makes
   the metered-connection consent prompt appear).
5. **Run the update.** Open the app → App updates line → **Download & install
   update**.
   - EXPECT: a consent prompt naming the download size BEFORE anything
     downloads (because you're on mobile data).
   - Accept it. The download runs and verifies itself.
   - EXPECT: exactly ONE Android system confirmation prompt ("Do you want to
     install this app?"). Confirm it.
   - First time only, Android may instead send you to Settings → Apps →
     CAS Pixel Gate 0A → **Install unknown apps** — allow it, then tap
     Download & install again.
6. **Confirm the new build.** The app comes back on its own. Open it and check
   it now reports build N+1's version.
7. **Refusal proof (wrong key).** Back at the workstation:
   `powershell -ExecutionPolicy Bypass -File .\Install-Update-Proof.ps1 -Step CrossKey`
   EXPECT: `PROOF OK: Android refused the cross-key update package.`
8. **Capture the journal.**
   `powershell -ExecutionPolicy Bypass -File .\Install-Update-Proof.ps1 -Step CaptureJournal`
   Paste everything between the `==` lines into the report below. The step
   prints `PROOF OK` only when every metered download in the journal is
   preceded by a SHOWN + ACCEPTED consent — if it prints CONSENT CONTRACT
   VIOLATIONS instead, the run does not pass.
9. Turn Wi-Fi back on. Done.

## Report — paste back in chat

```
Date / phone:
R1 install N (Success): 
R2 enrolled against dev URL (yes/no): 
R3 baseline shows build N (yes/no): 
R4 metered consent prompt appeared with size before download (yes/no): 
R5 exactly one Android install prompt (yes/no): 
R6 app reports build N+1 after update (yes/no): 
R7 cross-key refusal (paste the PROOF OK line): 
R8 journal events + CaptureJournal verdict (paste from CaptureJournal): 
```

Expected journal sequence (CaptureJournal checks these): `UPDATE_CHECK` with
outcome `UPDATE_AVAILABLE`, then — because the run is on mobile data —
`UPDATE_DOWNLOAD` consent `SHOWN` and consent `ACCEPTED` with
`"metered": true`, then `UPDATE_DOWNLOAD` outcome `VERIFIED` with
`"metered": true`, then `UPDATE_INSTALL_HANDOFF`, then `UPDATE_INSTALL`
outcome `CONFIRM_PROMPT_SHOWN` and later `INSTALLED`.

The consent beats are what make this proof self-verifying: the
CaptureJournal step FAILS if a metered download result appears without a
SHOWN + ACCEPTED consent in front of it (or if the download beats carry no
`metered` marker at all, which means the installed build predates consent
journaling — rebuild the pack with a current build N).

Note on the tampered-package proof: the server computes the update's SHA-256
itself when an update is published, so a mismatched manifest can't be published
through the supported flow — that refusal (`UPDATE_DOWNLOAD` outcome `FAILED`,
"SHA-256 mismatch") is covered by the automated harness
(scripts/test-update-check.sh). On hardware, the refusal proof is
Android's own same-signing-key enforcement (step 7).
