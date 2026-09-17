# CAS Pixel 11 Windows test kit

Use this copy only with the dedicated, approved Google Pixel 11. The included
Android package is a disposable local Gate 0A harness. It does not send SMS or
XMPP messages, collect location, record audio/video, or enable production
behavior.

## Before the phone arrives

1. Extract the complete ZIP to a normal writable folder. Do not run scripts
   from inside the ZIP.
2. Double-click `scripts\run-windows-preflight.cmd`.
3. Resolve every `BLOCKED` result. The normal physical-device preparation path
   needs the JDK, Android SDK platform, and build-tools levels declared in
   `tool-requirements.json` at the package root (that file is the source of
   truth the preflight enforces and CI builds with), the Gradle release pinned
   in `gradle-version.txt` (also a source of truth matching CI), ADB, and Git
   Bash.
4. If the Android SDK command-line tools are already installed, the explicitly
   approved SDK preparation command is:

   ```powershell
   scripts\run-windows-preflight.cmd -Target physical -PrepareSdk
   ```

   It prints the package list and requires the operator to type `INSTALL`.

## When the Pixel 11 arrives

1. Keep it dedicated to this supervised test. Device Owner provisioning may
   require a factory reset through a separate approved procedure; this kit does
   not perform that reset or provisioning.
2. Complete normal Android setup only as permitted by that procedure.
3. Enable Developer options and USB debugging under operator supervision.
4. Connect the Pixel with a data-capable USB cable, unlock it, and accept the
   RSA debugging prompt only for the approved workstation.
5. Double-click `scripts\run-windows-preflight.cmd` again. Continue only if the
   physical target result is `PASS`.
6. Read `gate0a-run-guide.pdf`.

## First-arrival qualification

Double-click:

```text
scripts\run-pixel11-qualification.cmd
```

The wrapper verifies that ADB reports exactly one authorized `Pixel 11` on API
35 or newer. It then asks you to type `RUN PIXEL 11`, builds and installs the
disposable APK, and runs a one-repeat qualification.

Review the newest `gate0a-results\<timestamp>-<process>\report.md`, screenshots,
logs, tasks, and warnings. Do not continue if the result is blocked, the wrong
device was selected, or the observer sees unexpected behavior.

## Full physical Gate 0A run

Only after the qualification evidence is acceptable, double-click:

```text
scripts\run-pixel11-full.cmd
```

This performs the supervised physical sequence and 200 repeat launches. It may
force-stop the disposable package, change screen state, and reboot the phone.
Stay with the phone and follow every prompt.

## Preserve and import the evidence

Keep the complete timestamped result directory. The CAS import file is:

```text
gate0a-results\<timestamp>-<process>\report.json
```

It uses the `cas-gate0a-report-v2` contract. Importing it into the CAS console
always records an inconclusive observation pending human review; it never
declares Gate 0A passed automatically.

Also retain:

- `report.md`
- `host.log`
- `events.ndjson`
- `environment.tsv`
- `launch`, `tasks`, `screenshots`, and `logcat` directories
- the matching Windows preflight JSON and Markdown
- the printed guide and observer notes

The Pixel 8a/API 35 emulator remains available for software rehearsal only.
Never label emulator output as physical Pixel 11 evidence.
