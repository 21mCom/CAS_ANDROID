# Launch smoke test — crash detection verification

**Date:** 2026-09-15
**Subject:** `launch-smoke-test` job in `.github/workflows/android-test-package-build.yml`
**Question:** does the job actually turn red when the Gate 0A test app crashes on launch, with the logcat excerpt surfaced — or could a bad grep pattern / swallowed `am start` error leave it silently green?

## Verdict

**Proven end-to-end on a real API 35 emulator.** A deliberately crashing debug APK makes the job script exit 1 with the crash excerpt in the output; the non-crashing APK stays green. The verification also caught and fixed a real gap: the original `tail -200` excerpt did **not** contain the fatal-crash block on a noisy emulator, so the red run lacked the evidence a reviewer needs.

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
3. **Cold-boot timing race (environment-specific, non-blocking).** The very first healthy attempt failed red with `Error: Activity class does not exist` because `am start` ran while the freshly cold-booted TCG emulator was still scanning packages. It resolved on its own seconds later and all subsequent runs behaved. CI's `android-emulator-runner` waits for full boot on a hardware-accelerated macOS runner, so this is not expected there — but it usefully demonstrated the am-start-failure branch going red with real output.
4. **Under TCG the healthy `am start -W` reports `Status: timeout` (WaitTime ~27 s) yet exits 0** and the process is alive — the script correctly treats this as green. Not expected on accelerated CI.

## Ongoing regression coverage (no emulator needed)

`.github/scripts/verify-launch-smoke-detection.sh` extracts the same `script:` block verbatim and runs it against a simulated adb with realistic logcat fixtures (`.github/scripts/launch-smoke-fixtures/`). After the workflow fix it passes 5/5: healthy green, crash-after-successful-am-start red with excerpt, fatal-logcat-with-live-process red with excerpt, am-start failure red, unrelated-package force-finish green.

Negative controls (proof the harness is not vacuous): mutating **one** of the three logcat patterns still goes red via the remaining patterns; mutating **all three** lets a crash slip through green, and the harness reports `FAIL fatal-logcat-with-live-process` with exit 1. Both mutations were reverted byte-identical afterwards.

Run it after any change to the detection script:

```bash
bash .github/scripts/verify-launch-smoke-detection.sh
# exit 0 = red/green behavior preserved; exit 1 = detection regression; exit 2 = extractor drift
```

## Re-verifying on real CI (scratch branch recipe)

End-to-end confirmation on the hosted runner belongs to the first-real-CI-run task. Recipe:

1. Add the throw shown in *Method* step 4 to `MainActivity.onCreate` on a scratch branch.
2. Push a change touching `artifacts/covert-alert-system/android-test-package/**` (or `workflow_dispatch`).
3. Confirm `assemble-debug` succeeds and `launch-smoke-test` **fails**, with the `FATAL EXCEPTION` / `smoke-test self-check` excerpt visible in the job log.
4. Revert the throw, re-run, confirm green.
