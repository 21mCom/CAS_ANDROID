# CAS Pixel Gate 0A — Field Handoff (2026-09-14)

**Summary:** Full Gate 0A run completed on a physical Google Pixel 11 (stock Android 17 / API 37). All checks passed — 219/219 events, including all 200 repeat launches, zero failures, no warnings. Safety flags all clear.

**Read this correctly:** the report shows `gate0aPassed: false` **by design** — the kit never auto-declares a pass. The evidence is complete and clean; a human still needs to record the Gate 0A observation in the CAS console. So this is "evidence complete, pending human sign-off," not "Gate 0A passed."

**Fixes:** the app needed two source fixes to build and launch, and the runner needed one fix to emit its report on Windows — all documented in section 3. The results above are from the run performed after those fixes.

**Machine-import file:** `report.json` (cas-gate0a-report-v2) is delivered separately as a file — it is ~250 KB and must be imported into the CAS console intact, not pasted as text.

---

# 1. Run report (report.md)

# CAS Gate 0A run report

- **Evidence class:** `physical-device-observation`
- **Run status:** `complete`
- **Preflight:** `PASS`
- **Started (UTC):** `2026-09-14T14:57:29Z`
- **Finished (UTC):** `2026-09-14T15:08:31.726651Z`
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

## Safety boundary

- No live SMS/XMPP, network, production covert behavior, or application-data clearing.
- Factory reset and Device Owner provisioning are not performed by this kit; either action requires a separate approved procedure and explicit confirmation.

The JSON file is the CAS import file. Review this report and the raw references before importing.

---

# 2. Windows preflight (preflight-report.md)

﻿# CAS Pixel Gate 0A Windows preflight

- **Overall status:** `PASS`
- **Generated (UTC):** `2026-09-14T13:10:53.1093798Z`
- **Target mode:** `physical`
- **Computer:** `CORDINATOR`

## Checks

| Status | Required | Check | Observed | Expected |
| --- | --- | --- | --- | --- |
| PASS | True | Android SDK environment variables | Using C:\Users\CAS_DEV\AppData\Local\Android\Sdk | ANDROID_SDK_ROOT or ANDROID_HOME points to the Android SDK folder. |
| PASS | True | JAVA_HOME | C:\Users\CAS_DEV\AppData\Local\Programs\Eclipse Adoptium\jdk-25.0.4.101-hotspot | JAVA_HOME points to a JDK 17 or newer installation. |
| PASS | True | Java command | Java 25.0.4.1 (major 25) at C:\Users\CAS_DEV\AppData\Local\Programs\Eclipse Adoptium\jdk-25.0.4.101-hotspot\bin\java.exe | JDK 17 or newer. |
| PASS | True | Java PATH entry | C:\Users\CAS_DEV\AppData\Local\Programs\Eclipse Adoptium\jdk-25.0.4.101-hotspot\bin | JAVA_HOME\bin is present in PATH. |
| PASS | True | Android SDK folder | C:\Users\CAS_DEV\AppData\Local\Android\Sdk | An existing Android SDK folder. |
| PASS | True | Android platform-tools | C:\Users\CAS_DEV\AppData\Local\Android\Sdk\platform-tools\adb.exe | platform-tools\adb.exe exists in the selected SDK. |
| PASS | True | platform-tools PATH entry | C:\Users\CAS_DEV\AppData\Local\Android\Sdk\platform-tools | The SDK platform-tools folder is present in PATH. |
| PASS | True | ADB command | Android Debug Bridge version 1.0.41 | ADB responds to adb version. |
| PASS | True | Android build-tools | 36.0.0 | Build-tools 35.0.0 or newer. |
| PASS | True | Android API 35 platform | C:\Users\CAS_DEV\AppData\Local\Android\Sdk\platforms\android-35\android.jar | platforms\android-35\android.jar exists. |
| PASS | True | Git Bash command | C:\Program Files\Git\bin\bash.exe | Git Bash is available for the guarded Pixel 11 Gate 0A runner. |
| PASS | True | Gradle command | Gradle 9.7.0 at C:\Gradle\gradle-9.7.0\bin\gradle.bat | Gradle 8.9 or newer. |
| PASS | False | Android command-line tools | C:\Users\CAS_DEV\AppData\Local\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat | sdkmanager.bat is available for optional, confirmed SDK preparation. |
| PASS | True | Physical-device ADB status | Authorized physical device detected: 67270DLKY00E9K         device product:cubs model:Pixel_11 device:cubs transport_id:1 | An authorized physical device appears as device in adb devices -l. |
| SKIPPED | False | Android Emulator tool | Skipped because target mode is physical. | Not evaluated. |
| SKIPPED | False | Emulator ADB status | Skipped because target mode is physical. | Not evaluated. |

## Safety record

- This preflight does not install an APK, change Device Owner state, reboot a device, send a message, or capture evidence.
- Device actions performed: `False`
- SDK preparation actions: `None`

## Attachments

Attach this Markdown file and the matching JSON file to the CAS field-run record. A `BLOCKED` result means the Gate 0A run must not continue. A `WARN` result requires the operator to resolve or document the warning before the field run.

---

# 3. Kit fixes required (for the maintainers)

# CAS Pixel Gate 0A — Kit Fixes Needed

**Source:** 2026-09-14 physical Pixel 11 Gate 0A run.
**Device:** Pixel 11, stock Android 17 / API 37, USB-debugging authorized.
**Kit:** CAS-Pixel11-Windows-Test-Kit-v5.

Three issues were hit. Fixes 1 and 2 are required (the run cannot build or pass without them). Fix 3 is why no `report.json`/`report.md` is written on Windows. The final run passed 219/219 checks (all 200 repeats) only after Fixes 1 and 2.

---

## Fix 1 — Build error: `singleLine` is not a Kotlin property (blocks compile)

**File:** `app/src/main/java/com/covertalert/pixeltest/MainActivity.kt` — `coverInput` EditText block (~line 33)

**Before**
```kotlin
singleLine = true
```

**After**
```kotlin
isSingleLine = true
```

**Why:** `singleLine` is an XML-only attribute; `EditText`/`TextView` expose no Kotlin `singleLine` property. The settable property is `isSingleLine` (maps to `setSingleLine()`). Under Kotlin 2.0.21 + androidx the original line fails to compile with `Unresolved reference 'singleLine'`, and `:app:compileDebugKotlin` fails, so no APK is produced.

*(Two build warnings — a `kotlinOptions` deprecation and "SDK XML version 4 … up to 3" — are harmless and can be ignored.)*

---

## Fix 2 — Runtime: proxy intent won't resolve, every launch fails (blocks the test)

**File:** `app/src/main/AndroidManifest.xml` — the `TriggerActivity` intent-filter

**Before**
```xml
<intent-filter>
    <action android:name="com.covertalert.pixeltest.action.PROXY_TRIGGER" />
</intent-filter>
```

**After**
```xml
<intent-filter>
    <action android:name="com.covertalert.pixeltest.action.PROXY_TRIGGER" />
    <category android:name="android.intent.category.DEFAULT" />
</intent-filter>
```

**Why:** the proxy is fired as an **implicit** intent (action only, no explicit component) — both by `am start -a com.covertalert.pixeltest.action.PROXY_TRIGGER` in `measure-gate0a.sh`, and by the app's own `IntentFactory.proxy()` and the pinned shortcut. Android only delivers implicit intents to activities whose filter includes `CATEGORY_DEFAULT`. Without it the system cannot match the activity, and `am start` returns:

```
Error: Activity not started, unable to resolve Intent { act=...PROXY_TRIGGER }
```

In the first qualification this produced 8/8 failed launch samples with that exact error. After adding the DEFAULT category, launches returned `Status: ok` (`Activity: com.covertalert.pixeltest/.TriggerActivity`) and all checks passed. This is baseline Android behavior, not specific to API 37.

---

## Fix 3 — `report.json` / `report.md` never written on Windows (silent evidence gap)

**File:** `scripts/measure-gate0a.sh` — `write_report()`

**Symptom:** the run completes and `host.log` prints `Run record written: .../report.json`, but no `report.json` or `report.md` appears in `gate0a-results/<run>/`.

**Cause:** `write_report()` calls native Windows `python3` with Git-Bash/MSYS **POSIX** paths, e.g. `/c/Users/CAS_DEV/...`. Windows Python does not understand the `/c/` mount prefix and treats `/c/Users/...` as drive-relative (`C:\c\Users\...`), so the files are written to a bogus `C:\c\...` tree instead of the run folder. The call is wrapped in `|| true`, so the failure is swallowed and the run still exits 0 and logs success.

**Fix (applied):** convert the path arguments to native Windows form with `cygpath` before handing them to Python. Only the first four arguments are paths; the trailing three are metadata and stay unchanged. Guarded so it is a no-op on Linux/macOS.

**Before**
```bash
write_report() {
    local report="$RUN_DIR/report.json"
    python3 - "$report" "$EVENTS_FILE" "$ENV_FILE" "$RUN_DIR" "$STARTED_AT_UTC" "$STARTED_AT_MS" "$FINAL_STATUS" <<'PY'
```

**After**
```bash
write_report() {
    local report="$RUN_DIR/report.json"
    # Fix: native Windows python3 misreads Git-Bash POSIX paths (/c/Users/...).
    # Convert path args to native form via cygpath when available; passthrough elsewhere.
    _to_native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
    python3 - "$(_to_native "$report")" "$(_to_native "$EVENTS_FILE")" "$(_to_native "$ENV_FILE")" "$(_to_native "$RUN_DIR")" "$STARTED_AT_UTC" "$STARTED_AT_MS" "$FINAL_STATUS" <<'PY'
```

**Recommended (optional) hardening:** drop the `|| true` on the `write_report` call in `finalize()` (or check Python's exit code and log a real error) so a failed report write cannot masquerade as a successful run.

**Note:** only the Python-generated `report.json`/`report.md` are affected. All other evidence (`events.ndjson`, `environment.tsv`, `host.log`, `launch/`, `tasks/`, `logcat/`, `screenshots/`) is written correctly by bash. A missing report can be regenerated after the fact from `events.ndjson` + `environment.tsv` using the same generator embedded in `write_report()`.
