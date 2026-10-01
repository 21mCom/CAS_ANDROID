import { execFileSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

// Proves the handset-sent SMS chip's destination hint end to end in a real
// browser: the console enrolls a credential, an incident is triggered with
// the server in device-direct mode (CAS_SMS_DELIVERY_MODE=device), the
// handset's all-ok SMS receipt transitions the outbox item to
// SENT / deliveredTo "handset-sim", and the /incidents chip's tooltip reads
// the handset/SIM message — not the generic "Delivered via handset-sim"
// gateway fallback and not empty. Two seeded gateway rows (dev-sink and
// provider-host) prove the gateway chip tooltips keep their own distinct
// wording alongside it. The credential is revoked afterwards.
//
// Environment is provided by scripts/run-console-browser-proof.mjs:
//   CAS_E2E_API_ORIGIN   — api-server origin (disposable DB, test credential)
//   CAS_E2E_ALERT_TOKEN  — the fixed, test-only enrollment credential
//   DATABASE_URL         — the disposable database, used ONLY to seed the two
//                          already-SENT gateway fixture rows (no API can
//                          fabricate a gateway acceptance; the SMS row itself
//                          is queued by the real trigger and transitioned by
//                          the real receipt endpoint).
// The incident lifecycle is real: the trigger endpoint queues the SMS outbox
// item and the device-receipt endpoint marks it SENT — exactly the route
// behavior the route tests cover, here asserted through the rendered chip.
//
// Ordering: this spec resolves whatever incident is still active when it
// starts (the harness-seeded one the mid-session-lock proof leaves behind),
// so it must sort after console-mid-session-lock.spec.ts — the suite is
// single-worker and runs spec files alphabetically by design.

const API_ORIGIN = process.env.CAS_E2E_API_ORIGIN;
const ALERT_TOKEN = process.env.CAS_E2E_ALERT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const HANDSET_SIM_TITLE =
  'Sent by the phone itself, over its own SIM — no gateway involved.';
const GENERIC_HANDSET_FALLBACK = 'Delivered via handset-sim';
const DEV_SINK_TITLE =
  'Accepted by the built-in test inbox — simulated delivery: no real provider was contacted and no responder received anything.';
const PROVIDER_HOST = 'xmpp:e2e-provider.example.invalid';

test.beforeEach(() => {
  if (!API_ORIGIN || !ALERT_TOKEN || !DATABASE_URL) {
    throw new Error(
      'CAS_E2E_API_ORIGIN, CAS_E2E_ALERT_TOKEN, and DATABASE_URL must be set — run via scripts/run-console-browser-proof.mjs.',
    );
  }
});

test('a handset-sent SMS chip names the handset SIM, not the generic gateway fallback', async ({ page, request }) => {
  // Enroll a throwaway device credential exactly the way an operator console
  // would, but through the API so the test needs no interactive prompt.
  const enroll = await request.post(`${API_ORIGIN}/api/cas/devices/enroll`, {
    headers: { authorization: `Bearer ${ALERT_TOKEN}`, 'content-type': 'application/json' },
    data: { label: 'e2e-handset-sim-chip-proof' },
  });
  expect(enroll.status()).toBe(201);
  const { device, token } = (await enroll.json()) as { device: { id: string }; token: string };
  const deviceHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  let incidentId: string | null = null;
  try {
    // Clear whatever incident a previous proof left active (the harness seeds
    // one for the mid-session-lock spec): a trigger folds into an active
    // incident instead of queueing outbox items, and this proof needs the
    // real trigger to queue the SMS row it then receipts.
    const state = await request.get(`${API_ORIGIN}/api/cas/state`, { headers: deviceHeaders });
    expect(state.ok()).toBeTruthy();
    const { activeIncident } = (await state.json()) as { activeIncident: { id: string; status: string } | null };
    if (activeIncident && activeIncident.status === 'ACTIVE_UNACKED') {
      const ack = await request.post(`${API_ORIGIN}/api/cas/incidents/${activeIncident.id}/ack`, { headers: deviceHeaders });
      expect(ack.ok()).toBeTruthy();
    }
    if (activeIncident && activeIncident.status !== 'RESOLVED') {
      const resolve = await request.post(`${API_ORIGIN}/api/cas/incidents/${activeIncident.id}/resolve`, { headers: deviceHeaders });
      expect(resolve.ok()).toBeTruthy();
    }

    // Trigger a fresh incident in device-direct mode. With no console mailbox
    // saved and every gateway provider variable cleared by the harness, SMS
    // is the only deliverable channel, so exactly one QUEUED SMS outbox row
    // is created — and in device mode the outbox worker must never claim it.
    const trigger = await request.post(`${API_ORIGIN}/api/cas/incidents/trigger`, {
      headers: deviceHeaders,
      data: {},
    });
    expect(trigger.status()).toBe(201);
    const triggered = (await trigger.json()) as { id: string; reused: boolean };
    expect(triggered.reused).toBe(false);
    incidentId = triggered.id;

    // Gateway regression fixtures: two already-SENT rows for the same
    // incident, one accepted by the dev sink and one by a named provider
    // host. No API can record a gateway acceptance, so these are seeded
    // directly — their only job is to prove the pre-existing tooltips did
    // not drift while the handset branch was added.
    execFileSync('psql', [
      DATABASE_URL!,
      '-v', 'ON_ERROR_STOP=1',
      '-c',
      `INSERT INTO cas_outbox (id, incident_id, transport, state, priority, attempts, sent_at, delivered_to, created_at) VALUES ` +
      `('${incidentId}-email', '${incidentId}', 'EMAIL', 'SENT', 'P1', 1, now(), 'dev-sink', now()), ` +
      `('${incidentId}-xmpp', '${incidentId}', 'XMPP', 'SENT', 'P1', 1, now(), '${PROVIDER_HOST}', now())`,
    ]);

    // The handset's all-ok receipt is the state transition: QUEUED -> SENT
    // with deliveredTo "handset-sim" (the handset sent over its own SIM, so
    // there is no gateway endpoint to name).
    const receipt = await request.post(`${API_ORIGIN}/api/cas/incidents/${incidentId}/device-receipt`, {
      headers: deviceHeaders,
      data: { channel: 'SMS', results: [{ recipient: '+15550001111', ok: true }] },
    });
    expect(receipt.status()).toBe(200);
    expect(((await receipt.json()) as { state: string }).state).toBe('SENT');

    // Seed the credential the way the app's own enrollment flow stores it,
    // then load the incidents console — every read is credential-gated.
    await page.addInitScript((deviceToken) => {
      sessionStorage.setItem('cas-device-token', deviceToken);
    }, token);
    await page.goto('/incidents');

    // The SMS chip's tooltip names the handset's own SIM. The exact-text
    // assertion subsumes "not empty" and "not the generic fallback", but
    // both failure modes regressed silently before, so assert them
    // explicitly to keep this proof's intent obvious.
    const smsChip = page.getByTestId(`chip-outbox-${incidentId}-sms`);
    await expect(smsChip).toBeVisible();
    await expect(smsChip).toHaveText('SMS · Sent');
    await expect(smsChip).toHaveAttribute('title', HANDSET_SIM_TITLE);
    const smsTitle = await smsChip.getAttribute('title');
    expect(smsTitle).not.toBeNull();
    expect(smsTitle).not.toBe('');
    expect(smsTitle).not.toBe(GENERIC_HANDSET_FALLBACK);

    // The gateway chips keep their own distinct wording: the dev-sink chip
    // must say nothing was really sent, the provider chip names the gateway.
    const emailChip = page.getByTestId(`chip-outbox-${incidentId}-email`);
    await expect(emailChip).toHaveText('EMAIL · Test only — nothing was really sent');
    await expect(emailChip).toHaveAttribute('title', DEV_SINK_TITLE);
    const xmppChip = page.getByTestId(`chip-outbox-${incidentId}-xmpp`);
    await expect(xmppChip).toHaveText('XMPP · Sent');
    await expect(xmppChip).toHaveAttribute('title', `Delivered via ${PROVIDER_HOST}`);
  } finally {
    // Leave no live state behind: settle the incident, then revoke the
    // credential so the dev DB does not accumulate live credentials.
    if (incidentId) {
      await request.post(`${API_ORIGIN}/api/cas/incidents/${incidentId}/ack`, { headers: deviceHeaders }).catch(() => {});
      await request.post(`${API_ORIGIN}/api/cas/incidents/${incidentId}/resolve`, { headers: deviceHeaders }).catch(() => {});
    }
    const revoke = await request.post(`${API_ORIGIN}/api/cas/devices/${device.id}/revoke`, {
      headers: { authorization: `Bearer ${ALERT_TOKEN}` },
    });
    expect(revoke.ok()).toBeTruthy();
  }
});
