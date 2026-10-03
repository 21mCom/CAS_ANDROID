# Evidence capture — covered-lens gate verification

**Date:** 2026-10-03
**Subject:** Covered-lens gate for photo/video evidence capture — skip solid-black artifacts, pin flash off on every capture request
**Question:** does the app skip photo/video capture from a physically covered lens (pocket, box, face-down) while still capturing dark-but-real scenes, and can the flash never fire?

## Status

**Unit-verified; physical-Pixel calibration and field proof are the follow-up hardware task.** This document records the design, the decision table pinned by unit tests, and the residual ambiguity the field proof must characterize.

## What was built

- **`CoveredLensClassifier`** (pure Kotlin, no Android imports): takes per-frame statistics (mean luma, spatial variance of the Y plane) plus ambient lux and proximity-near, and returns covered / not-covered with every signal it decided on. Thresholds live in one place as named constants (`MAX_COVERED_MEAN_LUMA`, `MAX_UNIFORM_VARIANCE`, `MAX_COVERED_LUX`) ready for field calibration.
- **Per-lens luminance probe** in `EvidenceCaptureService`: before each photo or video capture, the camera is opened on a small `YUV_420_888` `ImageReader`, frames stream for ~1 s, and the **last** frame is classified (by then auto-exposure has settled, so ramp-up frames cannot read as a false "covered"). Light and proximity sensors are sampled across the same window. The probe runs on the existing serialized worker thread, so it can never overlap another capture.
- **Gate in the per-lens capture loop**: a covered verdict skips that lens's photo/video and journals `EVIDENCE_CAPTURE` with outcome `SKIPPED_COVERED`, the lens label, and the measured signals (`meanLuma=… variance=… lux=… proximity=… — reason`). Probe failures fail **open** (capture proceeds) and are journaled as outcome `PROBE_FAILED`. In `both` mode each lens is probed independently; audio is untouched.
- **Flash pinned off everywhere**: still, record, and probe requests are all built through one helper that explicitly sets `CONTROL_AE_MODE_ON` and `FLASH_MODE_OFF` — no template default or future edit can fire the flash.

## Decision table (pinned by `CoveredLensClassifierTest`)

| Scenario | Signals | Verdict |
|----------|---------|---------|
| Pocket | uniform black, lux ≈ 0, proximity near | **SKIP** |
| Box | uniform black, lux ≈ 0, proximity silent | **SKIP** |
| Face-down on lit table | uniform black, lux low (sensor blocked), proximity near | **SKIP** |
| Lit room, lens blocked (finger/tape) | uniform black, lux high | **SKIP** |
| No light sensor, proximity near | uniform black, lux unavailable, near | **SKIP** |
| Dark scene with structure (night street) | mean low, variance above bound | **CAPTURE** |
| Dim but readable scene | mean above black bound | **CAPTURE** |
| Normal lit scene | mean/variance far above bounds | **CAPTURE** |
| Uniform black, no sensor corroboration | lux unavailable, proximity absent/far | **CAPTURE** (fail open) |
| Borderline at bounds | mean/variance exactly at bound counts as covered; one step above captures | per bound |

## Residual ambiguity (accepted, journaled)

A truly pitch-black room with nothing near the proximity sensor is **indistinguishable from a box** at these signal levels: uniform black frame + dark ambient. The classifier is conservative everywhere else (structure or uncertainty always captures), but this combination is treated as covered and its signals are journaled so the decision is auditable in the console. The field-calibration task should measure real pocket/box/face-down/dark-room distributions on the Pixel 11 and retune the three constants if real dark rooms false-trip.

## Verification run

- `gradle :app:testDebugUnitTest` — all unit tests green, including the 15 classifier cases above.
- `gradle :app:assembleDebug` — kit APK compiles clean against the pinned SDK platform.
- Server journal schema unchanged: `outcome` is a free-form string (max 64), `detail` max 500 — `SKIPPED_COVERED` / `PROBE_FAILED` and the signal detail line fit without a schema lockstep change.

## What the field proof (follow-up) must show

On the physical Pixel 11: pocket, box, and face-down produce `SKIPPED_COVERED` journal lines per covered lens with sensible signal values; a dark-but-structured scene still captures; `both` mode skips only the covered lens; the flash never fires; and the measured distributions feed back into the threshold constants.
