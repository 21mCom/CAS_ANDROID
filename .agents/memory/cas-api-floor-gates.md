---
name: CAS tool-requirements gate pair
description: The kit has two complementary gates over tool-requirements.json literals — drift gate (disagreeing literals) and API-floor hardcode gate (any API literal in scripts, even matching).
---

# CAS tool-requirements gate pair

Two CI gates guard `tool-requirements.json` as the source of truth, with different trigger conditions:

- `check-tool-requirements-drift.py` (marker prefix `toolreq-gate:`) fails only on literals that **disagree** with the declaration. A hardcode equal to the current value passes it.
- `check-hardcoded-api-floor.py` (marker prefix `apifloor-gate:`) fails on **any** API-level literal/comparison in script files (*.ps1, *.cmd, *.sh), even one matching the declaration. Docs are out of its scope.

**Why:** the hardcoded-API-floor drift class occurred twice (measure-gate0a.sh, mvp-install.ps1); matching-value hardcodes pass the drift gate and silently fork the floor at the next declaration bump.

**How to apply:**
- A deliberate hardcoded fixture/fallback in a kit script needs markers from **both** gates if it trips both (see windows-preflight.ps1's drift-fixture region, which carries both allow blocks; its missing-declaration fallback carries only the apifloor-gate block because the drift gate never flags agreeing literals).
- Marker reasons must not themselves contain gated literals (e.g. write "the declared level", not "API 35").
- The apifloor comparison band is fixed (20–49) and also catches JDK-major-sized numbers in comparisons; exempt genuine fixtures rather than narrowing the band.
