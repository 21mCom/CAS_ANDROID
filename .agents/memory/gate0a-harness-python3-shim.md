---
name: Gate 0A harness python3 shim and write_report extraction coupling
description: measure-gate0a.sh must not call python3 outside write_report; write_report's globals must also be initialized in the hardware-fixture generator
---

Two non-obvious couplings around `artifacts/covert-alert-system/android-test-package/scripts/measure-gate0a.sh`:

1. **Windows CI deliberately breaks python3.** `scripts/test-windows-entrypoints.ps1` and the `git-bash-report` job in `.github/workflows/windows-test-kit-entrypoints.yml` shadow `python3` with a broken shim to prove a failed report write cannot exit 0. Any harness code that runs *before* `write_report()` (arg parsing, requirements loading, self-test seeding) must not invoke `python3`, or the negative test breaks (harness dies before creating a run dir/host.log/"report generation failed" marker). Parse `tool-requirements.json` with sed/grep instead.

2. **The hardware fixture generator extracts `write_report()` verbatim** (`scripts/generate-gate0a-hardware-report-fixture.sh`, repo root — deliberately not packaged). It sources the extracted function under `set -u`, so every global `write_report()` references (e.g. the derived pinned-device constants PINNED_AVD/EMULATOR_API/MIN_PHYSICAL_API) must also be initialized in the generator, or the API contract suite's exact-harness-writer report test fails.

**Why:** both couplings caused completion-review rejections; neither is discoverable without running CI or the api-server test suite.
**How to apply:** when editing the harness, keep python3 usage inside `write_report()` only, and grep the fixture generator after adding any new global to the writer.
