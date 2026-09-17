---
name: Gate 0A report schema lockstep
description: The harness report schema and the web app's import validation must change together; CI enforces this via a shared validator.
---

# Gate 0A report schema lockstep

The Gate 0A harness (measure-gate0a.sh, schema cas-gate0a-report-v2) and the CovertAlertSystem import validation are two implementations of one contract. The app's validation lives in a single shared module (api-server: src/lib/gate0a-report.ts) used by both the import route and a CI validator script.

**Why:** Before this, the harness schema could drift from the app schema and field operators would only discover it when an import failed after a hardware run. CI now feeds the harness self-test report through the exact route validation and proves a drifted report is rejected.

**How to apply:** Any change to the report shape in the harness must be mirrored in gate0a-report.ts (and vice versa) in the same change, or the git-bash-report CI job fails. Do not add a second copy of the schema elsewhere — extend the shared module.

Volume limits are part of the same contract, not just field shapes: schema array caps and the UI/API upload size bounds must cover a real default hardware run's footprint, or real reports are rejected while small synthetic checks stay green. When touching report validation, test with reports emitted by the harness's own report writer (seeded at real-run volume) rather than hand-written fixtures, which drift into shapes no real run could produce.

Device-free physical evidence is an integrity boundary: tooling shipped to field operators must not be able to manufacture a device-free report that import validation accepts as physical evidence. Keep such fixture generators in repo-only tooling outside the packaged kit.

The on-device journal may record events outside the import contract (e.g. MVP alert activity). The Gate 0A report builder must filter events to the validator's accepted enum before emitting the report, and the harness must probe permission state from the installed package dump rather than hardcoding grant values — adding a manifest permission (e.g. INTERNET for the MVP build) otherwise turns the report's permission evidence false.
