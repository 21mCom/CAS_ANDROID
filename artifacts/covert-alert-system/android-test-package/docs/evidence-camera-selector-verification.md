# Evidence capture — camera selector (front / both) physical verification

**Date:** 2026-10-01
**Subject:** T10 step 4a of `HANDOFF-TEST-KIT.md` — the console's *Camera for photo & video* selector (back / front / both) honored end to end on the physical Pixel 11
**Question:** does the selector produce one labeled photo and one labeled video per lens on real hardware, and does *Front only* restrict capture to the front lens — all while the phone stays screen-off and UI-free?

## Verdict

**PASS on the physical Pixel 11.** Both selector modes behaved as specified. No `DEGRADED` outcome was journaled — the Pixel 11 supports concurrent front+back capture, so the full per-lens set landed.

## Run

- Fresh kit APK built from the current tree (`app-debug.apk`, versionCode 7, versionName `0.8.0-selfupdate`) and installed on the physical Pixel 11 over the existing kit app. (The previously built APK on disk predated the self-update commit and was rebuilt for this run.)
- T10 step 4a executed per `HANDOFF-TEST-KIT.md`: Photo and Video on *Start on trigger* / *Immediate*.

## Results

| Selector | Result |
|----------|--------|
| *Front and back* | One still and one ~20 s clip **per lens** landed in the incident evidence panel, each labeled with its camera (`photo · back camera`, `photo · front camera`, …), downloads named per the `…-photo-back-1.jpg` / `…-photo-front-2.jpg` pattern |
| *Front camera* only | Only front-labeled artifacts landed |
| Journal | `EVIDENCE_CAPTURE` entries carry the `camera` field; **no** `outcome=DEGRADED` line — concurrent front+back capture is supported on this device |

The phone stayed screen-off and UI-free throughout; the green OS indicator appeared as expected and accepted by the kit.

## Report-back line

```text
T10 evidence capture: PASS — camera selector (front/both) honored & labeled; both lenses captured concurrently (no DEGRADED); front-only restricted to front-labeled artifacts
```
