---
name: Operator guide packs for waiting tasks
description: Durable lessons for writing plain-English operator guide ZIPs for this project.
---

Lessons from building the waiting-tasks operator guide:

- **Actor-splitting:** write human sheets for a non-technical reader and keep agent
  handoffs separate, each naming the task ref it unblocks. **Why:** the operator
  carries the pack to the Windows hardware workstation; agents only need their own
  files.
- **Stale-version trap:** task plans name deliverable ZIP versions that go stale (a
  plan said v0.7.0 while v0.8.0 was current). Always resolve the newest matching ZIP
  in `deliverables/` and reference that exact filename — never trust the version
  literal inside an older task plan.
- **Field-send drills must resolve incidents between sends:** the API folds repeat
  triggers into the active incident and the app skips SMS for reused incidents, so any
  drill with multiple sends must resolve each incident in the console first. Also, the
  console responder circle is authoritative for online triggers — a failure drill that
  needs a bad recipient must change the number in the console, not on the phone.
  **Why:** a completion review rejected guide sheets whose drills could not produce
  their stated results when followed as written.
- **Provider safety:** never include token/credential values in operator docs; keep the
  "no token values" instruction visible in every report-back template.
- **Signing trap in update proofs:** a field pack staged without the release-key
  secrets builds a debug-signed base APK, but a one-tap-update proof publishes a
  pinned-key-signed update — Android rejects the certificate change. Any guide covering
  an N→N+1 update must first establish a pinned-signed build N on the phone (or
  document the one-time uninstall/reinstall migration) and verify both builds share
  the same certificate. Also, server-side phone validation rejects junk numbers, so a
  radio-failure drill cannot be driven by saving an invalid recipient — it needs a
  number that passes validation but fails at the radio.
