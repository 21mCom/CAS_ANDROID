---
name: CAS tool-requirements gates
description: The kit has complementary gates over tool-requirements.json literals — drift gate (disagreeing literals), API-floor hardcode gate, and JDK-minimum hardcode gate (any matching comparison in scripts).
---

# CAS tool-requirements gates

Three CI gates guard `tool-requirements.json` as the source of truth, with different trigger conditions:

- `check-tool-requirements-drift.py` (marker prefix `toolreq-gate:`) fails only on literals that **disagree** with the declaration. A hardcode equal to the current value passes it, and it needs a keyword form ("JDK 17", "API 35") to match at all.
- `check-hardcoded-api-floor.py` (marker prefix `apifloor-gate:`) fails on **any** API-level literal/comparison in script files (*.ps1, *.cmd, *.sh), even one matching the declaration. Comparison band 20–49. Docs are out of its scope.
- `check-hardcoded-jdk-minimum.py` (marker prefix `jdkfloor-gate:`) fails on **any bare comparison** against a plausible JDK major (band 8–30) in script files, even one matching the declaration. Comparison forms only — assignments (e.g. ExpectedMajor fixtures) and keyword literals are out of scope.

**Why:** the hardcoded-API-floor drift class occurred twice (measure-gate0a.sh, mvp-install.ps1); matching-value hardcodes pass the drift gate and silently fork the floor at the next declaration bump. The JDK axis had the same hole: `-lt 17` has no JDK keyword and sits below the API band, so neither older gate saw it.

**How to apply:**
- A deliberate hardcoded fixture/fallback in a kit script needs markers from **every** gate it trips (windows-preflight.ps1's drift-fixture region carries all three allow blocks).
- Marker reasons must not themselves contain gated literals (e.g. write "the declared level", not "API 35").
- The comparison bands are fixed and overlap deliberately (JDK 8–30, API 20–49); a comparison in the overlap turns both gates red. Exempt genuine fixtures rather than narrowing the bands.
