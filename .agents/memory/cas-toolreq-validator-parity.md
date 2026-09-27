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
one-sided change (verified locally both directions, and the CI job itself was
proven green on a real windows-latest runner — cygpath/pwsh/artifact-extraction
mechanics included — on 2026-09-27, so it can be trusted as a gate).

**How to apply:**
- Any change to one validator's rules must land in the other; both files carry
  lockstep comments pointing at the parity harness.
- The Bash validator is sed-based and intentionally supports only the kit's
  canonical one-field-per-line JSON shape. That shape is contractual: the
  PowerShell parser enforces it explicitly, so reformatted declarations
  (compacted, inline-section, string-typed numbers) reject on both sides,
  while field reordering within the canonical shape accepts on both.
- The CI negative step weakens the PowerShell jdk-plausibility check and
  requires the parity run to turn red on the missing-jdk fixture. Any new
  guard in the PowerShell parser must let a wholly absent field fall through
  to the plausibility checks (rather than rejecting it itself), or that
  negative step stops going red.
- Known residual gap (from completion review): the PowerShell guard's `\s*`
  matches newlines, so a newline-after-colon reformat passes PowerShell but
  fails the sed parse. Fix = horizontal-whitespace-only patterns (mind CRLF)
  plus a rejecting fixture.
- The parity script needs one pwsh invocation (use `PARITY_PWSH` locally); it
  extracts `load_pinned_device_constants` from the harness the same way the
  hardware-fixture generator extracts `write_report`, so keep both extraction
  targets brace-simple (no `^}` lines inside the function body).
