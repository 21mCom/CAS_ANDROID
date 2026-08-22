# CovertAlertSystem — Pixel MVP Agentic Build Handoff

**Status:** Build authorization for MVP feasibility + implementation  
**Target:** Current supported Google Pixel, stock Android, provisioned as Device Owner  
**Distribution:** Private / dedicated-device provisioning  
**Core principle:** Alert first, trustworthy location second, evidence last.

---

## 1. Product Goal

Build a dedicated Android phone that still looks and behaves like an ordinary daily-use smartphone, but can silently enter a persistent duress state when the owner launches an ordinary-looking proxy icon.

The primary activation model is:

**Normal path**  
`Normal app icon → intended app opens`

**Duress path**  
`Visually equivalent proxy icon → one global incident starts → intended app opens normally`

The selected cover application may be **any installed application**. Different cover applications do not mean different emergencies. All covert triggers feed the same idempotent incident.

The attacker may be watching the screen and may later possess and browse the phone. Therefore the trigger and Priority-1 alert path should create as little visible disturbance as Android permits.

Do not build crypto-specific behavior, fake transactions, multiple contextual emergency meanings, or attacker-management workflows into the core product.

---

## 2. Strict Priority Model

Use these terms consistently throughout code, tickets, queues and tests:

### P1 — Distress Alert

Get an unmistakable distress event off-device to multiple predefined trusted recipients as quickly as possible.

MVP P1 transports:

- SMS
- XMPP

Both are independent P1 transports. Neither waits for the other.

### P2 — Trustworthy Location

Acquire and transmit a fresh or clearly-qualified recent location, then continue useful breadcrumbs.

### P3 — Evidence

Audio/video/evidence capture and transport are lower priority and are **not included in the initial MVP execution path**.

Nothing in P2 or P3 may block or delay P1.

---

## 3. MVP Platform Decision

Start with:

- Current supported Google Pixel.
- Stock Android production image.
- One pinned Android build during validation.
- CovertAlertSystem provisioned as **Device Owner / fully managed device**.
- Private installation/provisioning rather than Play Store distribution.
- Ordinary phone functionality preserved.

Do **not** begin with:

- root;
- custom AOSP;
- GrapheneOS;
- Samsung/One UI;
- custom launcher;
- consumer WhatsApp automation;
- linked WhatsApp Web;
- audio/video capture.

GrapheneOS and Samsung should be later validation targets once the reference Pixel build is proven.

Custom AOSP is a contingency path only if physical testing identifies a specific safety-critical Android disclosure or platform limitation that cannot be addressed at the app/device-owner level.

---

## 4. Build Philosophy

1. **P1 never waits for P2 or P3.**
2. **Every transport is independent.**
3. **Persistent state is authoritative; processes and sockets are disposable.**
4. **Duplicate delivery is preferable to a missed alert.**
5. **Stable incident/event IDs allow recipient-side deduplication.**
6. **Failure paths are normal operating states, not edge cases.**
7. **Reboot, process death, no signal, stale location and dual-SIM ambiguity must be designed explicitly.**
8. **Physical-device evidence outranks assumptions from Android documentation.**
9. **All repeat proxy activations during an active incident fold into the same incident.**
10. **Resolution appends history; it never erases history.**

---

# 5. Phase 0 — Mandatory Hardware Spikes

Do not start with a polished application shell. Build five disposable experiments first.

## Gate 0A — Proxy Launch

Build:

- one zero/minimal-UI proxy Activity;
- one pinned proxy shortcut;
- one selected cover app;
- one durable local trigger timestamp;
- immediate forwarding to the cover application's normal launcher intent.

Test cold/warm launch, target already in Recents, first launch after reboot, Back/predictive Back, themed icons, default animations, long-press/App Info, Recents/task artifacts, and at least 200 repeat launches.

Measure extra splash/frame, latency difference, double animation, wrong task, broken Back and stray Recents cards.

**Gate:** proceed if casual observation does not consistently reveal an abnormal transition. Forensic identity is not required.

## Gate 0B — SMS Covert/Delivery Behavior

Build explicit-subscription SMS send to two or more recipients, sent callback, delivery callback and local test log.

Test at minimum:

1. CAS is not default SMS app.
2. CAS is default SMS app.
3. Device Owner changes/restores SMS role if technically supported and safe.
4. Physical SIM + eSIM.
5. No preferred subscription.
6. Locked screen.
7. Doze.
8. Loss and restoration of service.
9. Rapid multiple-recipient sends.

Inspect Google Messages history, SMS Provider, role changes, dialogs/notifications, rate-limit warnings and SIM-selection artifacts.

**Gate:** decide and document the production SMS strategy before calling SMS covert.

## Gate 0C — Persistence After Lock / Process Death

Build a minimal foreground incident service backed by durable state.

Test six-hour lock, Doze, battery saver, process termination, task removal, reboot during incident, pre-unlock/post-unlock recovery, Wi-Fi/cellular changes, no network and restoration.

**Gate:** document exactly what survives, restarts automatically, or requires first unlock.

## Gate 0D — Location

Measure fresh-fix latency after trigger, cached location after long power-off, stationary jitter, 50 m/100 m walks, driving, indoor/urban-canyon behavior and lock-screen/location indicators.

**Gate:** choose thresholds from recorded traces, not theory.

## Gate 0E — Observer Inspection

Activate a test incident and hand the phone to an ordinary technically competent observer who does not know CAS exists. Ask them to use the cover app, Back/Home, Recents, notifications, Quick Settings, Settings and App Info.

Record every artifact that reveals Device Owner, FGS, proxy identity, location activity or SMS activity.

**Gate:** explicitly accept or reject residual visibility before full implementation.

---

# 6. MVP User Experience

## Setup UI

The owner should be able to:

- select a cover application;
- create/recreate the proxy shortcut;
- add/remove/reorder alert recipients;
- configure SMS numbers and XMPP JIDs;
- select the SMS subscription;
- edit the distress message;
- configure escalation timing;
- enroll responder acknowledgement/resolution keys;
- enable/disable periodic location heartbeat;
- run readiness checks;
- run a clearly marked TEST incident;
- see platform/permission readiness.

Do not expose an obvious incident browser in the everyday UI.

## Duress operation

User taps the proxy icon. CAS should:

1. durably create/reuse the active incident;
2. queue P1 SMS for every recipient;
3. queue P1 XMPP for every recipient;
4. start the incident coordinator;
5. wake both transport dispatchers independently;
6. immediately launch the intended cover app;
7. request a fresh location;
8. continue incident handling without further user action.

---

# 7. Trigger Critical Path

```text
Proxy tap
   ↓
Load validated emergency configuration
   ↓
Small durable transaction:
   • create/reuse incident ID
   • append TRIGGER_RECEIVED
   • enqueue P1 SMS items
   • enqueue P1 XMPP items
   ↓
Commit
   ↓
Start IncidentCoordinatorService
   ↓
Wake SMS + XMPP dispatch concurrently
   ↓
Launch cover app
   ↓
Finish proxy Activity
```

Rules:

- Never wait for SMS callbacks, XMPP, GPS, remote ACK or evidence.
- Cover-app launch failure must not cancel the incident.
- Repeated proxy taps create incident events but not new incidents.
- Use a cryptographically random incident ID.
- If durable storage unexpectedly fails at trigger time, attempt direct P1 sends from the last validated local configuration and tolerate duplicates.

---

# 8. Incident State Machine

```text
INACTIVE
   ↓ trigger
ACTIVATING
   ↓ durable incident exists
ACTIVE_UNACKED
   ↓ authenticated responder ACK
ACTIVE_ACKED
   ↓ authenticated RESOLVE
RESOLVED
```

Semantics:

- SMS sent/delivered ≠ human acknowledgement.
- XMPP stanza/receipt ≠ human acknowledgement.
- ACK means a real responder deliberately accepted responsibility.
- ACK does not stop location.
- Network loss, reboot, unlock, app use or timeout do not resolve.
- Resolution appends history and preserves the incident record.

---

# 9. Core Architecture

Use one application package for MVP.

| Component | Responsibility |
|---|---|
| `TriggerActivity` | Proxy tap, durable trigger, coordinator start, cover launch |
| `IncidentCoordinatorService` | Foreground incident lifecycle and recovery |
| `IncidentRepository` | Active incident, append-only journal, derived state |
| `OutboxDispatcher` | Independent transport queues and retry scheduling |
| `SmsTransport` | Explicit-subscription SMS and callbacks |
| `XmppTransport` | Connect/resume/send/receive/retry |
| `LocationEngine` | Cached/fresh classification, fresh fix, breadcrumbs |
| `CommandVerifier` | Authenticate ACK/RESOLVE and reject replay |
| `BootReceiver` | Resume/reconcile active incidents after boot |
| `DeviceAdminReceiver` | Device Owner provisioning/policies |
| `ReadinessChecker` | Verify deployment health |

Suggested stack: Kotlin, native Android SDK, coroutines/Flow, Room/SQLite WAL, Android Keystore, envelope encryption, Fused Location Provider behind an abstraction, maintained XMPP library behind a transport interface, and WorkManager only for delayed repair/reconciliation.

---

# 10. P1 — SMS Transport

SMS is a load-bearing P1 path.

Initial alert should be short and independent of location.

```text
DURESS A7K9 14:22Z.
Begin response protocol.
Do not call handset.
Location follows.
```

Requirements:

- one outbox item per recipient;
- explicit SIM/subscription;
- sent and delivery events recorded independently;
- bounded retries to avoid carrier/system rate limits;
- unresolved incidents retry at a safe cadence;
- location messages separate from initial alert;
- never imply delivery = human acknowledgement.

Gate 0B must resolve sent-history/SMS Provider behavior before release.

---

# 11. P1 — XMPP Transport

XMPP is an independent load-bearing P1 path.

During an active incident:

- connect immediately;
- maintain or recreate the connection under the incident FGS;
- use TLS with certificate validation;
- use modern SASL;
- support XEP-0198 stream management/resumption;
- use stable incident/event IDs;
- use bounded exponential reconnect;
- use connectivity callbacks;
- use short partial wake locks only around bounded critical operations where necessary;
- optionally add push later for inbound commands when the incident connection is not active.

Relevant protocol facilities:

- XEP-0198 — stream management/resumption;
- XEP-0184 — delivery receipts;
- XEP-0357 — push notifications where applicable.

Receipts are never equivalent to human ACK.

Classify no network, captive portal, DNS, TLS/certificate, bad clock, account/authentication, server rejection/outage, socket timeout, process death and recipient-offline conditions separately.

---

# 12. P2 — Location

The initial alert must not wait for GPS.

Every stored/transmitted fix should include timestamp, age, horizontal accuracy, source/provider, boot-session ID, cached/recent/fresh classification and mock-location flag where reported.

Suggested starting policy:

- after incident activation → **fresh/current fix**;
- same boot, ≤30 s and good accuracy → **recent fix**, age-labelled;
- same boot, 30 s–5 min → **last recent fix**, age-labelled;
- >5 min → **stale/last-known**, supplemental only;
- previous boot → **pre-reboot last-known**, never current.

At trigger, request a fresh fix with no acceptable cache age. Never delay P1 waiting for it.

For breadcrumbing, begin with:

```text
combined_uncertainty = sqrt(anchor_accuracy² + candidate_accuracy²)
```

Candidate movement should generally require distance ≥50 m, distance ≥~1.5–2× combined uncertainty, acceptable accuracy, a second agreeing fix, and 15–30 s minimum interval. Use a short rolling filter and reject impossible-speed jumps. Advance the anchor only when a breadcrumb is emitted.

Provide a stationary heartbeat about every 2–5 minutes. Tune from real traces.

---

# 13. Durable Incident Store

MVP must use durable local store-and-forward.

Never automatically delete incident journal, alert attempts, locations, ACK/RESOLVE records, errors or retry state.

Suggested tables:

- `incidents`
- `events`
- `outbox`
- `locations`
- `commands`
- `evidence_chunks` (schema only in MVP)

Use monotonic event sequencing, UTC + elapsed time, boot-session ID, hash chaining and unique outbox constraints. Processes may die; the journal remains authoritative.

---

# 14. Acknowledgement, Escalation and Resolution

ACK means a pre-enrolled responder deliberately accepted responsibility for the incident.

Prefer an authenticated XMPP command carrying command type, incident ID, challenge/nonce, responder key ID, counter/timestamp and digital signature.

ACK should record who accepted, stop unseen-incident escalation, but not resolve or stop location.

Escalation MVP:

- Tier 1 immediately.
- If no authenticated human ACK after configured period, notify Tier 2.
- Continue according to explicit owner policy.

RESOLVE is separate from ACK. Prefer authenticated remote resolution by enrolled responder(s), optionally requiring two signatures.

Never resolve on unlock, biometric, app launch, transport delivery, reboot, timeout or connectivity loss.

---

# 15. Device Owner Policy Use

Use Device Owner narrowly for reliability and safety:

- retain required permissions;
- resist ordinary uninstall;
- reduce app-standby/battery-management interference;
- configure selected deployment defaults;
- support tested SMS-role strategy if needed;
- disable debugging/unnecessary USB data in production;
- enforce automatic time/time-zone;
- enforce a tested OS update policy.

Avoid conspicuous kiosk mode, disabled status bar or restrictions that make the phone visibly abnormal.

---

# 16. Reboot and Recovery

Explicitly design for process restart, pre-unlock reboot, post-unlock reboot, locked/unavailable SIM, no network and restoration.

Where supported, receive boot/direct-boot events, inspect a minimal active-incident marker, restart/reconcile incident processing, resume any P1 work possible before unlock, wait for credential-encrypted state when necessary, and append recovery events rather than overwrite history.

Do not claim full pre-unlock recovery until proven on hardware.

---

# 17. Readiness and TEST Mode

Readiness checks should cover Device Owner, permissions, selected SIM, SMS strategy, XMPP TLS/auth, responders, location, FGS configuration, storage reserve, automatic time, battery restrictions, cover app and proxy shortcut.

Provide a distinct `TEST` incident type and require the responder team to practice alert receipt, ACK, escalation, location updates and RESOLVE.

A future daily readiness report is desirable but not required for first MVP.

---

# 18. Evidence — Schema Now, Feature Later

Create the evidence data model now but leave capture disabled.

Future evidence design must preserve **P1 Alert → P2 Location → P3 Evidence**.

Candidate future audio pipeline:

```text
continuous AudioRecord
      ↓
continuous encoder
      ↓
rotate ~5–15 s independently recoverable chunks
      ↓
authenticate/encrypt
      ↓
fsync + atomic finalize
      ↓
durable evidence queue
      ↓
opportunistic transmission
```

Evidence upload must never backpressure P1/P2. Audio/video inclusion is a later decision based on privacy-indicator and observer testing.

---

# 19. WhatsApp

Consumer WhatsApp is not part of MVP. Do not make accessibility/UI automation load-bearing.

Linked WhatsApp Web/slim-browser may be explored later as a disposable research spike only.

Keep the transport architecture extensible for future official/server-based WhatsApp transport without changing the incident kernel.

---

# 20. MVP Milestones

## Milestone 0 — Feasibility
Complete Gates 0A–0E and return hardware matrix, proxy decision, SMS decision, residual-visibility report and go/no-go.

## Milestone 1 — Incident Kernel
State machine, journal, active incident, outbox, idempotent retriggers, FGS coordinator, recovery.

## Milestone 2 — P1 Transports
SMS, XMPP, recipients, stable IDs, independent retry, error classification, TEST alerts.

## Milestone 3 — P2 Location
Cached/fresh classification, fresh fix, movement filtering, breadcrumbs, heartbeat, SMS/XMPP location.

## Milestone 4 — Response Control
Authenticated ACK, escalation, RESOLVE, replay protection, responder tooling.

## Milestone 5 — Device Owner Productionization
Repeatable provisioning, signing, policy profile, update and replacement/recovery process.

## Milestone 6 — Field Pilot
Small fleet, multiple carriers, long incidents, poor signal, movement, reboot/process-death, scheduled TEST incidents and response-team drills.

Only after field-pilot success add GrapheneOS, Samsung, evidence, WhatsApp experiments or remote backend.

---

# 21. MVP Acceptance Criteria

At minimum:

- every accepted proxy trigger creates/reuses exactly one active incident;
- cover-launch failure does not stop the incident;
- P1 SMS and XMPP start independently and do not wait for location;
- transport/network loss is recoverable without losing queued state;
- repeated taps do not reset timers or duplicate incidents;
- stale/cross-boot location is never represented as current;
- stationary tests do not create frequent false 50 m breadcrumbs;
- reboot never silently resolves an incident;
- process death loses no committed alert state;
- transport receipts cannot become human ACK;
- only a valid resolution action ends the active incident;
- residual Android/SystemUI/Device Owner/SMS artifacts are documented and accepted;
- delivery latency is measured statistically rather than promised as an absolute maximum.

---

# 22. Immediate Orders

Begin with **Milestone 0 only**.

Use one current supported Pixel on stock Android and at least two carrier/SIM configurations if available.

Implement Gates 0A–0E as throwaway spikes.

Do **not** spend time yet on polished UI, branding, plugin systems, audio/video, WhatsApp, GrapheneOS, Samsung support, custom AOSP or remote backend.

Return the Milestone-0 evidence and architecture go/no-go decision before proceeding to the incident kernel.

---

## Product Definition to Preserve

> **CovertAlertSystem turns an ordinary-looking application launch into one persistent, idempotent duress incident. Its first responsibility is to get a distress alert off-device, its second is to establish and report trustworthy location, and its third—only where safe and technically appropriate—is to preserve and transport evidence.**
