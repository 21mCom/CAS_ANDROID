---
name: Replit deployment secret sync
description: Deployment secrets sync automatically from workspace secrets — a publish inherits live credentials unless explicitly overridden
---

Replit's publishing flow syncs workspace secrets into the published app automatically; deployment-secret entries act as per-key overrides (an empty override value reads as "not configured").

**Why:** A runbook written on the assumption "deployments start with no workspace values" was wrong and would have armed this workspace's live `CAS_EMAIL_SMTP_*` credentials on first publish. Confirmed against docs.replit.com/features/publishing/overview ("Secrets sync automatically from your development environment to your published app").

**How to apply:** Any publish/deployment guide for this project must quarantine live delivery secrets (blank overrides) BEFORE first publish and treat the synced list as untrusted. Never assume deployment env starts empty; never rely on `.replit [userenv.shared]` values staying dev-only either.
