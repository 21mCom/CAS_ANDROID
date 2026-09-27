---
name: CAS tool-requirements validator parity
description: The kit validates tool-requirements.json twice (shared PowerShell parser and the Gate 0A Bash harness's sed parse); both must accept/reject identically, proven by a parity harness.
---

# CAS tool-requirements validator parity

The kit has two independent validators over `tool-requirements.json`:
`Get-ToolRequirements` in `cas-tool-requirements.ps1` (dot-sourced by all
Windows entry points) and `load_pinned_device_constants` in
`measure-gate0a.sh`. Their accept/reject sets must be identical;
`scripts/check-tool-requirements-parity.sh` (repo-only, run against the
packaged kit by the `validator-parity` job in windows-test-kit-entrypoints.yml)
proves it over shared fixtures in `scripts/fixtures/tool-requirements-parity/`.

**Why:** the Bash side originally skipped the jdk section, buildToolsMinimum,
and plausibility checks the PowerShell parser enforced — a kit could pass on
the workstation and fail in the field. The parity harness now turns red on any
one-sided change (verified locally both directions).

**How to apply:**
- Any change to one validator's rules must land in the other; both files carry
  lockstep comments pointing at the parity harness.
- The Bash validator is sed-based and intentionally supports only the kit's
  canonical one-field-per-line JSON shape; parity fixtures must use that shape.
  Known un-covered divergence classes: compacted/reordered JSON formatting and
  string-typed numbers (`"apiLevel": "35"` casts fine in PowerShell, fails sed).
- The parity script needs one pwsh invocation (use `PARITY_PWSH` locally); it
  extracts `load_pinned_device_constants` from the harness the same way the
  hardware-fixture generator extracts `write_report`, so keep both extraction
  targets brace-simple (no `^}` lines inside the function body).
