import { expect, test, type Page, type Route } from '@playwright/test';

// Proofs for the past-alert evidence browser. The third test walks the
// operator happy path end to end (select an older alert, render its photo
// inline through a blob URL, delete behind the confirmation step, watch the
// row disappear and the journal keep the deletion entry) so a broken viewer
// or delete button fails CI before responders hit it. The first two guard
// the destructive operation against selection races: the panel must never
// display — let alone delete — one incident's clips while another incident
// is selected.
//
// Scenario 1 (failed selection load): after alert A's clips are shown,
// switching to alert B whose detail request fails must leave the error and
// NOTHING else — A's clips and their Delete buttons must be gone.
//
// Scenario 2 (selection change during the post-delete refresh): after a
// clip on A is deleted, the panel refetches A's detail. If the operator
// switches to B while that refetch is in flight, A's late response must be
// dropped — B's clips render, A's never reappear.
//
// Both regressions once let a confirm-delete click land on the previous
// incident's clip id while the selector showed the new incident.
//
// Environment is provided by scripts/run-console-browser-proof.mjs:
//   CAS_E2E_API_ORIGIN   — api-server origin (disposable DB, test credential)
//   CAS_E2E_ALERT_TOKEN  — the fixed, test-only enrollment credential
// The two incidents are seeded into the disposable database by the harness
// (never created by this spec, so no spec that runs afterwards is affected
// by a newer "latest incident"). Clips are uploaded through the real
// evidence endpoint. The seeded latest incident renders in BOTH the
// current-alert panel and the browse panel, so every browse-panel locator
// below uses the browse- test id prefix.
//
// Scenario ordering note: these proofs run BEFORE the mid-session-lock
// ack in the shared database... they only add evidence rows, never change
// incident status, so later proofs see the seeded incidents untouched.

const API_ORIGIN = process.env.CAS_E2E_API_ORIGIN;
const ALERT_TOKEN = process.env.CAS_E2E_ALERT_TOKEN;
const INCIDENT_A = 'e2e-browse-older-incident';
const INCIDENT_B = 'e2e-mid-session-lock-incident';

test.beforeEach(() => {
  if (!API_ORIGIN || !ALERT_TOKEN) {
    throw new Error(
      'CAS_E2E_API_ORIGIN and CAS_E2E_ALERT_TOKEN must be set — run via scripts/run-console-browser-proof.mjs.',
    );
  }
});

async function enroll(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ deviceId: string; token: string }> {
  const response = await request.post(`${API_ORIGIN}/api/cas/devices/enroll`, {
    headers: { authorization: `Bearer ${ALERT_TOKEN}`, 'content-type': 'application/json' },
    data: { label: 'e2e-evidence-browse-delete-proof' },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { device: { id: string }; token: string };
  return { deviceId: body.device.id, token: body.token };
}

async function uploadClip(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  incidentId: string,
  bytes: Buffer = Buffer.from('e2e-fake-jpeg-bytes'),
): Promise<string> {
  const upload = await request.post(`${API_ORIGIN}/api/cas/incidents/${incidentId}/evidence`, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'image/jpeg',
      'x-cas-evidence-kind': 'photo',
      'x-cas-evidence-camera': 'back',
      'x-cas-captured-at': '1760000000000',
    },
    data: bytes,
  });
  expect(upload.status()).toBe(201);
  return ((await upload.json()) as { id: string }).id;
}

// A real, decodable 2x2 JPEG: the inline-viewer proof asserts the <img>
// actually decodes (naturalWidth > 0), which fake bytes would never do.
const REAL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ACoXq4f/2Q==',
  'base64',
);

async function openIncidents(page: Page, token: string): Promise<void> {
  await page.addInitScript((deviceToken) => {
    sessionStorage.setItem('cas-device-token', deviceToken);
  }, token);
  await page.goto('/incidents');
  await expect(page.getByTestId('select-past-incident')).toBeVisible();
}

test('a failed selection load clears the previous alert’s clips — they cannot be deleted under the new selection', async ({ page, request }) => {
  const { token } = await enroll(request);
  const clipA = await uploadClip(request, token, INCIDENT_A);
  const clipB = await uploadClip(request, token, INCIDENT_B);
  await openIncidents(page, token);

  // Show alert A and its clip in the browse panel.
  await page.getByTestId('select-past-incident').selectOption(INCIDENT_A);
  await expect(page.getByTestId(`browse-row-evidence-${clipA}`)).toBeVisible();

  // Alert B's detail request fails (e.g. a transient server error).
  await page.route(`**/api/cas/incidents/${INCIDENT_B}/evidence`, (route: Route) => {
    void route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
  });
  await page.getByTestId('select-past-incident').selectOption(INCIDENT_B);

  // The selector shows B, the error is named, and A's clip — with its
  // Delete button — is gone from the browse panel. Nothing from A may
  // remain actionable. (B's clip keeps rendering in the current-alert
  // panel, which is the latest incident's own surface, not the browser.)
  await expect(page.getByTestId('text-browse-error')).toBeVisible();
  await expect(page.getByTestId('select-past-incident')).toHaveValue(INCIDENT_B);
  await expect(page.getByTestId(`browse-row-evidence-${clipA}`)).toHaveCount(0);
  await expect(page.getByTestId(`browse-button-delete-evidence-${clipA}`)).toHaveCount(0);
  await expect(page.getByTestId(`browse-row-evidence-${clipB}`)).toHaveCount(0);
});

test('a selection change during the post-delete refresh drops the late response for the unselected alert', async ({ page, request }) => {
  const { token } = await enroll(request);
  const clipA = await uploadClip(request, token, INCIDENT_A);
  const clipB = await uploadClip(request, token, INCIDENT_B);
  await openIncidents(page, token);

  await page.getByTestId('select-past-incident').selectOption(INCIDENT_A);
  await expect(page.getByTestId(`browse-row-evidence-${clipA}`)).toBeVisible();

  // Hold every subsequent fetch of A's detail until released: the delete's
  // own refresh (and any effect refetch) stay in flight while the operator
  // switches to B.
  const held: Array<() => void> = [];
  await page.route(`**/api/cas/incidents/${INCIDENT_A}/evidence`, async (route: Route) => {
    await new Promise<void>((resolve) => held.push(resolve));
    return route.fallback();
  });

  // Delete A's clip (the server deletion itself is a DELETE and passes
  // through; only the GET refresh is held). Wait until the refresh is
  // genuinely in flight so the race below is exercised, not skipped.
  await page.getByTestId(`browse-button-delete-evidence-${clipA}`).click();
  await page.getByTestId(`browse-button-confirm-delete-evidence-${clipA}`).click();
  await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);

  // Switch to B while A's refresh is still held; B's clip must render.
  await page.getByTestId('select-past-incident').selectOption(INCIDENT_B);
  await expect(page.getByTestId(`browse-row-evidence-${clipB}`)).toBeVisible();

  // Release A's late responses: they must be dropped, not applied — B's
  // clip stays, A's rows never reappear under the B selection.
  for (const release of held.splice(0)) release();
  await expect(page.getByTestId('select-past-incident')).toHaveValue(INCIDENT_B);
  await expect(page.getByTestId(`browse-row-evidence-${clipB}`)).toBeVisible();
  await expect(page.getByTestId(`browse-row-evidence-${clipA}`)).toHaveCount(0);
  await expect(page.getByTestId(`browse-button-delete-evidence-${clipA}`)).toHaveCount(0);

  // And the deletion really happened: re-selecting A lists the remaining
  // clips but not the deleted one, and its journal kept the deletion entry
  // (history is never rewritten).
  await page.unroute(`**/api/cas/incidents/${INCIDENT_A}/evidence`);
  await page.getByTestId('select-past-incident').selectOption(INCIDENT_A);
  await expect(page.getByTestId(`browse-row-evidence-${clipA}`)).toHaveCount(0);
  await expect(page.getByTestId('list-browse-journal')).toContainText('EVIDENCE DELETED');
  const detail = await request.get(`${API_ORIGIN}/api/cas/incidents/${INCIDENT_A}/evidence`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(detail.status()).toBe(200);
  const body = (await detail.json()) as { evidence: { id: string }[] };
  expect(body.evidence.some((clip) => clip.id === clipA)).toBe(false);
});

test('a past alert’s photo renders inline and deletes behind a confirmation, journaled', async ({ page, request }) => {
  // The operator happy path end to end: pick an older alert, view its clip
  // inline, delete it behind the confirmation step, watch the row disappear
  // and the journal keep the deletion entry. The throwaway credential and
  // every row this proof seeds are removed again in the finally block.
  const { deviceId, token } = await enroll(request);
  const clipA = await uploadClip(request, token, INCIDENT_A, REAL_JPEG);
  try {
    await openIncidents(page, token);

    // Past-incident selection: the older (non-latest) alert's clip lists.
    await page.getByTestId('select-past-incident').selectOption(INCIDENT_A);
    await expect(page.getByTestId(`browse-row-evidence-${clipA}`)).toBeVisible();

    // Inline render: View fetches the bytes with the console credential and
    // shows them through an object URL that actually decodes as an image.
    await page.getByTestId(`browse-button-view-evidence-${clipA}`).click();
    const image = page.getByTestId(`browse-viewer-evidence-${clipA}`).locator('img');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);

    // Delete with confirmation: the row leaves the list and the incident's
    // journal keeps the EVIDENCE_DELETED entry (history is never rewritten).
    await page.getByTestId(`browse-button-delete-evidence-${clipA}`).click();
    await expect(page.getByTestId(`browse-confirm-delete-evidence-${clipA}`)).toBeVisible();
    await page.getByTestId(`browse-button-confirm-delete-evidence-${clipA}`).click();
    await expect(page.getByTestId(`browse-row-evidence-${clipA}`)).toHaveCount(0);
    await expect(page.getByTestId('list-browse-journal')).toContainText('EVIDENCE DELETED');
  } finally {
    // Clean up what this proof seeded: any clip left over (e.g. after a
    // mid-test failure) and the throwaway credential, so the disposable
    // database holds no live credential this proof created.
    await request
      .delete(`${API_ORIGIN}/api/cas/evidence/${clipA}`, { headers: { authorization: `Bearer ${token}` } })
      .catch(() => {});
    const revoke = await request.post(`${API_ORIGIN}/api/cas/devices/${deviceId}/revoke`, {
      headers: { authorization: `Bearer ${ALERT_TOKEN}` },
    });
    expect(revoke.ok()).toBeTruthy();
  }
});
