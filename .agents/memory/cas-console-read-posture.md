---
name: CAS console read posture
description: Console GET endpoints are credentialed like mutations; anonymous console reads were retired when the backend was packaged for self-hosting.
---

Every console-facing read endpoint that exposes incident state or security posture requires an enrolled-device Bearer credential, same as mutations. Only the health check stays anonymous (uptime monitoring), and handset endpoints keep their own device-credential gates — the handset already presents its enrolled credential on policy reads and falls back to its cached policy when rejected.

**Why:** the self-hosted backend has a public URL; anonymous reads let anyone watch incidents, locations, and responder activity in real time. The earlier "anonymous reads" posture (born when a blank settings page was "fixed" by ungating its GET) only ever made sense behind an unlisted dev URL.

**How to apply:** new console-facing GETs go behind the same credential gate as mutations, and the console attaches its stored credential instead of a bare fetch. After wiring a new console page, screenshot it and check the browser log for unexpected 401s — a 401 there now means a missing credential flow, never a reason to ungate the endpoint.
