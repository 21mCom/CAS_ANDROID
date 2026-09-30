import { expect, test } from '@playwright/test';

// Proves the mid-session credential lock end to end in a real browser:
// the console loads with a valid enrolled device credential, the credential
// is revoked server-side, and the operator's next action (ACK) replaces the
// console with the signed-out locked surface — no incident data survives.
//
// Environment is provided by scripts/run-console-browser-proof.mjs:
//   CAS_E2E_API_ORIGIN   — api-server origin (disposable DB, test credential)
//   CAS_E2E_ALERT_TOKEN  — the fixed, test-only enrollment credential
// The incident row itself is seeded into the disposable database by the
// harness, never via the trigger endpoint, so no alert delivery can fire.

const API_ORIGIN = process.env.CAS_E2E_API_ORIGIN;
const ALERT_TOKEN = process.env.CAS_E2E_ALERT_TOKEN;
const INCIDENT_ID = 'e2e-mid-session-lock-incident';
const INCIDENT_TITLE = 'Kernel simulation activated';

test.beforeEach(() => {
  if (!API_ORIGIN || !ALERT_TOKEN) {
    throw new Error(
      'CAS_E2E_API_ORIGIN and CAS_E2E_ALERT_TOKEN must be set — run via scripts/run-console-browser-proof.mjs.',
    );
  }
});

test('revoking the credential mid-session locks the console on the next action', async ({ page, request }) => {
  // Enroll a throwaway device credential exactly the way an operator console
  // would, but through the API so the test needs no interactive prompt.
  const enroll = await request.post(`${API_ORIGIN}/api/cas/devices/enroll`, {
    headers: { authorization: `Bearer ${ALERT_TOKEN}`, 'content-type': 'application/json' },
    data: { label: 'e2e-mid-session-lock-proof' },
  });
  expect(enroll.status()).toBe(201);
  const { device, token } = (await enroll.json()) as { device: { id: string }; token: string };

  // Seed the credential the way the app's own enrollment flow stores it.
  await page.addInitScript((deviceToken) => {
    sessionStorage.setItem('cas-device-token', deviceToken);
  }, token);

  // 1. Successful load with the valid credential: incident data renders.
  await page.goto('/');
  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();
  await page.goto('/incidents');
  const ackButton = page.getByTestId('button-ack-kernel');
  await expect(ackButton).toBeEnabled();
  await expect(page.getByText(INCIDENT_ID)).toBeVisible();
  await expect(page.getByTestId('console-locked')).toHaveCount(0);

  // 2. Revoke the credential server-side (lost-phone flow), behind the
  // console's back — the loaded page still holds the now-dead token.
  const revoke = await request.post(`${API_ORIGIN}/api/cas/devices/${device.id}/revoke`, {
    headers: { authorization: `Bearer ${ALERT_TOKEN}` },
  });
  expect(revoke.ok()).toBeTruthy();

  // 3. The operator's next action fails and the console locks itself. The
  // server's per-IP anti-guessing backoff can hold the 401 for tens of
  // seconds (the console's own polling keeps the streak warm), so give the
  // locked surface generous room — but it must arrive within the backoff cap.
  await ackButton.click();
  const locked = page.getByTestId('console-locked');
  await expect(locked).toBeVisible({ timeout: 150_000 });
  await expect(locked.getByText(/device credential was rejected by the server/)).toBeVisible();

  // 4. No incident data — not even the demo seed — survives the lock.
  await expect(page.getByText(INCIDENT_TITLE)).toHaveCount(0);
  await expect(page.getByText(INCIDENT_ID)).toHaveCount(0);
  await expect(page.getByTestId('button-ack-kernel')).toHaveCount(0);
});
