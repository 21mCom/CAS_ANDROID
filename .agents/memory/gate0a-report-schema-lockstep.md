---
name: Gate 0A report schema lockstep
description: The harness report schema and the web app's import validation must change together; CI enforces this via a shared validator.
---

# Gate 0A report schema lockstep

The Gate 0A harness (measure-gate0a.sh, schema cas-gate0a-report-v2) and the CovertAlertSystem import validation are two implementations of one contract. The app's validation lives in a single shared module (api-server: src/lib/gate0a-report.ts) used by both the import route and a CI validator script.

**Why:** Before this, the harness schema could drift from the app schema and field operators would only discover it when an import failed after a hardware run. CI now feeds the harness self-test report through the exact route validation and proves a drifted report is rejected.

**How to apply:** Any change to the report shape in the harness must be mirrored in gate0a-report.ts (and vice versa) in the same change, or the git-bash-report CI job fails. Do not add a second copy of the schema elsewhere — extend the shared module.
