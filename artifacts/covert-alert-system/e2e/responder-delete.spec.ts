import { expect, test } from '@playwright/test';

// Proves the Responders page two-step delete end to end in a real browser:
// the console loads with a valid enrolled device credential, the operator
// taps Delete then the "Tap again to remove" confirm state, and the row
// disappears — the FIRST tap alone must not remove anything. After a full
// page reload the deleted responder is still gone, and once the last row is
// removed the empty state explains the env-recipient fallback. The API-level
// route suite cannot see any of this (a broken confirm toggle, a row that
// stays rendered, or a delete that never reached the server).
//
// Environment is provided by scripts/run-console-browser-proof.mjs:
//   CAS_E2E_API_ORIGIN   — api-server origin (disposable DB, test credential)
//   CAS_E2E_ALERT_TOKEN  — the fixed, test-only enrollment credential
// The responder rows are created through the real API with the proof's own
// enrolled credential, and that credential is revoked at the end so the
// disposable database never outlives a live credential.

const API_ORIGIN = process.env.CAS_E2E_API_ORIGIN;
const ALERT_TOKEN = process.env.CAS_E2E_ALERT_TOKEN;

test.beforeEach(() => {
  if (!API_ORIGIN || !ALERT_TOKEN) {
    throw new Error(
      'CAS_E2E_API_ORIGIN and CAS_E2E_ALERT_TOKEN must be set — run via scripts/run-console-browser-proof.mjs.',
    );
  }
});

test('the two-step delete removes a responder and the removal sticks across reload', async ({ page, request }) => {
  // Enroll a throwaway device credential exactly the way an operator console
  // would, but through the API so the test needs no interactive prompt.
  const enroll = await request.post(`${API_ORIGIN}/api/cas/devices/enroll`, {
    headers: { authorization: `Bearer ${ALERT_TOKEN}`, 'content-type': 'application/json' },
    data: { label: 'e2e-responder-delete-proof' },
  });
  expect(enroll.status()).toBe(201);
  const { device, token } = (await enroll.json()) as { device: { id: string }; token: string };

  try {
    // Seed two responders through the real API so the proof can show the
    // delete removes only its own row, and later that removing the last row
    // surfaces the env-recipient fallback empty state.
    const authedHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const createTarget = await request.post(`${API_ORIGIN}/api/cas/config/responders`, {
      headers: authedHeaders,
      data: { name: 'Delete Target', smsNumber: '+1 555 000 4242' },
    });
    expect(createTarget.status()).toBe(201);
    const target = (await createTarget.json()) as { id: string };
    const createKeeper = await request.post(`${API_ORIGIN}/api/cas/config/responders`, {
      headers: authedHeaders,
      data: { name: 'Keeper Contact', emailAddress: 'keeper@example.org' },
    });
    expect(createKeeper.status()).toBe(201);
    const keeper = (await createKeeper.json()) as { id: string };

    // Seed the credential the way the app's own enrollment flow stores it.
    await page.addInitScript((deviceToken) => {
      sessionStorage.setItem('cas-device-token', deviceToken);
    }, token);

    // 1. Load the Responders page: both rows render.
    await page.goto('/responders');
    const targetRow = page.getByTestId(`row-responder-${target.id}`);
    const keeperRow = page.getByTestId(`row-responder-${keeper.id}`);
    await expect(targetRow).toBeVisible();
    await expect(keeperRow).toBeVisible();

    // 2. The first Delete tap only ARMS the confirm state — the row must
    //    still be there and the button must now read "Tap again to remove".
    const deleteButton = page.getByTestId(`button-delete-responder-${target.id}`);
    await deleteButton.click();
    await expect(deleteButton).toHaveText(/Tap again to remove/);
    await expect(targetRow).toBeVisible();

    // 3. The second tap confirms: the row disappears, the other responder
    //    survives, and no action error surfaces.
    await deleteButton.click();
    await expect(targetRow).toHaveCount(0);
    await expect(keeperRow).toBeVisible();
    await expect(page.getByTestId('banner-responder-error')).toHaveCount(0);

    // 4. A full reload proves the delete reached the server and stuck.
    await page.reload();
    await expect(keeperRow).toBeVisible();
    await expect(page.getByTestId(`row-responder-${target.id}`)).toHaveCount(0);

    // 5. Removing the last responder shows the empty state explaining that
    //    alerts fall back to the server's recipient lists.
    const keeperDeleteButton = page.getByTestId(`button-delete-responder-${keeper.id}`);
    await keeperDeleteButton.click();
    await expect(keeperDeleteButton).toHaveText(/Tap again to remove/);
    await keeperDeleteButton.click();
    await expect(keeperRow).toHaveCount(0);
    const emptyState = page.getByTestId('text-no-responders');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText(/fall back to the server.s recipient lists/);

    // 6. The empty state survives a reload too — the deletion is durable.
    await page.reload();
    await expect(page.getByTestId('text-no-responders')).toBeVisible();
    await expect(page.getByTestId(`row-responder-${target.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`row-responder-${keeper.id}`)).toHaveCount(0);
  } finally {
    // Revoke the proof credential no matter how the assertions went, so the
    // dev database never accumulates live credentials.
    const revoke = await request.post(`${API_ORIGIN}/api/cas/devices/${device.id}/revoke`, {
      headers: { authorization: `Bearer ${ALERT_TOKEN}` },
    });
    expect(revoke.ok()).toBeTruthy();
  }
});
