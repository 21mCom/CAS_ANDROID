---
name: CAS console read posture
description: Console GET endpoints must stay anonymous like /cas/state; only mutations are credentialed, or pages break with 401.
---

In the CAS console, every read endpoint is anonymous (matching `/cas/state`); only mutations carry the Bearer credential through `casAuthedFetch`. A new endpoint that auth-gates a GET breaks the page that loads it — the page's plain `fetch` gets 401 and the section fails silently (visible only as a browser-console 401).

**Why:** the evidence-policy GET initially required the device token or Bearer credential; the capture settings page loaded blank until the read was made anonymous (device-token requests are still validated when the header is present, keeping the handset path fail-closed).

**How to apply:** when adding a console-facing GET, keep reads anonymous and gate only writes; when adding a handset-facing GET, keep the device-token gate. After wiring a new console page, screenshot it and check the browser log for 401s.
