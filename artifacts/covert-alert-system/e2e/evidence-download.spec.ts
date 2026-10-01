import { expect, test } from '@playwright/test';

// Proves the Alert log evidence download fires on the FIRST click in a real
// browser: an evidence clip is attached to the seeded incident, the operator
// clicks the file's Download button once, and the browser must report a
// download with the console's filename. The handler used to revoke the blob
// URL in the same tick as anchor.click(), which raced the browser's download
// startup and silently aborted it — this spec fails the moment that pattern
// (or a detached anchor) comes back.
//
// It also pins the saved filename to the server's Content-Disposition: the
// clip is uploaded with a front-camera label, so the server names it
// cas-<incident>-photo-front-1.jpg and the console must save exactly that —
// the console once rebuilt the filename itself and dropped the camera label.
//
// Environment is provided by scripts/run-console-browser-proof.mjs:
//   CAS_E2E_API_ORIGIN   — api-server origin (disposable DB, test credential)
//   CAS_E2E_ALERT_TOKEN  — the fixed, test-only enrollment credential
// The incident row itself is seeded into the disposable database by the
// harness, never via the trigger endpoint, so no alert delivery can fire.
// The clip is uploaded through the real evidence endpoint with the proof's
// own enrolled credential — the same path the handset uses.

const API_ORIGIN = process.env.CAS_E2E_API_ORIGIN;
const ALERT_TOKEN = process.env.CAS_E2E_ALERT_TOKEN;
const INCIDENT_ID = 'e2e-mid-session-lock-incident';
const EXPECTED_FILENAME = `cas-${INCIDENT_ID}-photo-front-1.jpg`;

test.beforeEach(() => {
  if (!API_ORIGIN || !ALERT_TOKEN) {
    throw new Error(
      'CAS_E2E_API_ORIGIN and CAS_E2E_ALERT_TOKEN must be set — run via scripts/run-console-browser-proof.mjs.',
    );
  }
});

test('clicking Download once saves the evidence file with the expected filename', async ({ page, request }) => {
  // Enroll a throwaway device credential exactly the way an operator console
  // would, but through the API so the test needs no interactive prompt.
  const enroll = await request.post(`${API_ORIGIN}/api/cas/devices/enroll`, {
    headers: { authorization: `Bearer ${ALERT_TOKEN}`, 'content-type': 'application/json' },
    data: { label: 'e2e-evidence-download-proof' },
  });
  expect(enroll.status()).toBe(201);
  const { token } = (await enroll.json()) as { device: { id: string }; token: string };

  // Attach a front-camera photo clip to the seeded incident through the real
  // upload endpoint. The enrolled credential authorizes it, exactly like the
  // handset's own credential would.
  const upload = await request.post(`${API_ORIGIN}/api/cas/incidents/${INCIDENT_ID}/evidence`, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'image/jpeg',
      'x-cas-evidence-kind': 'photo',
      'x-cas-evidence-camera': 'front',
      'x-cas-captured-at': '1760000000000',
    },
    data: Buffer.from('e2e-fake-jpeg-bytes'),
  });
  expect(upload.status()).toBe(201);
  const { id: evidenceId } = (await upload.json()) as { id: string };

  // Seed the credential the way the app's own enrollment flow stores it.
  await page.addInitScript((deviceToken) => {
    sessionStorage.setItem('cas-device-token', deviceToken);
  }, token);

  // Load the Alert log page with the valid credential; the clip renders.
  await page.goto('/incidents');
  const downloadButton = page.getByTestId(`button-download-evidence-${evidenceId}`);
  await expect(downloadButton).toBeVisible();
  await expect(downloadButton).toBeEnabled();

  // A single click must produce a browser download with the console's
  // filename — no refresh, no second click.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    downloadButton.click(),
  ]);
  expect(download.suggestedFilename()).toBe(EXPECTED_FILENAME);
});
