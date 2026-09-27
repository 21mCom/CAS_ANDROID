# Task 163 evidence — alert-location CI jobs' first real GitHub run

## Verdict

Both new alert-location CI surfaces passed on a real GitHub Actions run, after
two genuine CI-only failures were found and fixed (exactly what this task was
for — neither reproduced locally):

- **Run 36328969126** (branch `ci-163-alert-location`, head 8420f27,
  workflow "Android test package build", 2026-09-27): **all 5 jobs green** —
  including `Alert location harness (JVM, no emulator)` (job 108647102741) and
  `Drive the handset SMS send/receipt/re-queue flow against a dev API`
  (job 108647301885).

## Proof lines from the real-run job logs

Raw logs committed alongside this file:
`task-163-alert-location-joblog.txt`, `task-163-sms-flow-joblog.txt`.

Alert-location JVM harness (ubuntu-latest):

```
ALERT_LOCATION_OK checks=30
```

Emulator SMS flow with the geo-fix location assertion (ubuntu-latest + KVM):

```
contract OK: re-queue refuses a missing alert credential (HTTP 401)
Alert phase passed: incident sim-... outbox item ...-sms -> DEAD_LETTER (broken number 'not-a-real-number').
Location phase passed: incident carries fix {"latitude":52.5163,"longitude":13.3777,"accuracyM":5,"capturedAt":"2026-09-27T15:19:51.739Z"}
contract OK: console re-queue of the dead-lettered item (HTTP 200)
Re-queue phase passed: outbox item ...-sms -> SENT after handset pickup.
SMS flow proof passed: QUEUED -> DEAD_LETTER (broken number) -> QUEUED (re-queue) -> SENT (fixed number), receipts REPORTED from the handset, contracts enforced.
```

The `52.5163 / 13.3777` coordinates are the injected `adb emu geo fix` values,
asserted via `/cas/state` — the assertion added by the GPS-location task ran
and passed on the real runner.

## Run history (how we got to green)

| Run | Head | Result | What it showed |
| --- | --- | --- | --- |
| 36327062669 | d6d1d64 | failure | alert-location job **green** on first try. sms-flow job red: `HVF error: HV_UNSUPPORTED / failed to initialize HVF` on macos-latest — the emulator cannot boot on Apple Silicon runners (no nested virtualization). Identical failure on GitHub main runs 36322629091 and 36323875754, so pre-existing, not caused by the location change set. Boot-smoke job red: `adb: unable to connect for root: closed` at the post-reboot `adb root` re-acquire, after all app checks had passed. |
| 36328467873 | 71e44a9 | failure | sms-flow job moved to ubuntu-latest + KVM + x86_64 (disposable PostgreSQL via preinstalled apt binaries, port 55432). Emulator booted in 37 s, then red: `/usr/bin/sh: 1: set: Illegal option -o pipefail` (exit 2) — the emulator action runs `script:` via dash on ubuntu. Boot-smoke job **green** — the adb-root failure above is a flake. |
| 36328969126 | 8420f27 | **success** | `script:` reduced to the boot-smoke job's single-line `bash .github/scripts/verify-sms-flow.sh` pattern (APK preflight moved into the harness). All 5 jobs green. |

## CI-only fixes (cherry-picked onto workspace main)

1. `a33b599` — sms-receipt-flow-test moved macos-latest → ubuntu-latest + KVM,
   arch arm64-v8a → x86_64; PostgreSQL bootstrap now uses the runner's
   preinstalled apt PostgreSQL on port 55432 instead of Homebrew.
2. `cd42168` — the sms-flow emulator `script:` block no longer uses
   `set -euo pipefail` (dash on ubuntu rejects pipefail); the APK-missing
   preflight moved into `verify-sms-flow.sh`, which runs under bash.

`git diff main ci-163-alert-location -- .github/ scripts/` is empty: the
proven branch content and workspace main are identical for the CI surface.

## Code identity

The scratch branch was built as GitHub main (4147ee2) + the exact tree of
workspace main 36449ce for the GPS-alert-location change set (27 files), so
the run exercised the shipping code, not a reduced variant. The branch
deliberately excludes the contiguous Stripe doc-example literal (workspace
main assembles it at runtime), so GH013 push protection did not fire.

## Known remaining flake (follow-up proposed)

The boot-smoke job's post-PIN-reboot `adb root` re-acquire failed once with
"unable to connect for root: closed" (run 36327062669) and passed on the
identical script in run 36328969126 — a transient adbd disconnect with no
retry in `emulator-smoke-test.sh`.

## Confirmation on the final tree (post-review repair round)

The first green run (36328969126) exercised the pre-enrollment-merge tree.
The completion review required repairing the merged tree first (cas.ts
three-way-merge rebuild, device-token revocation fallback retired,
SmsFlowActivity enrolled-credential retention, MainActivity/AlertSender
repeat-alert fix, deterministic geo-fix injection). The final confirmation
ran against that exact repaired tree:

- Branch `ci-163-alert-location` head cb20459 (= workspace main a3e3335 tree,
  content-synced). Workflow run **36333945160** — all five jobs green:
  - `Alert location harness (JVM, no emulator)` — job 108661082333 success
    (the task's primary new CI surface).
  - `Drive the handset SMS send/receipt/re-queue flow against a dev API` —
    job 108661254342 success, including the new geo-fix location assertion:
    `Location phase passed: incident carries fix {"latitude":52.5163,
    "longitude":13.3777,"accuracyM":5,...}`, alert phase DEAD_LETTER on the
    broken number, re-queue phase SENT after handset pickup.
  - Receipt durability, Gate 0A APK compile, boot-smoke jobs all success.
- Raw final sms-flow log: `.local/tasks/task-163-sms-flow-final-joblog.txt`.
- The contract preflight now also proves the retired shared device token is
  refused (401) once enrollment is in use and the enrolled credential is
  accepted (200) — lines 593-596 of the final log.
- Local gates on the final tree: api-server typecheck 0 errors
  (`--incremental false`), 103/103 CAS contract tests pass.

Intermediate red runs on the repaired tree (each diagnosed and fixed, none
left unexplained): adb-root flake (rerun), pickup 401 from the app's
enrolled-credential wipe (fixed in SmsFlowActivity), NO_FIX geo race (fixed
by boot-time injection; dumpsys location does not report injected
coordinates on this image, so liveness is timed, not polled).

## Final confirmation on the rebased tree (run 36335559989)

The completion rebase onto current main replayed the cas.ts rebuild textually
and mangled it; the file was reconstructed with a proper three-way merge
(`git merge-file`, keeping main's console responder-circle and deviceSms work
alongside the location/attribution repair) and one test was aligned with the
retired shared-token gate (the pickup must present the enrolled credential
via Bearer). Local gates on the rebased tree: typecheck clean, suites 114/114
and 21/21 green.

The exact rebased tree was then re-confirmed on real GitHub Actions:

- Branch `ci-163-alert-location` head 8f29021 (= workspace main 2808a41 tree,
  content-synced). Workflow run **36335559989** — all five jobs green:
  - `Alert location harness (JVM, no emulator)` — job 108665617713 success.
  - `Drive the handset SMS send/receipt/re-queue flow against a dev API` —
    job 108665815276 success, with the geo-fix location assertion:
    `Location phase passed: incident carries fix {"latitude":52.5163,
    "longitude":13.3777,"accuracyM":5,...}`; alert phase DEAD_LETTER on the
    broken number; re-queue phase SENT after handset pickup; preflight proves
    the retired shared device token is refused (401) and the enrolled
    credential accepted (200).
  - Compile Gate 0A APK, receipt durability, and boot-smoke jobs all success.
- Raw final sms-flow log replaced: `task-163-sms-flow-final-joblog.txt` now
  holds run 36335559989's log.
