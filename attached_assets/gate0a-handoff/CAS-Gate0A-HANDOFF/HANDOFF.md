# CAS Pixel 11 Gate 0A — Handoff Packet (2026-09-16)

## Result
- **Kit:** CAS-Pixel11-Windows-Test-Kit-v6 (official release)
- **Target:** Google Pixel 11 (stock) · Android 17 / API 37 · build CD1A.260905.001.B1 · serial 67270DLKY00E9K
- **Run:** `gate0a-results\20260916T064713Z-415`
- **Outcome:** `complete` — 219/219 checks pass, **200/200 repeat launches**, 0 failures, 0 unresolved warnings
- **Evidence class:** `physical-device-observation`
- **Preflight:** `PASS` (`cas-windows-preflight-20260916T070123Z`)

## Do this in the CAS console
1. **Feasibility → Import Gate 0A report → choose `report.json`** (contract `cas-gate0a-report-v2`) → **Validate & import**. This records the import as **INCONCLUSIVE pending human review** — expected; an import never declares a pass.
2. **Attach the Windows preflight** (`.json` + `.md`) to the field-run record.
3. **Record the operator's physical Gate 0A observation separately** (the human GO decision). Suggested text below.

## Kit review checklist — all satisfied
- Evidence class `physical-device-observation` ✓
- Preflight `PASS` ✓ (attached)
- Run status `complete`; every per-check outcome pass; unresolved warnings: **none** ✓
- Identity confirmed: serial / model / Android version+build / USB state / disposable package `com.covertalert.pixeltest` ✓
- Complete run directory retained with the field record; not uploaded to any third-party service ✓

## Files in this packet
- `report.json` — the CAS import file (`cas-gate0a-report-v2`)
- `report.md` — human-readable run report
- `cas-windows-preflight-20260916T070123Z.json` / `.md` — the matching PASS preflight

## Full raw evidence (retained on the workstation — keep with the field record; do not upload to a third-party service)
`C:\Users\CAS_DEV\Downloads\CAS-Pixel11-Windows-Test-Kit-v6\gate0a-results\20260916T064713Z-415\`
containing `host.log`, `events.ndjson`, `environment.tsv`, and the `launch\`, `tasks\`, `screenshots\`, `logcat\` directories.

## Operator observation (confirm / adjust to what you actually saw)
- Observer: ______________________   Date/time: 2026-09-16 (Asia/Dubai)
- Physical Gate 0A observation: The proxy→cover launch behaved correctly across cold, warm, locked, and after-reboot samples and all 200 repeat launches; Back/Home/Recents, force-stop process-interruption recovery, and reboot recovery were nominal; no extra splash/frame, wrong task, broken Back behavior, or stray Recents card was observed.
