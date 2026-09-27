---
name: Kit gates first real CI run
description: The first real GitHub run of the Windows test-kit gates already happened on branch ci-153 (run 35319853990, green); check code identity before burning a duplicate run for "confirm first run" tasks.
---

GitHub Actions run **35319853990** (branch `ci-153`, head 144c3569, 2026-09-18,
workflow "Windows test-kit entry points", all jobs success) is the first real
windows-latest execution of: the tool-requirements drift gate, the hardcoded
API-floor gate, the hardcoded JDK-minimum gate (each with its prove-it-breaks
negative step), the validator-parity job, the run-guide freshness job, and the
MVP handoff ZIP freshness job.

**Why:** these gates were merged to the workspace lineage while GitHub main
stayed far behind, so each "confirm the first real run" task does not need a
fresh scratch-branch push — the sweep branch already ran them. Sibling
confirmations (drift gate, JDK hardcode gate, run-guide freshness) were
completed by observing this run.

**How to apply:** for a "confirm gate X passes on its first real GitHub run"
task, first check whether run 35319853990 (or a newer run on
`/actions/workflows/windows-test-kit-entrypoints.yml/runs`) already executed
the gate's steps green. Then prove the run tested the shipping code:
`git diff main refs/remotes/ci/ci-153` must show no differences in the gate
script, the workflow steps, and every file the gate scans (for the kit gates:
`android-test-package/scripts/**` and the packager/entry-point scripts under
`artifacts/covert-alert-system/scripts/`; docs and .kt app sources are not
scanned). If anything in the scan surface drifted since, push a fresh scratch
branch per the divergent-lineages recipe in `github-ci-access.md`. Job logs
download fine with `Authorization: Bearer $GITHUB_PAT` against
`/actions/jobs/<id>/logs`.
