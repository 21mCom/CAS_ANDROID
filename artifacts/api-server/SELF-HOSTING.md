# CAS Backend — Self-Hosting Runbook

This guide takes a fresh Linux box (any always-on machine or cheap VPS running
Debian 12+ / Ubuntu 22.04+) to a running CAS backend with HTTPS, auto-restart,
backups, and an uptime alert. Every step is copy-pasteable; nothing here
requires prior server experience beyond editing a file with `nano`.

Estimated time: one afternoon.

**What you end up with:** the CAS API server running as a system service on
your own box, the operator console served from your own domain over HTTPS,
nightly database backups, and two alerts: one if the server dies, one if
someone starts guessing credentials.

**What you need before starting:**
- A Linux box that stays on (a $5/month VPS is fine; 1 GB RAM is enough).
- A domain name you control, e.g. `cas.example.org` — you will point it at
  the box in Step 6.
- About 15 minutes of DNS patience while certificates are issued.

---

## Step 1 — Install the basics

Run everything in this section as a user with sudo rights.

```bash
sudo apt update
sudo apt install -y git curl postgresql caddy ufw

# Node.js 22 (LTS) from NodeSource — the server needs Node 22 or newer.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm is the package manager this repository uses; corepack ships with Node.
sudo corepack enable
corepack prepare pnpm@10.26.1 --activate
```

## Step 2 — Get the code

```bash
sudo mkdir -p /opt/cas
sudo chown "$USER":"$USER" /opt/cas
cd /opt/cas
git clone <your-repo-url> repo        # the private GitHub repo holding this code
cd repo
pnpm install --frozen-lockfile
```

## Step 3 — Create the database

The backend stores everything (incidents, outbox, enrolled devices) in
PostgreSQL, which you installed in Step 1.

```bash
# A database login just for CAS, with a random password.
CAS_DB_PASSWORD=$(openssl rand -hex 24)
echo "Save this password: $CAS_DB_PASSWORD"   # you paste it into the env file in Step 4
sudo -u postgres psql -c "CREATE ROLE cas LOGIN PASSWORD '$CAS_DB_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE cas OWNER cas;"
```

Your database URL is then:

```
postgresql://cas:<the-password-above>@127.0.0.1:5432/cas
```

Create the tables (safe to re-run; it only applies what's missing):

```bash
cd /opt/cas/repo
DATABASE_URL="postgresql://cas:<password>@127.0.0.1:5432/cas" \
  pnpm --filter @workspace/db run push-force
```

## Step 4 — Configure environment variables

First create the unprivileged user the service will run as, then put every
setting in one file readable by that user and by you (via group membership):

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin cas
sudo mkdir -p /etc/cas
sudoedit /etc/cas/cas.env     # or: sudo nano /etc/cas/cas.env
sudo chown root:cas /etc/cas/cas.env
sudo chmod 640 /etc/cas/cas.env
sudo usermod -aG cas "$USER"   # log out and back in once for this to apply
```

Paste this in and fill in the marked values:

```ini
# --- Required -------------------------------------------------------------

# Port the API listens on. Only Caddy talks to it; it never faces the internet.
PORT=8080

# Loopback-only binding: the API answers only this box itself (Caddy proxies
# to it), so there is no direct public access to port 8080 even before the
# firewall in Step 6 is configured. Omit this only on platforms (like the
# Replit dev workspace) whose proxy is not local.
HOST=127.0.0.1

# Tells Express the API sits behind a proxy, so it reads the real visitor IP
# from X-Forwarded-For instead of seeing every request as Caddy's. Required
# for the anti-guessing tarpit to keep each attacker's failure streak
# separate from your legitimate traffic. "loopback" is right for Caddy on
# the same box; if the proxy runs elsewhere use its IP/CIDR instead. Leave
# UNSET only when the API faces the internet directly — then clients could
# spoof X-Forwarded-For to dodge the tarpit.
CAS_TRUST_PROXY=loopback

# Marks this as a production deployment (turns off dev-only helpers).
NODE_ENV=production

# From Step 3.
DATABASE_URL=postgresql://cas:CHANGE_ME@127.0.0.1:5432/cas

# The ENROLLMENT credential. Think of it as the master key: it is only used to
# enroll devices (the phone, each operator console browser). Day-to-day
# actions use per-device credentials that you can revoke individually.
# Generate one: openssl rand -hex 32
CAS_ALERT_TOKEN=CHANGE_ME

# --- Handset delivery (recommended for the MVP) ----------------------------

# "device" = the alerting phone sends SMS itself from its own SIM and reports
# the outcome back. No third-party SMS account needed.
CAS_SMS_DELIVERY_MODE=device
CAS_DEVICE_CHANNELS=SMS

# Shared secret the handset presents to pick up re-queued sends and post
# receipts. Without it the handset endpoints stay closed (503) by design.
# Generate one: openssl rand -hex 32
CAS_DEVICE_TOKEN=CHANGE_ME

# --- Optional: instant capture-request wake (push) ---------------------------
# Responder-requested evidence capture is normally honored when the phone next
# contacts the server (up to minutes during a live incident, and Android may
# deny the mic/camera background start while idle). With a Firebase service
# account configured here, creating a capture request also sends a
# high-priority push that wakes the phone immediately under the documented
# background-start exemption; the incident journal records which path honored
# each request, and polling stays as the fallback whenever push is
# unconfigured or fails. Without these variables nothing changes.
# Create a Firebase project, add the Android app (package
# com.covertalert.pixeltest), and create a service-account key (IAM → Service
# accounts → Keys). The handset side needs the matching google-services.json
# at field-build time — see the test package's HANDOFF-TEST-KIT.md.
# CAS_FCM_SERVICE_ACCOUNT_FILE=/etc/cas/fcm-service-account.json   (recommended)
# CAS_FCM_SERVICE_ACCOUNT_JSON={"type":"service_account",...}      (inline alternative)

# --- Optional: server-side delivery channels --------------------------------
# Only set a channel if you want the server (not the phone) to deliver it.
# CAS_SMS_PROVIDER_URL=        (only when CAS_SMS_DELIVERY_MODE=gateway)
# CAS_SMS_PROVIDER_TOKEN=
# CAS_XMPP_PROVIDER_URL= / CAS_XMPP_PROVIDER_TOKEN= / CAS_XMPP_FROM_JID=
# CAS_WHATSAPP_PROVIDER_URL= / CAS_WHATSAPP_PROVIDER_TOKEN=
#   (full Cloud API messages URL, e.g. https://graph.facebook.com/v22.0/<phone-number-id>/messages)
#
# EMAIL — pick ONE of the two paths (setting both aborts boot with a clear
# error rather than silently picking one):
#   a) Direct SMTP through a dedicated mailbox — the simplest option; see
#      "Optional: email alerts through a dedicated mailbox" below for the
#      10-minute Gmail app-password setup. TLS is mandatory.
# CAS_EMAIL_SMTP_HOST=smtp.gmail.com
# CAS_EMAIL_SMTP_PORT=465            (default; 587 also works via STARTTLS)
# CAS_EMAIL_SMTP_USER=               (the mailbox address)
# CAS_EMAIL_SMTP_PASSWORD=           (the app password, not the login password)
#   b) An HTTPS mail-submission API (Resend-style):
# CAS_EMAIL_PROVIDER_URL= / CAS_EMAIL_PROVIDER_TOKEN= / CAS_EMAIL_FROM=
# Recipients for every channel are managed in the console's Responders page;
# the CAS_*_RECIPIENTS lists are only the first-run seed/fallback.
```

Rules worth knowing (the server enforces them loudly at boot or first use):
- `CAS_ALERT_TOKEN` unset → no new devices can enroll; everything fails closed.
- Provider URLs must be HTTPS — plain HTTP is refused so credentials and alert
  content never travel cleartext.
- Unknown `CAS_SMS_DELIVERY_MODE` / `CAS_DEVICE_CHANNELS` values abort boot
  instead of silently guessing a delivery behavior.
- SMTP is TLS-only: port 465 encrypts from connect, any other port requires
  the server to offer STARTTLS, and the certificate must verify. A mail
  server that cannot do this fails the delivery loudly (visible in the
  console's outbox status) — credentials never cross a cleartext connection.

### Optional: email alerts through a dedicated mailbox (SMTP)

The simplest way to activate the email channel: a free dedicated Gmail
account that exists only to send alerts. Google carries the sender
reputation, so no mail server or provider account to run. About 10 minutes:

1. **Create a dedicated Gmail account**, e.g. `cas-alerts-<yours>@gmail.com`.
   Do not reuse a personal account — this mailbox's only job is sending
   alerts, which keeps the app password's blast radius small and makes the
   sender address obvious in a responder's inbox.
2. **Turn on 2-Step Verification** for it (myaccount.google.com → Security).
   Google requires this before it will issue app passwords.
3. **Create an app password** (myaccount.google.com/apppasswords), name it
   e.g. `cas-server`, and copy the 16-character password. This is the value
   of `CAS_EMAIL_SMTP_PASSWORD` — not the account's login password.
4. Set the env block from Step 4 (`CAS_EMAIL_SMTP_HOST=smtp.gmail.com`,
   user = the mailbox address, password = the app password) and restart the
   service: `sudo systemctl restart cas-api`.
5. **Tell every responder to add the mailbox address to their contacts.** A
   brand-new low-volume sender has no reputation history, and an alert that
   lands in spam is an alert nobody sees; a contact entry is the reliable
   mitigation on every mainstream mail provider.

**Console alternative (no restart needed):** instead of setting the env
block, open the console's **Email delivery** page and save the same values
as the *primary mailbox* — host, port, login, and the app password. The
password is write-only: the console never displays it after saving. Console
settings take precedence over the env block while a primary account exists
(removing it hands the channel back to the environment), and the page also
holds an optional **fallback mailbox** for redundancy: when the primary
refuses or cannot reach a recipient, that recipient is tried once through
the fallback — never duplicated. The page's **Test connection** button
verifies TLS and credentials without sending mail. Note that in this mode
the app password lives in the server database, so anyone with database
access can read it — the same exposure as the env file on the host.

Verify it end to end: add your own address on the console's **Responders**
page, trigger a test alert from the phone, and watch the incident's outbox
row reach `SENT` (console → incident detail). A misconfigured mailbox shows
up there as a named, journaled failure — e.g. `authentication` means the
app password is wrong or revoked, `not-configured` means host set without
user/password. Retries are automatic with backoff; a permanently refused
message dead-letters instead of looping forever.

What `SENT` means for email: the mailbox's SMTP server accepted the message
for that responder. The final hop into the responder's inbox is their
provider's spam filtering — which is exactly what the contact-list step
above covers. Other mailbox providers work too (any submission host with
TLS + AUTH PLAIN); if yours uses an internal certificate authority, point
`CAS_EMAIL_SMTP_CA_FILE` at its PEM bundle.

## Step 5 — Build, install the service, and first start (auto-restart on crash and reboot)

```bash
cd /opt/cas/repo
pnpm --filter @workspace/api-server run build

sudo tee /etc/systemd/system/cas-api.service > /dev/null <<'EOF'
[Unit]
Description=CAS alert backend
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/cas/repo
EnvironmentFile=/etc/cas/cas.env
ExecStart=/usr/bin/node artifacts/api-server/dist/index.mjs
Restart=always
RestartSec=3
# Run as the unprivileged user created in Step 4, not root.
User=cas
Group=cas
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

sudo chown -R cas:cas /opt/cas/repo
sudo systemctl daemon-reload
sudo systemctl enable --now cas-api
systemctl status cas-api --no-pager     # should say active (running)
```

`Restart=always` means the server comes back after a crash and after every
reboot — no manual intervention. Logs: `journalctl -u cas-api -f`.

Verify the first start (from the box itself; the API is loopback-only):

```bash
curl -s http://127.0.0.1:8080/api/healthz        # -> {"status":"ok"}
curl -s http://127.0.0.1:8080/api/cas/state      # -> 401 (reads need a device credential)
```

## Step 6 — Domain and HTTPS

1. Lock the box down **before** anything public attaches to it. (The API is
   already loopback-only via `HOST=127.0.0.1` in Step 4, so port 8080 is
   never reachable from outside; this default-deny firewall is the second
   layer and protects every future service on the box.)

   ```bash
   sudo ufw default deny incoming
   sudo ufw allow OpenSSH
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

2. In your domain's DNS settings, add an **A record** pointing
   `cas.example.org` at the box's public IP, and wait a few minutes.
3. Tell Caddy to serve your domain and forward API calls to the backend.
   Caddy obtains and renews the HTTPS certificate automatically.

   ```bash
   sudo nano /etc/caddy/Caddyfile
   ```

   Replace the contents with (substituting your domain):

   ```
   cas.example.org {
       # The API under /api — a mutually exclusive handle block, so API
       # requests are always proxied and never touch the SPA fallback below.
       handle /api/* {
           reverse_proxy 127.0.0.1:8080
       }

       # The operator console (static build) at / ...
       handle {
           root * /opt/cas/repo/artifacts/covert-alert-system/dist/public
           try_files {path} /index.html
           file_server
       }
   }
   ```

   Keep the two `handle` blocks exactly in this shape: `handle` blocks are
   mutually exclusive, which is what stops the console's `try_files` fallback
   from rewriting `/api/*` requests to `index.html` before the proxy sees
   them.

4. Build the console and reload Caddy:

   ```bash
   cd /opt/cas/repo
   pnpm --filter @workspace/covert-alert-system run build
   sudo systemctl reload caddy
   ```

5. Verify from any machine: `curl -s https://cas.example.org/api/healthz`
   returns `{"status":"ok"}` over HTTPS, and opening
   `https://cas.example.org/` in a browser shows the console.

## Step 7 — The phone enrolls itself, then prove it can call home

The handset provisions itself: on its first alert it exchanges the enrollment
credential for its own revocable device credential (shown as
`handset-<model>` in the device list), caches it in device-protected storage,
and **discards the enrollment credential** — a lost phone is then contained
by revoking that one credential, and the phone can never re-enroll itself:

```bash
# List devices, then revoke by id — effective from the phone's next request:
curl -s https://cas.example.org/api/cas/devices \
  -H "Authorization: Bearer <CAS_ALERT_TOKEN>"
curl -s -X POST https://cas.example.org/api/cas/devices/<device-id>/revoke \
  -H "Authorization: Bearer <CAS_ALERT_TOKEN>"
```

On the phone (see the MVP handoff guide in
`artifacts/covert-alert-system/android-test-package/MVP-HANDOFF-WINDOWS.md`):
enter `https://cas.example.org` as the alert server URL, the `CAS_DEVICE_TOKEN`
value as the device access token, and the `CAS_ALERT_TOKEN` value as the
alert credential — the alert credential field takes the **enrollment**
credential, not a pre-issued `casdev_...` token; the phone uses it once, for
its own enrollment, on the first alert, then erases it. Send a test alert.

**Final verification — the phone called home over HTTPS.** From any machine,
enroll a throwaway verification device and read state with it:

```bash
TOKEN=$(curl -s -X POST https://cas.example.org/api/cas/devices/enroll \
  -H "Authorization: Bearer <CAS_ALERT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"label": "ops-verification"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
curl -s https://cas.example.org/api/cas/state -H "Authorization: Bearer $TOKEN"
# -> the phone's incident appears in the durable journal.
```

If the phone shows a 401 on its first alert, the alert credential field holds
something other than the current `CAS_ALERT_TOKEN` — re-check Step 7. A
timeout means DNS, the firewall, or Caddy; work back through Step 6. Revoke
the `ops-verification` device when done (commands above).

## Step 8 — Nightly database backups

```bash
sudo mkdir -p /var/backups/cas
sudo tee /usr/local/sbin/cas-backup.sh > /dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
stamp=$(date +%Y%m%d-%H%M%S)
sudo -u postgres pg_dump cas | gzip > "/var/backups/cas/cas-$stamp.sql.gz"
# Keep the last 14 days.
find /var/backups/cas -name 'cas-*.sql.gz' -mtime +14 -delete
EOF
sudo chmod +x /usr/local/sbin/cas-backup.sh

# Run it nightly at 03:17:
echo '17 3 * * * root /usr/local/sbin/cas-backup.sh' | sudo tee /etc/cron.d/cas-backup

# Prove it works once, now:
sudo /usr/local/sbin/cas-backup.sh && ls -la /var/backups/cas
```

A backup on the same disk doesn't survive losing the box. Copy the folder
somewhere else — e.g. `rsync -a /var/backups/cas/ you@othermachine:cas-backups/`
— on any schedule you're comfortable with.

**Restore drill (do this once so you trust it):**

```bash
sudo -u postgres psql -c 'CREATE DATABASE cas_restore_test OWNER cas;'
zcat /var/backups/cas/cas-<latest>.sql.gz | sudo -u postgres psql cas_restore_test
sudo -u postgres psql -c 'DROP DATABASE cas_restore_test;'
```

## Step 9 — Dead-simple uptime alerting

Use a "dead man's switch" service (free tier of healthchecks.io or similar):
you get a unique ping URL, and the service emails you when pings stop.

```bash
# Every 5 minutes: check the API, and only ping if it's healthy.
echo '*/5 * * * * root curl -fsS -m 10 https://cas.example.org/api/healthz > /dev/null && curl -fsS -m 10 https://hc-ping.com/YOUR-UUID > /dev/null' \
  | sudo tee /etc/cron.d/cas-uptime
```

Because the ping only fires while the server answers over HTTPS, this catches
the server crashing, the box dying, DNS/certificate trouble, and lost internet
— all with zero software to run yourself.

## Step 10 — Alert when someone is guessing credentials

The server already slows down repeated wrong-credential attempts from one IP,
and every 10th consecutive failure it writes one distinct log line:

```
{"level":40,"time":...,"casAuthRejectionBurst":{"ip":"...","failures":10,...},"msg":"CAS credential rejection burst detected"}
```

This step turns that line into an email, reusing the same dead-man's-switch
service as Step 9 — still zero software to run yourself.

1. In your healthchecks.io account, create a **second, separate check** named
   e.g. `cas-auth-bursts` (do not reuse the Step 9 check — a burst must not
   look like downtime). Give it a period of 5 minutes with a 5-minute grace
   and copy its ping URL (`https://hc-ping.com/SECOND-UUID`).

2. Install a once-a-minute watchdog that scans the service journal for the
   burst line. On a burst it pings the check's `/fail` URL (immediate "down"
   email); when the journal is clean it pings normally, which also flips the
   check back to "up" after an incident:

   ```bash
   sudo tee /usr/local/sbin/cas-burst-watch.sh > /dev/null <<'EOF'
   #!/bin/bash
   # Alert on CAS credential-guessing bursts via a healthchecks.io check.
   set -uo pipefail
   PING_URL="https://hc-ping.com/SECOND-UUID"   # <- paste your second check's URL

   # Read the journal fully into memory BEFORE matching. Piping journalctl
   # straight into `grep -q` lets grep exit on the first match and cut
   # journalctl off mid-write; under `set -o pipefail` that truncated read
   # would be misread as "no burst" — a false all-clear during the exact
   # high-volume flood this alert exists for.
   # A failed journal read also alerts (never reports clean).
   if ! recent=$(journalctl -u cas-api -o cat --since "-90 seconds" 2>/dev/null); then
     curl -fsS -m 10 "$PING_URL/fail" > /dev/null
     exit 0
   fi

   if grep 'casAuthRejectionBurst' <<< "$recent" > /dev/null; then
     curl -fsS -m 10 "$PING_URL/fail" > /dev/null
   else
     curl -fsS -m 10 "$PING_URL" > /dev/null
   fi
   EOF
   sudo chmod +x /usr/local/sbin/cas-burst-watch.sh
   echo '* * * * * root /usr/local/sbin/cas-burst-watch.sh' | sudo tee /etc/cron.d/cas-burst-watch
   ```

   Why `--since "-90 seconds"` on a once-a-minute cron: a little overlap costs
   nothing (re-pinging `/fail` while already down sends no extra email), but a
   gap would silently miss a burst that landed between runs.

**Prove the alert fires (do this once, now):** from any machine, send wrong
credentials until the burst trips, then watch for the email:

```bash
for i in $(seq 1 11); do
  curl -s -o /dev/null https://cas.example.org/api/cas/state \
    -H "Authorization: Bearer wrong-on-purpose"
done
```

The server's own slowdown makes the 11 attempts take about 90 seconds
(the per-attempt delay doubles each failure — that is the anti-guessing
defense working, not a problem). Within a couple of minutes after the 10th
failure you should get the `cas-auth-bursts` email. You can also confirm the
line itself on the box:

```bash
journalctl -u cas-api -o cat --since "-10 min" | grep casAuthRejectionBurst
```

The line records the source IP of the guesser. Because Step 4 sets
`CAS_TRUST_PROXY=loopback`, the API reads the real visitor address that
Caddy forwards instead of seeing every request as `127.0.0.1` — so one
attacker's slowdown streak never pools with (or dilutes) your legitimate
console and phone traffic. If the recorded IP shows `127.0.0.1`, check that
`CAS_TRUST_PROXY` is set in `/etc/cas/cas.env`; if you ever expose the API
directly without a proxy, unset it, or clients could spoof X-Forwarded-For
to dodge the tarpit.

## Updating to a new version later

```bash
cd /opt/cas/repo
git pull
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/covert-alert-system run build
set -a; source /etc/cas/cas.env; set +a   # readable because Step 4 put you in the cas group
pnpm --filter @workspace/db run push-force   # applies any new tables/columns
sudo systemctl restart cas-api
sudo systemctl reload caddy
curl -s https://cas.example.org/api/healthz   # confirm it's back
```

## Troubleshooting

| Symptom | Where to look |
| --- | --- |
| `systemctl status cas-api` not running | `journalctl -u cas-api -n 100 --no-pager` — usually a missing/typo'd env var in `/etc/cas/cas.env` |
| `DATABASE_URL must be set` at boot | The env file wasn't loaded; check `EnvironmentFile=` path and that the file exists |
| Phone gets 401 on trigger | Credential revoked, mistyped, or never enrolled — re-do Step 7 |
| Phone gets 503 on receipt/pickup | `CAS_DEVICE_TOKEN` unset in the env file; handset endpoints stay closed by design |
| Console loads but shows nothing | First load prompts for the enrollment credential (`CAS_ALERT_TOKEN`) to enroll that browser — enter it once per browser |
| HTTPS certificate errors | DNS A record not pointing at the box yet, or ports 80/443 blocked (`sudo ufw status`) |
| Outbox items stuck QUEUED | Console → outbox status shows why; for device mode, the phone needs data to report receipts |
