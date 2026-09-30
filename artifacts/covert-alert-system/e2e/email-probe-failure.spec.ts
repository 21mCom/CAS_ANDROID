import { expect, test } from '@playwright/test';

// Proves the Email delivery page's mailbox-probe health line end to end in a
// real browser: the console enrolls a credential, a primary mailbox with a
// bad app password is saved, the server's scheduled probe fails the AUTH
// against the harness's fake SMTP server, and the credential-gated outbox
// poll renders the red "Last automatic login check: failed (authentication)"
// line on /email. The credential is revoked afterwards.
//
// Environment is provided by scripts/run-console-browser-proof.mjs:
//   CAS_E2E_API_ORIGIN   — api-server origin (disposable DB, test credential,
//                          fast probe cadence, CAS_EMAIL_* secrets cleared)
//   CAS_E2E_ALERT_TOKEN  — the fixed, test-only enrollment credential
//   CAS_E2E_SMTP_PORT    — the harness's fake SMTP server: STARTTLS with a
//                          throwaway cert, always refuses AUTH with 535
// The fake server speaks just enough SMTP for the probe (connect, STARTTLS,
// EHLO, AUTH, QUIT); no message can ever be sent through it.

const API_ORIGIN = process.env.CAS_E2E_API_ORIGIN;
const ALERT_TOKEN = process.env.CAS_E2E_ALERT_TOKEN;
const SMTP_PORT = process.env.CAS_E2E_SMTP_PORT;

test.beforeEach(() => {
  if (!API_ORIGIN || !ALERT_TOKEN || !SMTP_PORT) {
    throw new Error(
      'CAS_E2E_API_ORIGIN, CAS_E2E_ALERT_TOKEN, and CAS_E2E_SMTP_PORT must be set — run via scripts/run-console-browser-proof.mjs.',
    );
  }
});

test('a mailbox with a bad app password shows the failed login check on /email', async ({ page, request }) => {
  // Enroll a throwaway device credential exactly the way an operator console
  // would, but through the API so the test needs no interactive prompt.
  const enroll = await request.post(`${API_ORIGIN}/api/cas/devices/enroll`, {
    headers: { authorization: `Bearer ${ALERT_TOKEN}`, 'content-type': 'application/json' },
    data: { label: 'e2e-email-probe-proof' },
  });
  expect(enroll.status()).toBe(201);
  const { device, token } = (await enroll.json()) as { device: { id: string }; token: string };
  const deviceHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  try {
    // Save a primary mailbox whose app password the fake SMTP server always
    // refuses. The next scheduled probe tick (the harness runs it on a fast
    // cadence) authenticates against it and records a failed outcome.
    const save = await request.put(`${API_ORIGIN}/api/cas/config/email-accounts/primary`, {
      headers: deviceHeaders,
      data: {
        host: '127.0.0.1',
        port: Number(SMTP_PORT),
        user: 'e2e-probe@example.invalid',
        password: 'e2e-definitely-wrong-app-password',
        fromAddress: 'e2e-probe@example.invalid',
      },
    });
    expect(save.ok()).toBeTruthy();

    // Seed the credential the way the app's own enrollment flow stores it.
    await page.addInitScript((deviceToken) => {
      sessionStorage.setItem('cas-device-token', deviceToken);
    }, token);

    await page.goto('/email');

    // The page's own outbox poll (12s cadence) must pick up the probe
    // outcome, so leave room for probe tick + poll + backoff jitter.
    const line = page.getByTestId('email-probe-health');
    await expect(line).toHaveAttribute('data-state', 'failed', { timeout: 120_000 });
    // An AUTH refusal is a permanent classification — the line must render
    // red, not the amber "may clear on the next probe" variant.
    await expect(line).toHaveAttribute('data-permanent', 'true');
    await expect(line).toContainText('Last automatic login check of the mailbox saved on this page');
    await expect(line).toContainText('failed (authentication)');
    await expect(line).toContainText('Email alerts will not go out until the mailbox is fixed');
    await expect(page.getByTestId('email-probe-health-detail')).toContainText('login check failed');
  } finally {
    // Leave no live state behind: drop the bad mailbox row, then revoke the
    // credential so the dev DB does not accumulate live credentials.
    await request.delete(`${API_ORIGIN}/api/cas/config/email-accounts/primary`, { headers: deviceHeaders });
    const revoke = await request.post(`${API_ORIGIN}/api/cas/devices/${device.id}/revoke`, {
      headers: { authorization: `Bearer ${ALERT_TOKEN}` },
    });
    expect(revoke.ok()).toBeTruthy();
  }
});
