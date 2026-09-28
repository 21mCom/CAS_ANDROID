# Launch smoke test — crash detection verification

**Date:** 2026-09-15
**Subject:** `launch-smoke-test` job in `.github/workflows/android-test-package-build.yml`
**Question:** does the job actually turn red when the Gate 0A test app crashes on launch, with the logcat excerpt surfaced — or could a bad grep pattern / swallowed `am start` error leave it silently green?

## Verdict

**Proven end-to-end on a real API 35 emulator.** A deliberately crashing debug APK makes the job script exit 1 with the crash excerpt in the output; the non-crashing APK stays green. The verification also caught and fixed two real gaps: the original `tail -200` excerpt did **not** contain the fatal-crash block on a noisy emulator, and the BootReceiver coverage added later would have failed red on every run because the adb shell user cannot send the protected BOOT_COMPLETED broadcast (finding 3).

**BootReceiver follow-up (same day, after receiver coverage was added):** the full three-entry-point script was re-run on the same real API 35 emulator. Healthy APK: exit 0 — `Broadcast completed: result=0`, process alive, no fatal entries. APK with a deliberate `throw` in `BootReceiver.onReceive`: exit 1 — `::error::App process is not running 8s after BOOT_COMPLETED — BootReceiver crashed.` with the `FATAL EXCEPTION` / `deliberate boot-receiver crash` excerpt. The throw was reverted afterwards (verified via `git checkout`).

## Method (all local, no GitHub runner)

1. Installed Android SDK + API 35 `google_apis` x86_64 system image locally and booted a Pixel 6 AVD with the same emulator options CI uses (`-no-snapshot-save -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`), plus `-no-accel` because this workspace has no KVM.
2. Built `app-debug.apk` with the pinned toolchain (Gradle 8.9 from `gradle-version.txt`, AGP 8.7.3).
3. Ran the job's `script:` block **extracted verbatim** from the workflow YAML against the live emulator, with the APK staged at `apk/app-debug.apk` exactly as the CI artifact download lays it out.
4. Crash variant: `throw IllegalStateException("smoke-test self-check: deliberate crash for detection verification")` as the first line of `MainActivity.onCreate` (after `super.onCreate`), rebuilt, re-ran, then reverted and rebuilt for the final control.

## Real-emulator results

| Run | APK | Result |
|-----|-----|--------|
| 1 | healthy | **green** — exit 0, `Smoke test passed: MainActivity launched, process alive (pid 2942), no fatal logcat entries.` |
| 2 | crash-on-launch | **red** — exit 1, `::error::App process is not running 8s after launch — crash on launch.` — **but the `tail -200` excerpt did not contain the crash** (see finding 2) |
| 3 | crash-on-launch, after workflow fix | **red with excerpt** — exit 1, excerpt includes `FATAL EXCEPTION: main` and `java.lang.IllegalStateException: smoke-test self-check: deliberate crash for detection verification` |
| 4 | healthy (rebuilt after revert) | **green** — exit 0, `Smoke test passed: MainActivity launched, process alive (pid 4716), no fatal logcat entries.` |

## Findings

1. **`am start -W` is not a crash detector — confirmed on a real device image.** With the throw in `onCreate`, `am start -W` returned `Status: ok`, exit 0, `WaitTime: 19774`. The process died immediately after. The `pidof` check 8 s after launch is what caught it. Any future simplification that treats a successful `am start` as proof of survival would silently reopen the blind spot.
2. **`tail -200` alone can lose the crash excerpt.** On the first crash run the job went red, but the 200-line logcat tail contained only slow-emulator system noise — zero `FATAL`/`self-check` lines. The crash had scrolled out of the tail. Fix applied to the workflow: on the crash-on-launch path the script now prints `adb logcat -d | grep -B2 -A30 'FATAL EXCEPTION'` before the tail, so the red run always surfaces the fatal block. Verified on the re-run (row 3 above).
3. **The adb shell user cannot send BOOT_COMPLETED on API 35 — verified on the real emulator.** `am broadcast -a android.intent.action.BOOT_COMPLETED` from uid 2000 fails with `SecurityException: Permission Denial: not allowed to send broadcast android.intent.action.BOOT_COMPLETED ... uid=2000`; BOOT_COMPLETED is a protected broadcast and the shell uid is not on the API 35 allowlist. The job therefore runs `adb root` + `adb wait-for-device` first (the `google_apis` image is rootable; `google_play` images are NOT) and verifies `adb shell id` reports `uid=0` before sending the broadcast, so a future switch to a non-rootable image fails loudly at the uid check instead of confusingly at the broadcast.
4. **Cold-boot timing race (environment-specific, non-blocking).** The very first healthy attempt failed red with `Error: Activity class does not exist` because `am start` ran while the freshly cold-booted TCG emulator was still scanning packages. It resolved on its own seconds later and all subsequent runs behaved. CI's `android-emulator-runner` waits for full boot on a hardware-accelerated macOS runner, so this is not expected there — but it usefully demonstrated the am-start-failure branch going red with real output.
4. **Under TCG the healthy `am start -W` reports `Status: timeout` (WaitTime ~27 s) yet exits 0** and the process is alive — the script correctly treats this as green. Not expected on accelerated CI.

## Ongoing regression coverage (no emulator needed)

`.github/scripts/verify-launch-smoke-detection.sh` extracts the same `script:` block verbatim and runs it against a simulated adb with realistic logcat fixtures (`.github/scripts/launch-smoke-fixtures/`). The simulated adb is phase-aware: it counts `logcat -c` calls so a scenario can serve a crash fixture for one entry point only (1=MainActivity, 2=PROXY_TRIGGER, 3=BOOT_COMPLETED broadcast, 4=locked-boot phase after the PIN-protected reboot), and models the reboot itself (flipping `ce_available` and serving journal fixtures). After the direct-boot coverage was added it passes 12/12: healthy green through all four entry points, crash-after-successful-am-start red with excerpt, fatal-logcat-with-live-process red with excerpt, am-start failure red, unrelated-package force-finish green, BootReceiver-crash-on-BOOT_COMPLETED red with excerpt, BOOT_COMPLETED-send-failure red, adb-root-unavailable red, BootReceiver-crash-in-locked-boot red with excerpt, missing-LOCKED_BOOT_COMPLETED-journal-entry red, device-failed-to-stay-locked red, and set-pin failure red.

Negative controls (proof the harness is not vacuous): mutating **one** of the three logcat patterns still goes red via the remaining patterns; mutating **all three** lets a crash slip through green, and the harness reports `FAIL fatal-logcat-with-live-process` with exit 1. Both mutations were reverted byte-identical afterwards.

Run it after any change to the detection script:

```bash
bash .github/scripts/verify-launch-smoke-detection.sh
# exit 0 = red/green behavior preserved; exit 1 = detection regression; exit 2 = extractor drift
```

## CI wiring (automatic since 2026-09-15)

The harness no longer depends on someone remembering to run it. `.github/workflows/launch-smoke-detection-selftest.yml` runs `bash .github/scripts/verify-launch-smoke-detection.sh` on `ubuntu-latest` (no Android SDK or emulator needed, ~seconds) whenever a PR or push touches any side of the contract it guards:

- `.github/workflows/android-test-package-build.yml` (the launch-smoke-test job's `script:` line the harness contract-guards),
- `.github/scripts/emulator-smoke-test.sh` (the detection script the harness runs verbatim),
- `.github/scripts/verify-launch-smoke-detection.sh` (the harness itself),
- `.github/scripts/launch-smoke-fixtures/**` (the simulated logcat fixtures),
- the self-test workflow itself.

Verified locally before wiring: with the workflow unmodified the harness passes 12/12; with all three detection greps in the guarded script replaced by a never-matching pattern (the silent-breakage shape this protects against) the harness exits 1 reporting `FAIL fatal-logcat-with-live-process` and `FAIL boot-receiver-crash`. The guarded script was restored byte-identical afterwards (`git status` clean).

**First real GitHub run — confirmed 2026-09-18.** The workflow ran green on `ubuntu-latest` on its first real execution (run 35318475129, branch `ci-153`, 12/12 scenarios). The red proof was then repeated on the hosted runner: scratch branch `ci-153-broken-detection` neutralized all three logcat detection greps in `emulator-smoke-test.sh`, and the self-test job went red exactly as designed (run 35318562762 — `FAIL fatal-logcat-with-live-process`, `FAIL boot-receiver-crash`, harness exit 1). The scratch branch was deleted afterwards, so no broken detection remains anywhere. The same push proved the real-emulator `launch-smoke-test` job green through all four entry points (MainActivity, PROXY_TRIGGER, BOOT_COMPLETED, LOCKED_BOOT_COMPLETED after a PIN-protected reboot) on run 35318475149.

**Re-confirmed on the current wiring — 2026-09-27.** The self-test workflow file and harness had never landed on GitHub's `main` (divergent lineages), so the current wiring was proven end-to-end again on scratch branch `ci-task-90-selftest`, built from GitHub's own `main` plus exactly the self-test files (workflow, harness, fixtures) and the four-entry-point `emulator-smoke-test.sh` they depend on. The push itself satisfied the path filters and the workflow went green on `ubuntu-latest` on its first real execution of this wiring (run 36322245457, 12/12 scenarios). The red proof followed on the same branch: the three logcat detection greps in `emulator-smoke-test.sh` were replaced with a never-matching pattern, and the self-test job went red exactly as designed (run 36322793292 — job log reports `FAIL fatal-logcat-with-live-process`, `FAIL boot-receiver-crash`, harness exit 1). Reverting the break returned the branch to green (run 36323115530). The scratch branch was deleted afterwards; no broken detection remains anywhere.

## Re-verifying on real CI (scratch branch recipe)

End-to-end confirmation on the hosted runner belongs to the first-real-CI-run task. Recipe:

1. Add the throw shown in *Method* step 4 to `MainActivity.onCreate` on a scratch branch.
2. Push a change touching `artifacts/covert-alert-system/android-test-package/**` (or `workflow_dispatch`).
3. Confirm `assemble-debug` succeeds and `launch-smoke-test` **fails**, with the `FATAL EXCEPTION` / `smoke-test self-check` excerpt visible in the job log.
4. Revert the throw, re-run, confirm green.


## EvidenceCaptureService phase — 2026-09-27

**Question:** the bounded evidence-capture playground (still via Camera2, video via
Camera2+MediaRecorder, audio via MediaRecorder, durable staging + upload retry) was
verified only by the APK compile gate. A runtime regression — a camera-session
misconfiguration that throws on every capture, a MediaRecorder state mistake, a
foreground-service-type mismatch — compiles cleanly and would only surface during a
hardware run. Can the emulator CI job exercise the service and go red on a broken one?

**Coverage added (fifth entry point in `emulator-smoke-test.sh`, between the
BOOT_COMPLETED phase and the PIN/reboot phase):** the job grants CAMERA + RECORD_AUDIO
(`pm grant`, failing loudly if refused), brings MainActivity back to the foreground
(the service is a while-in-use camera+microphone FGS, so the app must be
foreground-eligible when it starts on API 34+), <!-- toolreq-gate: allow -- describes Android platform while-in-use FGS start eligibility (begins at API 34), not a declared tool requirement --> starts the non-exported
EvidenceCaptureService via `am start-foreground-service` from the root shell already
acquired for the broadcast phase (root is exempt from the API 35 non-exported
restriction), then polls the device-protected journal (read as root) until every
requested kind — photo, video, audio — has an EVIDENCE_CAPTURE outcome, and requires
each to be `CAPTURED`. A first cut accepted a clean `FAILED` with detail; review
rejected that because the service's per-kind catch turns ordinary camera/recorder
regressions into exactly those events, so a capture-everything breakage would have
shipped green. The pinned CI image demonstrably captures all three kinds (verified
below, audio included even with `-no-audio`), so a FAILED after retry is red, with the
journaled detail surfaced for diagnosis. Two safeguards make this precise: the journal
is wiped via `pm clear` before every attempt (a reused device otherwise serves stale
outcomes from a prior run — observed live, where attempt 1 judged the previous run's
events), and the whole capture cycle is retried once with fresh app state so a
transient emulator codec-readiness flake (observed live: `MediaRecorder: prepare
failed` while `MediaRecorderService` logged `OMX service is not available` under TCG)
gets a second chance, while a systematic regression fails both attempts and still goes
red. Three fast-red paths run during the
poll: a package-scoped `FATAL EXCEPTION` (process death mid-capture), a journaled
`CAPTURE_START_FAILED` (terminal — the service stopped itself), and the 7-minute
timeout naming the missing kinds. Ordering constraint: this phase MUST stay before the
PIN-protected reboot, because camera/mic capture is impossible while the device is
locked. The job timeout went 20 → 30 minutes to hold the ~4 minutes of real capture
time (six 30s audio segments + 20s video + camera setup).

**It caught a real bug on its first live run.** The green verification run went red
inside the capture phase: `CAPTURE_START_FAILED — java.lang.SecurityException: Neither
user 10209 nor current process has android.permission.WAKE_LOCK.` The service acquires
a partial wake lock but the manifest never declared WAKE_LOCK — invisible to the
compile gate, fatal to every capture on any device. The permission was added; the
fast-red `CAPTURE_START_FAILED` branch was added to the script at the same time so
this failure shape goes red in seconds instead of burning the whole capture timeout.

**Real-emulator results (API 35 google_apis x86_64, Pixel 6 profile, TCG — same image
and emulator options as CI):**

| Run | APK | Result |
|-----|-----|--------|
| 1 | pre-fix (no WAKE_LOCK) | **red** — journal recorded `CAPTURE_START_FAILED` (SecurityException: WAKE_LOCK); the poll timed out waiting for outcomes (the fast-red branch did not exist yet) |
| 2 | healthy (WAKE_LOCK declared) | **green through the capture phase** — `photo: CAPTURED`, `video: CAPTURED`, `audio: CAPTURED`, `EvidenceCaptureService check passed`. (The run then failed the PIN-reboot phase's 5-minute boot poll — a local TCG-slowness limit already documented above, unrelated to capture; CI is KVM-accelerated.) |
| 3 | deliberate breakage (`throw AssertionError("EVIDENCE-CAPTURE-SELF-CHECK …")` as the first line of `photograph()`, escaping both `catch (Exception)` blocks) | **red, fast** — exit 1 at the poll-loop's first fatal grep: `::error::EvidenceCaptureService crashed — FATAL EXCEPTION for com.covertalert.pixeltest during capture.` with the excerpt showing `java.lang.AssertionError: EVIDENCE-CAPTURE-SELF-CHECK: deliberate breakage for detection verification` at `EvidenceCaptureService.photograph` |
| 4 | healthy (byte-identical revert of the throw, verified via `git diff`) | **green through the capture phase** — `photo: CAPTURED`, `video: CAPTURED`, `audio: CAPTURED`, `EvidenceCaptureService check passed` (the run then entered the PIN-reboot phase, which cannot finish within its 5-minute poll under TCG locally — see run 2 note) |

Review then rejected the lenient verdict (any `FAILED` with detail passed), because the
service's per-kind catch turns ordinary camera/recorder regressions into exactly those
events. The gate was tightened to require `CAPTURED` per kind, and verification
continued on the strict gate:

| Run | APK | Result |
|-----|-----|--------|
| 5 | healthy, strict gate (no retry yet) | **red** — video `FAILED: java.io.IOException: prepare failed.` while logcat showed `MediaRecorderService: OMX service is not available`: a transient TCG codec-readiness flake, not a product bug (runs 2/4 captured video on the same image). Motivated the single fresh-state retry. |
| 6 | deliberate caught-exception breakage (`throw IOException("EVIDENCE-CAPTURE-SELF-CHECK …")` as the first line of `photograph()` — the per-kind-catch shape the reviewer required as a negative control), strict gate + retry | **red naming photo on both attempts** — attempt 1: `photo: not CAPTURED — …EVIDENCE-CAPTURE-SELF-CHECK…`, video/audio CAPTURED; retry fired; attempt 2 identical; final `::error::…still not CAPTURED for kind(s) photo…` with the self-check detail. Also exposed and fixed a gate bug: the first version of this run judged STALE journal events from run 5 (attempt 1 went "photo: CAPTURED" off a 16-min-old journal) — the phase now `pm clear`s before EVERY attempt so a reused device cannot green the phase without the service running. |
| 7 | healthy (byte-identical revert, verified via `git diff`), strict gate + retry + journal isolation | **green through the capture phase** — attempt 1 hit the video OMX flake again (`prepare failed`), the retry fired, attempt 2 captured all three kinds: `photo: CAPTURED`, `video: CAPTURED`, `audio: CAPTURED`, `EvidenceCaptureService check passed`. Live proof that the retry absorbs the transient flake without masking persistent regressions. |

**Self-test:** `.github/scripts/verify-launch-smoke-detection.sh` models the new phase
in its fake adb (`pm grant`, `pm clear` with journal-fixture swap for the retry,
`am start-foreground-service`, journal fixtures carrying
EVIDENCE_CAPTURE events; phase numbering is now 1=MainActivity, 2=PROXY_TRIGGER,
3=BOOT_COMPLETED, 4=evidence capture, 5=locked-boot after reboot) and proves 19/19
scenarios, including the new ones: `evidence-capture-crash` (FATAL for our process
mid-capture, red at the poll-loop grep with excerpt), `evidence-capture-missing-outcome`
(one kind short, red at the timeout naming it), `evidence-capture-failed-goes-red`
(audio FAILED with detail persisting across the retry — red naming the kind; the
caught-exception regression shape), `evidence-capture-retry-recovers-green`
(video FAILED on attempt 1, all CAPTURED after the `pm clear` retry — green; proves
the retry absorbs emulator flakes without masking persistent regressions),
`service-start-failure`
(red at the am error), `pm-grant-failure` (red at the grant error), and
`capture-start-failed-fast-red` (CAPTURE_START_FAILED in the journal — red in one poll
iteration with the detail surfaced). Fixtures: `evidence-crash-logcat.txt`,
`journal-capture-video-flake.xml`,
`journal-capture-missing-audio.xml`, `journal-capture-clean-failed.xml`,
`journal-capture-start-failed.xml`; `journal-healthy.xml` and
`journal-missing-locked-boot.xml` now carry capture events.


## LOCKED_BOOT_COMPLETED (direct-boot) follow-up — 2026-09-15

**Question:** the manifest registers BootReceiver with `directBootAware=true` and an
`android.intent.action.LOCKED_BOOT_COMPLETED` filter — the broadcast delivered BEFORE the
user unlocks the device. Can the job exercise that pre-unlock path, and does the same
crash detection hold there?

**Why injecting the action is not enough:** a first cut of this phase sent
`am broadcast -a android.intent.action.LOCKED_BOOT_COMPLETED` after the earlier phases
had run. That is NOT direct-boot coverage: by then user 0 is unlocked and
credential-encrypted (CE) storage is available, so a regression that touches CE storage
in `onReceive` (e.g. TestStore switched from `createDeviceProtectedStorageContext()` to
plain `getSharedPreferences`) would stay green in CI and only crash on a field device
rebooting to the lock screen. The phase was reworked to exercise the real locked state.

**Coverage added (real locked boot):** the job now

1. sets a lockscreen PIN (`locksettings set-pin 1234`, root shell from the
   BOOT_COMPLETED phase), so the next boot keeps user 0 LOCKED until credentials are
   entered;
2. calibrates the locked-state probe while still unlocked: `sys.user.0.ce_available`
   must read `true` — if it does not, the property can prove nothing after the reboot
   and the job fails loudly instead of claiming coverage;
3. reboots and waits for `sys.boot_completed` — the system then delivers
   LOCKED_BOOT_COMPLETED naturally, during the direct-boot phase, to the
   directBootAware receiver (no injection);
4. explicitly asserts the precondition: `sys.user.0.ce_available` must NOT be `true`
   after the PIN-protected reboot (user 0 still locked, CE storage unavailable);
5. checks for a package-scoped `FATAL EXCEPTION` (`Process: com.covertalert.pixeltest`
   within 2 lines) in the post-reboot logcat — `pidof` is NOT a valid detector here,
   since pre-unlock the app has no reason to keep a process after the receiver returns;
6. requires delivery evidence: the device-protected journal
   (`/data/user_de/0/com.covertalert.pixeltest/shared_prefs/gate0a-local-journal.xml`,
   read as root — DE storage is available pre-unlock) must contain a BOOT_OBSERVED event
   with action LOCKED_BOOT_COMPLETED, proving the receiver actually ran and that its
   journal writes go to direct-boot-safe storage.

**Runtime cost:** one emulator reboot (~1–2 min on the accelerated macOS runner) —
comfortably within the existing 20-minute job timeout.

**Self-test:** `.github/scripts/verify-launch-smoke-detection.sh` now models the
reboot in its fake adb (a reboot marker flips `ce_available` from `true` to empty and
serves a post-reboot logcat/journal fixture) and proves 12/12 scenarios, including the
new red cases: `locked-boot-receiver-crash` (FATAL for our process in the post-reboot
logcat), `locked-boot-no-delivery-evidence` (journal lacks the LOCKED_BOOT_COMPLETED
event — no-crash alone is not proof of delivery), `locked-state-precondition-fails`
(`ce_available` still `true` after reboot — device never actually locked), and
`set-pin-failure`. Fixtures: `locked-boot-crash-logcat.txt`, `journal-healthy.xml`,
`journal-missing-locked-boot.xml`.

**Note on a live re-verification attempt:** standing up the API 35 emulator again in
this workspace was attempted but the system image plus a writable AVD no longer fits
the per-user disk quota, so the PIN-protected reboot path has not yet been observed on
a real boot here. The first real CI run (the existing first-real-CI-run task) is where
`locksettings set-pin` and the `ce_available` behaviour on the actual
`google_apis`/pixel_6 image get confirmed; both fail loudly (steps 1–2 above) if the
image does not cooperate, so the job cannot silently claim direct-boot coverage.
