---
name: First-real-CI-run confirmations
description: For "confirm X passes on its first real GitHub run" tasks, scan existing workflow runs for the phase/job marker before dispatching a new run.
---

For tasks of the form "confirm CI phase/job/gate X passes on its first real GitHub run", do NOT start by pushing or dispatching. First list recent runs of the workflow (`/actions/workflows/<file>/runs`) and grep the relevant job logs (`/actions/jobs/<job_id>/logs`) for the phase's marker lines. Concurrent sessions push to main frequently, so the first real run often already happened on someone else's push — confirming from existing logs satisfies the task and avoids burning a duplicate run.

**Why:** A confirmation task for the emulator evidence-capture phase was fully satisfied by an existing push run; three more green runs had accumulated within a day. A duplicate dispatch would only have added a fourth.

**How to apply:** Identify the run window by when the phase's commit landed on remote main (commits API on the touched file), then check job *log content*, not just run order: push time and tree content can differ (a commit authored at 02:24 may only appear in trees pushed hours later), so the earliest run after the commit date may still lack the phase. Note unrelated infra failures separately (e.g. corrupt emulator SDK zip in android-emulator-runner setup fails before the script runs) — they are not phase failures.
