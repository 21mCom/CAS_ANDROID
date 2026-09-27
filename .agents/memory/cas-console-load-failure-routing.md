---
name: CAS console load-failure routing
description: State-load failures in the console route three ways — mismatch surface, credential lock, or labeled offline demo — and new failure kinds must pick one explicitly.
---

The console's state-load failure path (applyLoadFailure in use-field-test.tsx) routes every failure into exactly one of three surfaces:

1. Server response fails contract validation → full-screen mismatch surface.
2. Missing/rejected device credential (CasCredentialError — includes a cancelled enrollment prompt) → full-screen locked surface with a retry that re-opens enrollment. Never the demo seed.
3. Genuinely unreachable server → the built-in demo seed, shown only with the offline/demo banner.

**Why:** an operator who cancelled the credential prompt used to silently get the SAMPLE incidents/gates, and could mistake demo data for live incident state on a safety console.

**How to apply:** any new failure kind or new load/reload path must route through the same three-way decision; never add a silent fallback to the demo seed, and never let credential failures render incident data.
