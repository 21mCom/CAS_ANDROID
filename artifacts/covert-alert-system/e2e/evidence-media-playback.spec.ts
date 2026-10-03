import { expect, test, type Locator, type Page } from '@playwright/test';

// Proves audio and video evidence clips actually load in the console's
// inline viewer in a real browser. The happy-path browse/delete proof
// (evidence-browse-delete.spec.ts) covers photo clips only: it asserts the
// <img> decodes (naturalWidth > 0). The same EvidenceItemRow renders
// <audio> and <video> elements for those kinds, and nothing else exercised
// them — a change that breaks clip playback (wrong MIME handling on the
// download route, a broken blob URL) would have shipped silently. This spec
// uploads a tiny real audio clip and a tiny real video clip through the
// real evidence endpoint, opens each with its Play button, and asserts the
// media element loads the bytes (readyState past HAVE_NOTHING, no error).
//
// Codec note: the handset records H.264/AAC in MP4, which the Chromium used
// here and in CI cannot decode (proprietary codecs are not in Chromium's
// ffmpeg build). The proof clips are therefore PCM WAV and VP8 WebM — real,
// decodable media — generated with ffmpeg at proof-authoring time and
// embedded as base64, like REAL_JPEG in the photo proof. They upload as
// application/octet-stream, which the upload route accepts for every kind
// (the fallback older APKs use); the download route echoes that type and
// the browser sniffs the container, exactly as it must for those uploads.
// Everything around the codec stays on the real path: credentialed upload,
// metadata listing, credentialed download, blob URL, media element demuxing
// the response bytes.
//
// Environment is provided by scripts/run-console-browser-proof.mjs:
//   CAS_E2E_API_ORIGIN   — api-server origin (disposable DB, test credential)
//   CAS_E2E_ALERT_TOKEN  — the fixed, test-only enrollment credential
// The clips attach to the seeded older incident and are exercised through
// the past-alert browser, mirroring the photo happy path (the seeded latest
// incident renders in both panels, so browse-panel locators keep the
// browse- test id prefix). Like the other evidence proofs this one only
// adds and removes evidence rows — it never changes incident status — and
// it cleans up after itself in finally: leftover clips are deleted and the
// throwaway credential is revoked, pass or fail.

const API_ORIGIN = process.env.CAS_E2E_API_ORIGIN;
const ALERT_TOKEN = process.env.CAS_E2E_ALERT_TOKEN;
const INCIDENT_A = 'e2e-browse-older-incident';

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
    data: { label: 'e2e-evidence-media-playback-proof' },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { device: { id: string }; token: string };
  return { deviceId: body.device.id, token: body.token };
}

async function uploadClip(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  incidentId: string,
  kind: 'audio' | 'video',
  bytes: Buffer,
): Promise<string> {
  const upload = await request.post(`${API_ORIGIN}/api/cas/incidents/${incidentId}/evidence`, {
    headers: {
      authorization: `Bearer ${token}`,
      // See the codec note above: the decodable-in-Chromium proof clips ride
      // the content-type fallback the route accepts for every kind.
      'content-type': 'application/octet-stream',
      'x-cas-evidence-kind': kind,
      ...(kind === 'video' ? { 'x-cas-evidence-camera': 'back' } : {}),
      'x-cas-captured-at': '1760000000000',
    },
    data: bytes,
  });
  expect(upload.status()).toBe(201);
  return ((await upload.json()) as { id: string }).id;
}

// A real, decodable 0.5s PCM-WAV tone (440Hz, 8kHz mono) and a real,
// decodable 0.4s VP8 WebM clip (64x48), generated with ffmpeg:
//   ffmpeg -f lavfi -i sine=frequency=440:duration=0.5 -ac 1 -ar 8000 -c:a pcm_s16le audio.wav
//   ffmpeg -f lavfi -i testsrc=duration=0.4:size=64x48:rate=10 -c:v libvpx -b:v 50k -an video.webm
// Fake bytes would never reach readyState > 0, exactly like the photo
// proof's REAL_JPEG.
const REAL_AUDIO_WAV = Buffer.from(
  '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',
  'base64',
);
const REAL_VIDEO_WEBM = Buffer.from(
  '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',
  'base64',
);

async function openIncidents(page: Page, token: string): Promise<void> {
  await page.addInitScript((deviceToken) => {
    sessionStorage.setItem('cas-device-token', deviceToken);
  }, token);
  await page.goto('/incidents');
  await expect(page.getByTestId('select-past-incident')).toBeVisible();
}

// The media element must render through a blob URL and actually load the
// bytes: readyState past HAVE_NOTHING means the browser demuxed the clip,
// and a null error rules out a decode failure that raced the poll.
async function expectMediaLoads(media: Locator): Promise<void> {
  await expect(media).toBeVisible();
  await expect(media).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(() => media.evaluate((element: HTMLMediaElement) => element.readyState))
    .toBeGreaterThan(0);
  expect(await media.evaluate((element: HTMLMediaElement) => element.error?.code ?? null)).toBeNull();
}

test('a past alert’s audio and video clips load inline in the viewer', async ({ page, request }) => {
  const { deviceId, token } = await enroll(request);
  const audioClip = await uploadClip(request, token, INCIDENT_A, 'audio', REAL_AUDIO_WAV);
  const videoClip = await uploadClip(request, token, INCIDENT_A, 'video', REAL_VIDEO_WEBM);
  try {
    await openIncidents(page, token);

    // Past-incident selection: both clips list on the older alert.
    await page.getByTestId('select-past-incident').selectOption(INCIDENT_A);
    await expect(page.getByTestId(`browse-row-evidence-${audioClip}`)).toBeVisible();
    await expect(page.getByTestId(`browse-row-evidence-${videoClip}`)).toBeVisible();

    // Play the audio clip inline: the viewer fetches the bytes with the
    // console credential and the <audio> element must load them.
    await page.getByTestId(`browse-button-view-evidence-${audioClip}`).click();
    await expectMediaLoads(page.getByTestId(`browse-viewer-evidence-${audioClip}`).locator('audio'));

    // Same for the video clip and its <video> element.
    await page.getByTestId(`browse-button-view-evidence-${videoClip}`).click();
    await expectMediaLoads(page.getByTestId(`browse-viewer-evidence-${videoClip}`).locator('video'));
  } finally {
    // Clean up what this proof seeded: any clip left over (e.g. after a
    // mid-test failure) and the throwaway credential, so the disposable
    // database holds no live credential this proof created.
    for (const clipId of [audioClip, videoClip]) {
      await request
        .delete(`${API_ORIGIN}/api/cas/evidence/${clipId}`, { headers: { authorization: `Bearer ${token}` } })
        .catch(() => {});
    }
    const revoke = await request.post(`${API_ORIGIN}/api/cas/devices/${deviceId}/revoke`, {
      headers: { authorization: `Bearer ${ALERT_TOKEN}` },
    });
    expect(revoke.ok()).toBeTruthy();
  }
});
