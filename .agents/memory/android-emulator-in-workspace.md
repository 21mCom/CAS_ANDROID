---
name: Android emulator in this workspace
description: A full Android emulator works here despite no KVM — but its modem never registers, so outbound-SMS flows can only be verified up to the radio send.
---

A full Android emulator CAN run in this workspace. Durable constraints:

- **Storage:** the overlay home + /tmp share a small quota; the workspace volume is large — put SDK/AVD/Gradle state and logs there. Under quota pressure JVMs die with SIGBUS in hsperfdata; set `_JAVA_OPTIONS=-XX:-UsePerfData`.
- **No KVM:** boot with `-no-accel` (x86_64 works under TCG); cold boot takes minutes and post-boot package scanning lags, so retry installs/launches rather than failing fast.
- **Boot-complete ≠ install-ready:** `sys.boot_completed=1` flips before the system providers are installed; `adb install` then dies with `IllegalStateException: Cannot access system provider: 'settings'` or StorageManager/PackageManagerInternal NPEs, and freshly launched activities can be lost to system_server restarts. Gate harnesses on `settings get global device_provisioned` answering AND `init.svc.bootanim=stopped`, retry `adb install` (3×/10s), and expect the first post-boot launch to need a retry.
- **Process lifetime:** daemons started with plain `nohup … &` from a ShellExec call do not survive the call — run the emulator and any drill driver as `run_in_background` tasks, and drive the whole drill from ONE long-lived background task so its adb server isn't reaped mid-run.
- **Daemons are reaped between ShellExec calls:** a postgres postmaster started via `pg_ctl -w start` and the `adb` server both die once the foreground shell returns — the next call sees "connection refused" / "daemon not running; starting now". Run long-lived services (postgres, the API server, the emulator) as `run_in_background` tasks, and run any adb-driving harness itself as ONE background task so the adb server it spawns lives for the whole run. There is no `/usr/lib/postgresql` here; the nix-store postgresql-16 bin dir has initdb/pg_ctl/psql (already on PATH).
- **GUI libs:** the emulator binary needs libX11 from the nix store via `LD_LIBRARY_PATH`; run headless with `-no-window`.
- **Snapshots:** restoring snapshots after TCG boots corrupts system_server; run `-no-snapshot` and wipe userdata between runs.
- **Networking into the device:** qemu's 10.0.2.2 host alias does NOT reach this container's loopback — use `adb reverse` and have the device talk to 127.0.0.1.
- **No cellular modem:** the emulated modem never registers here (no `isms` binder service; every `SmsManager` op, including `divideMessage`, throws UnsupportedOperationException) even though telephony features are declared. Feature checks do not predict this. Do not burn cycles trying to make outbound SMS work locally: verify everything except the radio-accept leg here, and let CI/hardware own the SENT assertion. An unfinished-batch state is likewise unreachable locally (divideMessage fails before any send), so it can only be seeded or produced on hardware.
- **Camera/mic capture DOES work locally (2026-09-27):** the virtual camera and mic capture fine even with `-no-audio` — the evidence-capture phase journaled photo/video/audio all CAPTURED. The older note that the system image + AVD no longer fit the disk quota is stale: everything on the workspace volume fits.
- **TCG reboot exceeds 5 min:** the smoke script's PIN-protected-reboot phase (`sys.boot_completed` poll, 60×5s) times out locally; phases before it complete normally, so read partial output before concluding a local run "failed". CI (KVM) is unaffected.
- **TCG codec readiness flakes:** `MediaRecorder: prepare failed` with `MediaRecorderService: OMX service is not available` in logcat is a transient emulator condition (intermittent, ~every other run under TCG), not a product bug. Any capture gate must retry once before going red.
- **Reused-device journals are stale:** a smoke gate polling a device journal must wipe app state (`pm clear`) before EACH attempt, or it judges the previous run's events — a false-green hole on any non-fresh device.
- **`pkill -f emulator` self-kills:** the wrapper shell's own command line contains the pattern, so pkill kills the calling task. Kill by exact process name or PID instead.
- **UI driving is NOT viable on the TCG workspace emulator:** `uiautomator dump` takes minutes under TCG, the uiautomator process gets SIGKILLed device-side under load, and the Pixel Launcher ANR-loops over the app. Every existing harness avoids UI interaction (am start / broadcasts / journal polling) — that is why. Validate UI-driving harnesses (e.g. verify-send-outcome-line.sh) on a CI scratch branch instead (KVM: dumps ~1s); see ui-automator-harness-lessons.md.

**Why:** these were each multi-hour dead ends; the recipe is reusable for any future Android verification task.

**How to apply:** follow this recipe instead of concluding emulator verification is impossible; only physical Pixel runs still need the hardware workstation.
