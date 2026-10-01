# Publish CAS on Replit (always-on deployment)

The no-server way to keep CAS running 24/7: publish this workspace as a
**Reserved VM** deployment on Replit itself. If you would rather run your own
VPS, use `SELF-HOSTING.md` instead — pick one, not both.

**What you end up with:** the operator console at `https://<your-app>.replit.app/`
and the API at `/api` on the same URL, always on (the outbox worker, mailbox
health probe, and handset pickup loop live inside the server process, which is
why this must be a Reserved VM — autoscale would freeze them between
requests), backed by its own production PostgreSQL database, separate from the
workspace's development data.

**Privacy comes from the credential gate, not the visibility toggle.** Leave
the deployment's visibility *public*: every endpoint except `/api/healthz`
requires an enrolled device credential, anonymous callers get 401, and a
browser that opens the URL sees only the enrollment prompt. Setting the
Replit deployment to "private" would also lock out the alerting phone unless
you wire external-access tokens into it — don't.

> **Read Step 1 before clicking publish.** Replit syncs workspace secrets
> into the published app automatically, and this workspace holds *live* SMTP
> credentials. Left synced, the very first deployment would email real
> responders on the next alert. Step 1 blanks them before they can fire.

Estimated time: 30 minutes, most of it waiting for the first build.

---

## Step 0 — Rehearse locally (optional but recommended)

```bash
pnpm --filter @workspace/scripts run rehearse:publish-readiness
```

Builds the exact production bundles, boots them against a throwaway database,
and proves the whole contract below (health check open, everything else 401
anonymous, enroll → read → revoke → locked, update endpoints 404 until the
first APK is published, dev sink absent, Canvas not deployed). Safe to run
anytime: the database is disposable and all provider/SMTP variables are
cleared inside the rehearsal.

## Step 1 — Quarantine live delivery secrets (before first publish)

Replit's deployment secrets **sync automatically from the development
environment** — the deployment starts with a copy of this workspace's
secrets, and deployment-secret entries then override individual keys. That
sync is the hazard: this workspace's `CAS_EMAIL_SMTP_*` secrets are a live
mailbox, so an unreviewed publish arms real email delivery.

In the **Publishing** tool, open **Adjust settings → Deployment secrets**
*before* clicking publish, and add an explicit override with an **empty
value** for each of these (a deployment-secret entry wins over the synced
development value, and an empty value reads as "not configured" to the
server, which then fails closed):

- `CAS_EMAIL_SMTP_HOST`, `CAS_EMAIL_SMTP_PORT`, `CAS_EMAIL_SMTP_USER`, `CAS_EMAIL_SMTP_PASSWORD`
- `CAS_EMAIL_PROVIDER_URL`, `CAS_EMAIL_PROVIDER_TOKEN`, `CAS_EMAIL_FROM`, `CAS_EMAIL_RECIPIENTS`
- `CAS_SMS_PROVIDER_URL`, `CAS_SMS_PROVIDER_TOKEN`, `CAS_SMS_RECIPIENTS`
- `CAS_XMPP_PROVIDER_URL`, `CAS_XMPP_PROVIDER_TOKEN`, `CAS_XMPP_RECIPIENTS`
- `CAS_WHATSAPP_PROVIDER_URL`, `CAS_WHATSAPP_PROVIDER_TOKEN`, `CAS_WHATSAPP_RECIPIENTS`
- `CAS_DEV_PROVIDER_SINK`, `CAS_TEST_DISPOSABLE_DB` — dev/test markers; they
  must never be active on a deployment. (The dev provider-inbox sink is not
  even mounted in production builds, and the test markers would force all
  delivery into the in-memory dev sink — alerts would go nowhere.)

While you are there, scan the synced list for any other `CAS_*` key you did
not set deliberately and blank it the same way.

## Step 2 — Set the required deployment secrets

Same pane (**Adjust settings → Deployment secrets**):

**Required:**

| Key | Value |
| --- | --- |
| `CAS_ALERT_TOKEN` | The enrollment credential — browsers and the phone exchange it for their own revocable credentials. Generate: `openssl rand -hex 32` |
| `CAS_DEVICE_TOKEN` | Shared secret for the handset pickup/receipt endpoints. Generate a *different* one: `openssl rand -hex 32` |
| `CAS_SMS_DELIVERY_MODE` | `device` — the alerting phone sends SMS from its own SIM (the MVP posture). Leave unset for gateway mode, but then alerts fail loudly as `not-configured` until you wire a provider. |
| `CAS_DEVICE_CHANNELS` | `SMS` |
| `DATABASE_URL` | Automatic from Step 3's production database — do not set by hand. |

**Already set by the artifact's production config — do not add:** `PORT`,
`NODE_ENV=production`.

**Recommended:**

| Key | Value |
| --- | --- |
| `CAS_TRUST_PROXY` | `true` — on Replit the only ingress is the platform router, so trusting `X-Forwarded-For` lets the anti-guessing tarpit keep each attacker's failure streak separate from your traffic. Unset, every visitor reads as the router's address and one attacker's guesses slow everyone. |
| `CAS_AUTH_BURST_ALERT_URL` | Optional — a healthchecks.io-style check ping URL that turns credential-guessing bursts into an email. Set it up as in Step 7, then paste the check's ping URL here and redeploy. |

**Only when you are ready to alert real responders:** replace the Step 1
blank overrides for `CAS_EMAIL_SMTP_*` (see "Optional: email alerts through a
dedicated mailbox" in `SELF-HOSTING.md`) or the `CAS_*_PROVIDER_*` variables
with real values. From that moment every test alert reaches the configured
responders for real.

## Step 3 — Publish as a Reserved VM, with a production database

`.replit` already pins `deploymentTarget = "vm"`, and the artifacts carry
their own production build/run config. In the **Publishing** tool, confirm
the deployment type shows **Reserved VM**. The router serves `/` from the
console's static build and `/api` from the API server (`NODE_ENV=production`).
The mockup Canvas (`/__mockup`) has no production service and is never
deployed.

In the same publish flow, turn on **Create production database**. Replit
provisions a managed PostgreSQL database for the deployment and injects
`DATABASE_URL` automatically. Decline "copy development data" — the
development database only holds test incidents, and the console seeds its own
readiness catalog on first load.

## Step 4 — Push the schema

The server boots fine before the schema exists (the rehearsal proves it), so
publish first, then push the schema into the still-empty database. Copy the
production connection string from the Database tool's production settings,
then from the workspace shell:

```bash
DATABASE_URL="<production connection string>" \
  pnpm --filter @workspace/db run push-force
```

`push-force` is safe **only against the brand-new, empty database** — it
auto-approves whatever the schema diff requires, including drops. No restart
is needed afterwards.

**Later schema changes, once the database holds real incidents:** take a
backup first (the Database tool's export, or `pg_dump` against the production
connection string), then run the *unforced* push so you review the plan:

```bash
DATABASE_URL="<production connection string>" \
  pnpm --filter @workspace/db run push
```

Read the printed diff and confirm nothing you care about is being dropped
before accepting. Never run `push-force` against a database that holds real
incident data.

## Step 5 — Post-publish smoke checks

```bash
# Health check is the one anonymous endpoint:
curl -s https://<your-app>.replit.app/api/healthz        # -> {"status":"ok"}
# Everything else rejects anonymous callers:
curl -s https://<your-app>.replit.app/api/cas/state      # -> 401
```

Then in a browser: open `https://<your-app>.replit.app/` — you should see only
the **Console locked** enrollment prompt. Paste the `CAS_ALERT_TOKEN` value;
the browser exchanges it for its own revocable credential and the console
loads. In the console's device list, revoke that browser's credential and
watch it lock again on its next read. With any enrolled credential,
`GET /api/cas/app-updates/manifest` answers 404 until you publish the first
kit APK.

Verify the Step 1 quarantine took effect before triggering anything: reopen
**Adjust settings → Deployment secrets** and confirm the delivery variables
are blanked. Then point the phone at `https://<your-app>.replit.app` exactly
as in Step 7 of `SELF-HOSTING.md` (server URL, `CAS_DEVICE_TOKEN` as the
device access token, `CAS_ALERT_TOKEN` as the alert credential). Note that in
`device` mode a test alert makes the phone send a *real* SMS to every
responder on the console's Responders page — that page starts empty, so add
only yourself for the first test.

## Step 6 — Get paged when the deployment stops answering

Nothing built into the deployment tells you when it goes down: a dead VM or a
failed redeploy means the phone's alerts queue into silence. The self-hosting
runbook solves this with a cron dead-man's-switch on the VPS (SELF-HOSTING.md
Step 9), but a Replit deployment has no cron — so use an **external HTTP
uptime monitor** instead (the free tier of UptimeRobot, Better Stack, or any
similar service; healthchecks.io itself only *receives* pings and cannot
poll, so for this check pick a monitor that polls).

1. Create a new **HTTP(s) monitor** pointed at
   `https://<your-app>.replit.app/api/healthz` — the one anonymous endpoint,
   so the monitor needs no credential and the credential gate stays intact.
2. Interval: every 5 minutes. Expect HTTP 200 (the body is
   `{"status":"ok"}` if the monitor supports a keyword check).
3. Set the alert target to an email address you actually read.

Because the monitor traverses the public URL, this catches the VM dying, the
server process crashing repeatedly, and TLS/DNS/router trouble — everything
except the monitor service itself. Prove the wiring with the monitor's
"send test notification" button; if you want a real red alert, pause the
deployment briefly and watch the email arrive, then resume it.

## Step 7 — Get paged when someone is guessing credentials

The server already slows repeated wrong-credential attempts from one IP and,
every 10th consecutive failure, writes one distinct log line
(`casAuthRejectionBurst`). On a VPS a cron watchdog scans the journal for
that line and pings a healthchecks.io check's `/fail` URL (SELF-HOSTING.md
Step 10). A Replit deployment has no journal or cron access — its logs are
only visible in the Replit UI — so the recipe is adapted: **the server pings
the check itself**, from inside the process that detects the burst. No new
infrastructure to run.

1. In your healthchecks.io account (free tier), create a **dedicated check**
   named e.g. `cas-auth-bursts` — do not reuse the Step 6 monitor; a burst
   must not look like downtime. Period 5 minutes, grace 5 minutes. Copy its
   ping URL (`https://hc-ping.com/<uuid>`).
2. Publishing → **Adjust settings → Deployment secrets** → add
   `CAS_AUTH_BURST_ALERT_URL` with that ping URL → redeploy.

From then on: a burst makes the server GET `<url>/fail`, which flips the
check down and emails you immediately; in quiet times the server pings the
plain URL every 5 minutes, which also flips the check back up after the
flood ends (success pings are suppressed for 10 minutes after a burst, so
the alert is not cleared mid-flood). If the server cannot reach the ping URL
it logs a warning and keeps running — the alert can never break alerting.

**Prove the alert fires (do this once, now):** from any machine, send wrong
credentials until the burst trips, then watch for the email:

```bash
for i in $(seq 1 11); do
  curl -s -o /dev/null https://<your-app>.replit.app/api/cas/state \
    -H "Authorization: Bearer wrong-on-purpose"
done
```

The server's own slowdown makes the 11 attempts take about 90 seconds (the
per-attempt delay doubles each failure — that is the anti-guessing defense
working, not a problem). Within a couple of minutes after the 10th failure
you should get the `cas-auth-bursts` email. The burst log line with the
guessor's IP is visible in the deployment's **Logs** pane; Step 2's
`CAS_TRUST_PROXY=true` keeps each attacker's streak separate from your own
traffic.

**Known gap versus the VPS recipe:** the self-hosting watchdog alerts even
when only log scanning is possible; here the alert depends on the server
process being alive to send it. A burst that crashes the server would be
caught by Step 6's uptime monitor instead — keep both checks.

## Rotating CAS_ALERT_TOKEN

Publishing → Adjust settings → Deployment secrets → replace the
`CAS_ALERT_TOKEN` value → redeploy (restarting the VM applies it). Enrolled
devices — the phone, every console browser — keep working: they hold their own
per-device credentials and never see the enrollment credential again. Only
*new* enrollments need the new value, and the old value stops authorizing the
moment the new deployment is live. To contain a lost phone or browser, revoke
just that one credential from the console's device list instead of rotating.

## If the publish fails

- **Startup probe failing:** check the deployment logs for a boot error; the
  probe path is `/api/healthz` and must answer 200. A missing schema does not
  block it — anything else (bad `CAS_SMS_DELIVERY_MODE` value, missing
  `DATABASE_URL`) aborts boot loudly by design.
- **401 on the phone's first alert:** the alert credential field holds
  something other than the current `CAS_ALERT_TOKEN` deployment secret.
- **Outbox rows stuck at `not-configured`:** expected until Step 2's optional
  provider variables get real values — deliveries fail loudly, never silently.
