import { expect, test, type APIRequestContext } from '@playwright/test';

// Proves the "keep this browser signed in" console flow end to end in a real
// browser, in both storage modes:
//   - a kept-signed-in (localStorage) credential re-authenticates after a
//     simulated browser restart without re-opening the enrollment dialog;
//   - a session-only (sessionStorage) credential does not — the dialog
//     appears instead, and cancelling it locks the console;
//   - the in-app enrollment dialog itself exchanges the enrollment
//     credential and honors (or ignores) the opt-in checkbox;
//   - "sign out this browser" clears both storages and returns to the
//     enrollment dialog;
//   - revoking a kept-signed-in credential server-side clears it and locks
//     the console on the next action, exactly like a session credential.
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
const TOKEN_KEY = 'cas-device-token';

test.beforeEach(() => {
  if (!API_ORIGIN || !ALERT_TOKEN) {
    throw new Error(
      'CAS_E2E_API_ORIGIN and CAS_E2E_ALERT_TOKEN must be set — run via scripts/run-console-browser-proof.mjs.',
    );
  }
});

/** Enrolls a throwaway device credential through the API, the way the app's
 * own enrollment flow does — the proofs that pre-seed storage should not
 * have to click through the dialog first. */
async function enrollDevice(request: APIRequestContext, label: string): Promise<{ deviceId: string; token: string }> {
  const enroll = await request.post(`${API_ORIGIN}/api/cas/devices/enroll`, {
    headers: { authorization: `Bearer ${ALERT_TOKEN}`, 'content-type': 'application/json' },
    data: { label },
  });
  expect(enroll.status()).toBe(201);
  const { device, token } = (await enroll.json()) as { device: { id: string }; token: string };
  return { deviceId: device.id, token };
}

test('a kept-signed-in credential re-authenticates after a simulated browser restart', async ({ page, request }) => {
  const { token } = await enrollDevice(request, 'e2e-remember-browser-persisted');
  // Seed exactly once: init scripts re-run on every navigation, and re-seeding
  // on the post-restart reload would prove reinsertion, not survival.
  await page.addInitScript((deviceToken) => {
    if (!localStorage.getItem('e2e-persisted-seed-done')) {
      localStorage.setItem('e2e-persisted-seed-done', '1');
      localStorage.setItem('cas-device-token', deviceToken);
    }
  }, token);

  await page.goto('/');
  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();
  await expect(page.getByTestId('device-enrollment-dialog')).toHaveCount(0);

  // Simulate a full browser restart: session storage dies, local storage
  // survives. The console must re-authenticate from the persisted credential
  // without asking again.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();
  await expect(page.getByTestId('device-enrollment-dialog')).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBe(token);
});

test('a session-only credential asks again after a simulated browser restart', async ({ page, request }) => {
  const { token } = await enrollDevice(request, 'e2e-remember-browser-session');
  // Playwright init scripts run on every load, so the seed is gated on a
  // restart marker in localStorage: flipping it is what simulates the
  // browser session dying (session store gone, local store intact).
  await page.addInitScript((deviceToken) => {
    if (!localStorage.getItem('e2e-simulated-restart')) {
      sessionStorage.setItem('cas-device-token', deviceToken);
    }
  }, token);

  await page.goto('/');
  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();

  // Same restart simulation: with nothing in localStorage the credential is
  // gone, so the enrollment dialog — never incident data — is what shows.
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.setItem('e2e-simulated-restart', '1');
  });
  await page.reload();
  const dialog = page.getByTestId('device-enrollment-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByText(INCIDENT_TITLE)).toHaveCount(0);

  // Cancelling the dialog locks the console, exactly like the old native
  // prompt's cancel did.
  await dialog.getByTestId('button-cancel-enrollment').click();
  await expect(page.getByTestId('console-locked')).toBeVisible();
  await expect(page.getByText(INCIDENT_TITLE)).toHaveCount(0);
});

test('enrolling through the dialog with keep-signed-in persists the credential', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByTestId('device-enrollment-dialog');
  await expect(dialog).toBeVisible();
  // The opt-in must start unchecked: persistence is never the default.
  await expect(dialog.getByTestId('checkbox-keep-signed-in')).not.toBeChecked();

  await dialog.getByTestId('input-enrollment-credential').fill(ALERT_TOKEN!);
  await dialog.getByTestId('checkbox-keep-signed-in').check();
  await dialog.getByTestId('button-enroll-device').click();

  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeTruthy();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY)).toBeNull();
});

test('enrolling through the dialog without keep-signed-in stays session-only', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByTestId('device-enrollment-dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByTestId('input-enrollment-credential').fill(ALERT_TOKEN!);
  await dialog.getByTestId('button-enroll-device').click();

  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY)).toBeTruthy();
  expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
});

test('a rejected enrollment credential shows the error inline and stores nothing', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByTestId('device-enrollment-dialog');
  await expect(dialog).toBeVisible();

  // A wrong credential must not lock the console or store anything — the
  // dialog stays open with the server's reason shown inline.
  await dialog.getByTestId('input-enrollment-credential').fill('definitely-wrong-credential');
  await dialog.getByTestId('button-enroll-device').click();
  await expect(dialog.getByTestId('enrollment-error')).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY)).toBeNull();

  // And the same dialog still accepts the right credential afterwards.
  await dialog.getByTestId('input-enrollment-credential').fill(ALERT_TOKEN!);
  await dialog.getByTestId('button-enroll-device').click();
  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();
});

test('sign out clears the persisted credential and returns to the enrollment dialog', async ({ page, request }) => {
  const { token } = await enrollDevice(request, 'e2e-remember-browser-signout');
  await page.addInitScript((deviceToken) => {
    localStorage.setItem('cas-device-token', deviceToken);
  }, token);

  await page.goto('/');
  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();

  await page.getByTestId('button-sign-out-console').click();
  const dialog = page.getByTestId('device-enrollment-dialog');
  await expect(dialog).toBeVisible();
  // The console is sealed instantly: blank signed-out backdrop, no incident
  // data visible or mounted behind the dialog, both storages empty.
  await expect(page.getByTestId('console-signed-out')).toBeVisible();
  await expect(page.getByText(INCIDENT_TITLE)).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY)).toBeNull();

  // The dialog the operator lands on is fully functional: signing back in
  // restores the console without a reload.
  await dialog.getByTestId('input-enrollment-credential').fill(ALERT_TOKEN!);
  await dialog.getByTestId('button-enroll-device').click();
  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();
  await expect(page.getByTestId('console-signed-out')).toHaveCount(0);
});

test('a slow or rejected re-enrollment after sign-out never re-exposes the signed-out screens', async ({ page, request }) => {
  // Seed a responder so the previous session's route holds real data, then
  // load it with a persisted credential. The row is removed again in the
  // finally block: the proofs share one disposable database, and a leftover
  // responder breaks the responder-delete proof's empty-state assertion.
  const { token } = await enrollDevice(request, 'e2e-remember-browser-signout-route');
  const authedHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const createResponder = await request.post(`${API_ORIGIN}/api/cas/config/responders`, {
    headers: authedHeaders,
    data: { name: 'Signout Witness', smsNumber: '+1 555 000 9911' },
  });
  expect(createResponder.status()).toBe(201);
  const responder = (await createResponder.json()) as { id: string };
  try {
  await page.addInitScript((deviceToken) => {
    localStorage.setItem('cas-device-token', deviceToken);
  }, token);
  await page.goto('/responders');
  await expect(page.getByTestId(`row-responder-${responder.id}`)).toBeVisible();
  await expect(page.getByText('Signout Witness')).toBeVisible();

  // Sign out, then make the FIRST enrollment attempt slow and rejected
  // (intercepted locally — no server backoff involved).
  let enrollAttempts = 0;
  await page.route('**/api/cas/devices/enroll', async (route) => {
    enrollAttempts += 1;
    if (enrollAttempts === 1) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The enrollment credential was rejected by the server.' }),
      });
    } else {
      await route.continue();
    }
  });

  await page.getByTestId('button-sign-out-console').click();
  const dialog = page.getByTestId('device-enrollment-dialog');
  await expect(dialog).toBeVisible();
  // Route-local data is gone the moment sign-out lands.
  await expect(page.getByTestId('console-signed-out')).toBeVisible();
  await expect(page.getByText('Signout Witness')).toHaveCount(0);

  // While the exchange is still in flight (the dialog busy, the request
  // unanswered), nothing from the previous session may reappear.
  await dialog.getByTestId('input-enrollment-credential').fill('definitely-wrong-credential');
  await dialog.getByTestId('button-enroll-device').click();
  await expect(dialog.getByTestId('button-enroll-device')).toBeDisabled();
  await expect(page.getByText('Signout Witness')).toHaveCount(0);
  await expect(page.getByTestId('console-signed-out')).toBeVisible();

  // After the rejection the dialog stays open with the error; the console
  // remains sealed behind the backdrop.
  await expect(dialog.getByTestId('enrollment-error')).toBeVisible();
  await expect(page.getByText('Signout Witness')).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();

  // Only a successful re-enrollment brings the console — and its data —
  // back.
  await dialog.getByTestId('input-enrollment-credential').fill(ALERT_TOKEN!);
  await dialog.getByTestId('button-enroll-device').click();
  await expect(page.getByTestId(`row-responder-${responder.id}`)).toBeVisible();
  await expect(page.getByText('Signout Witness')).toBeVisible();
  await expect(page.getByTestId('console-signed-out')).toHaveCount(0);
  } finally {
    await request.delete(`${API_ORIGIN}/api/cas/config/responders/${responder.id}`, {
      headers: authedHeaders,
    });
  }
});

test('a state response held from before sign-out cannot re-open the sealed console', async ({ page, request }) => {
  const { token } = await enrollDevice(request, 'e2e-remember-browser-stale-response');
  await page.addInitScript((deviceToken) => {
    localStorage.setItem('cas-device-token', deviceToken);
  }, token);
  await page.goto('/');
  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();

  // Arm a hold on the next state response, then reload the page: the fresh
  // load's state request — made with this session's credential — is now in
  // flight and unanswered, exactly like a slow response to an operator
  // action's reload. (Reloading, not "Record test event", keeps this proof
  // mutation-free: the proofs share one disposable database, and a created
  // incident would become the newest one the state endpoint selects,
  // breaking the later proofs that expect the seeded incident.)
  let releaseHeld: (() => void) | null = null;
  let notifyHeld: (() => void) | null = null;
  const heldArrived = new Promise<void>((resolve) => { notifyHeld = resolve; });
  let holdArmed = false;
  await page.route('**/api/cas/state', async (route) => {
    if (!holdArmed) {
      await route.continue();
      return;
    }
    holdArmed = false;
    notifyHeld?.();
    await new Promise<void>((resolve) => { releaseHeld = resolve; });
    await route.continue();
  });
  holdArmed = true;
  await page.reload();
  // Wait until the previous session's state request is actually in flight
  // before signing out — otherwise sign-out clears the credential first and
  // the request never happens, proving nothing.
  await heldArrived;

  // Sign out while that response is still in flight, then cancel the
  // enrollment: the console locks behind the signed-out surface.
  await page.getByTestId('button-sign-out-console').click();
  const dialog = page.getByTestId('device-enrollment-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('console-signed-out')).toBeVisible();
  await dialog.getByTestId('button-cancel-enrollment').click();
  await expect(page.getByTestId('console-locked')).toBeVisible();

  // Now the held response lands. It must be ignored: the lock stays, no
  // data returns, and both credential stores remain empty.
  expect(releaseHeld).not.toBeNull();
  releaseHeld!();
  await page.waitForTimeout(500); // give a mis-applied response room to render
  await expect(page.getByTestId('console-locked')).toBeVisible();
  await expect(page.getByText(INCIDENT_TITLE)).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY)).toBeNull();
});

test('revoking a kept-signed-in credential clears it and locks the console on the next action', async ({ page, request }) => {
  const { deviceId, token } = await enrollDevice(request, 'e2e-remember-browser-revoked');
  await page.addInitScript((deviceToken) => {
    localStorage.setItem('cas-device-token', deviceToken);
  }, token);

  await page.goto('/');
  await expect(page.getByText(INCIDENT_TITLE).first()).toBeVisible();
  await page.goto('/incidents');
  const ackButton = page.getByTestId('button-ack-kernel');
  await expect(ackButton).toBeEnabled();
  await expect(page.getByText(INCIDENT_ID)).toBeVisible();

  // Revoke the persisted credential server-side, behind the console's back.
  const revoke = await request.post(`${API_ORIGIN}/api/cas/devices/${deviceId}/revoke`, {
    headers: { authorization: `Bearer ${ALERT_TOKEN}` },
  });
  expect(revoke.ok()).toBeTruthy();

  // The operator's next action fails and the console locks itself. The
  // server's per-IP anti-guessing backoff can hold the 401 for tens of
  // seconds (the console's own polling keeps the streak warm), so give the
  // locked surface generous room — but it must arrive within the backoff cap.
  await ackButton.click();
  const locked = page.getByTestId('console-locked');
  await expect(locked).toBeVisible({ timeout: 150_000 });
  await expect(locked.getByText(/device credential was rejected by the server/)).toBeVisible();

  // The persisted credential is gone too — a revoked browser must not keep
  // retrying the dead token after a restart.
  expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
  await expect(page.getByText(INCIDENT_TITLE)).toHaveCount(0);
  await expect(page.getByText(INCIDENT_ID)).toHaveCount(0);
});
