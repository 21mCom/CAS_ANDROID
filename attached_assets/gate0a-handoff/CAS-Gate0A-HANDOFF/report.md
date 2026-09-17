# CAS Gate 0A run report

- **Evidence class:** `physical-device-observation`
- **Run status:** `complete`
- **Preflight:** `PASS`
- **Started (UTC):** `2026-09-16T06:47:13Z`
- **Finished (UTC):** `2026-09-16T06:55:25.431777Z`
- **Target:** `67270DLKY00E9K` · Pixel 11 / cubs · API 37 · build CD1A.260905.001.B1

## Preflight checks

| Status | Check | Observed | Expected |
| --- | --- | --- | --- |
| PASS | USB authorization and debugging | adb state=device; debugging=true | The selected target is authorized in adb device state with USB debugging enabled. |
| PASS | Approved device identity | serial=67270DLKY00E9K; model=Pixel 11; device=cubs | The operator-confirmed target is the approved Pixel 11, or the pinned Pixel 8a/API 35 emulator. |
| PASS | Android version and build | API 37; Android 17; build CD1A.260905.001.B1 | Pinned emulator API 35, or approved physical Pixel 11 on API 35 or newer, with a readable release and build identifier. |
| PASS | Expected disposable package identity | com.covertalert.pixeltest | com.covertalert.pixeltest is installed and inspectable. |

## Unresolved warnings

- None

## Evidence references

- `host.log`
- `events.ndjson`
- `environment.tsv`
- `package-dump.txt`
- `screenshots`
- `logcat`
- `tasks`
- `launch`
- `screenshots/after-process-interruption.png`
- `screenshots/after-reboot-launch.png`
- `screenshots/back.png`
- `screenshots/cold-launch.png`
- `screenshots/home.png`
- `screenshots/locked-launch.png`
- `screenshots/post-unlock-launch.png`
- `screenshots/recents.png`
- `screenshots/repeat-001.png`
- `screenshots/repeat-200.png`
- `screenshots/unlocked-launch.png`
- `screenshots/warm-launch.png`

## Safety boundary

- No live SMS/XMPP, network, production covert behavior, or application-data clearing.
- Factory reset and Device Owner provisioning are not performed by this kit; either action requires a separate approved procedure and explicit confirmation.

The JSON file is the CAS import file. Review this report and the raw references before importing.
