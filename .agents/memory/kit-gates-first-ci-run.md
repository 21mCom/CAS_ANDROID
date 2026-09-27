---
name: Kit gates first real CI run
description: The Windows test-kit gates have already executed green on a real GitHub Actions run; before burning a fresh scratch-branch run for a "confirm first run" task, prove code identity against that earlier run.
---

The kit's tool-requirements drift gate, API-floor gate, JDK-minimum gate
(each with its prove-it-breaks negative step), the validator-parity job, the
run-guide freshness job, and the MVP handoff ZIP freshness job have all
executed green on real windows-latest GitHub runners — the "first real run"
question for these gates is settled.

**Why:** these gates were merged to the workspace lineage while GitHub main
stayed far behind, so each "confirm the first real run" task does not need a
fresh scratch-branch push if an earlier run already covered the same code.

**How to apply:** for a "confirm gate X passes on its first real GitHub run"
task, first check the workflow's run history for an earlier green run that
executed the gate's steps. Then prove the run tested the shipping code: diff
main against that run's ref — the gate script, the workflow steps, and every
file the gate scans must be identical (for the kit gates: the kit's
scripts/** and the packager/entry-point scripts; docs and .kt app sources are
not scanned). If anything in the scan surface drifted since, push a fresh
scratch branch per the divergent-lineages recipe in `github-ci-access.md`.
Job logs download fine with the PAT secret against the job-logs API.
