import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import app from "../app";
import { db } from "@workspace/db";
import {
  casCapturePolicy,
  casCaptureRequests,
  casEvidence,
  casIncidentEvents,
  casIncidents,
  casOutbox,
  casPushRegistrations,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  resetCasAuthFailureTracking,
  setCasAuthBurstRecorder,
  setCasAuthFailureLimitConfig,
  setCasAuthRejectionRecorder,
  type CasAuthFailureBurst,
  type CasAuthRejection,
} from "../lib/cas-auth";
import { resetCasPushTokenCache } from "../lib/cas-push";
import { assertDisposableTestDatabase } from "../lib/cas-test-db-guard";

// This suite writes to whatever DATABASE_URL points at: refuse to boot unless
// the contract runner's disposable review database is provably the target.
assertDisposableTestDatabase();

// This suite intentionally strings credential rejections together; run the
// per-IP rejection tarpit (see lib/cas-auth.ts) on a near-zero schedule so
// the 401s stay instant. The tarpit's own route test below installs a
// measurable schedule and restores this one.
const SUITE_FAILURE_LIMIT_CONFIG = { baseDelayMs: 3, maxDelayMs: 15, burstThreshold: 1_000 };
setCasAuthFailureLimitConfig(SUITE_FAILURE_LIMIT_CONFIG);

// Evidence endpoints require enrolled credentials on both sides: the handset
// presents its own enrolled device credential (Authorization: Bearer) — the
// shared device token is NOT accepted, so revocation fails closed — and the
// console presents an enrolled credential of its own.
process.env.CAS_ALERT_TOKEN ??= "cas-test-alert-token";
process.env.CAS_DEVICE_TOKEN = "cas-test-device-token";
// Keep triggers quiet: no provider-configured gateway channels, no
// device-delivery mode surprises from the shared environment.
process.env.CAS_SMS_DELIVERY_MODE = "gateway";
delete process.env.CAS_DEVICE_CHANNELS;
delete process.env.CAS_SMS_PROVIDER_URL;
delete process.env.CAS_XMPP_PROVIDER_URL;
delete process.env.CAS_EMAIL_PROVIDER_URL;
delete process.env.CAS_WHATSAPP_PROVIDER_URL;

const DEVICE = { "x-cas-device-token": process.env.CAS_DEVICE_TOKEN };

const server = app.listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}/api`;

// Console mutations (policy, capture requests, downloads) and the trigger
// used to set up incidents ride an enrolled per-device credential — the
// enrollment credential (CAS_ALERT_TOKEN) itself no longer authorizes
// mutations. This mirrors the console's own enrollment flow.
const enrollResponse = await fetch(`${baseUrl}/cas/devices/enroll`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.CAS_ALERT_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ label: "evidence-test-console" }),
});
assert.equal(enrollResponse.status, 201);
const consoleToken = ((await enrollResponse.json()) as { token: string }).token;
const AUTH = { authorization: `Bearer ${consoleToken}` };

// The handset enrolls its own credential, exactly like the Android app does
// during provisioning. Evidence upload, capture-request pickup, and acks
// carry this Bearer token.
const enrollHandset = async (label: string) => {
  const response = await fetch(`${baseUrl}/cas/devices/enroll`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CAS_ALERT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { device: { id: string }; token: string };
};
const handset = await enrollHandset("evidence-test-handset");
const HANDSET = { authorization: `Bearer ${handset.token}` };

after(async () => {
  server.close();
  await once(server, "close");
});

async function clearCasData() {
  await db.delete(casEvidence);
  await db.delete(casCaptureRequests);
  await db.delete(casCapturePolicy);
  await db.delete(casIncidentEvents);
  await db.delete(casOutbox);
  await db.delete(casPushRegistrations);
  await db.delete(casIncidents);
}

beforeEach(clearCasData);

async function triggerIncident(): Promise<string> {
  const response = await fetch(`${baseUrl}/cas/incidents/trigger`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ deviceChannels: [] }),
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { id: string };
  return body.id;
}

async function putPolicy(policy: Record<string, string>) {
  const response = await fetch(`${baseUrl}/cas/evidence-policy`, {
    method: "PUT",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ camera: "back", ...policy }),
  });
  assert.equal(response.status, 200);
}

function uploadEvidence(incidentId: string, overrides: {
  kind?: string;
  contentType?: string;
  body?: Buffer;
  headers?: Record<string, string>;
} = {}) {
  return fetch(`${baseUrl}/cas/incidents/${incidentId}/evidence`, {
    method: "POST",
    headers: {
      ...HANDSET,
      "content-type": overrides.contentType ?? "image/jpeg",
      "x-cas-evidence-kind": overrides.kind ?? "photo",
      "x-cas-captured-at": "1759000000000",
      ...overrides.headers,
    },
    body: overrides.body ?? Buffer.from("fake-jpeg-bytes"),
  });
}

test("policy defaults to everything off with immediate timing", async () => {
  const response = await fetch(`${baseUrl}/cas/evidence-policy`, { headers: AUTH });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    audio: "off", photo: "off", video: "off", timing: "immediate", camera: "back", updatedAt: null,
  });
});

test("policy fetch requires an enrolled credential; anonymous reads are rejected", async () => {
  // The policy reveals the system's capture posture, so reads are gated like
  // every other console read. The console credential and the handset's own
  // enrolled credential both pass; an anonymous request gets 401.
  assert.equal((await fetch(`${baseUrl}/cas/evidence-policy`, { headers: AUTH })).status, 200);
  assert.equal((await fetch(`${baseUrl}/cas/evidence-policy`, { headers: HANDSET })).status, 200);
  assert.equal((await fetch(`${baseUrl}/cas/evidence-policy`)).status, 401);
});

test("policy write requires the console credential and validates values", async () => {
  const anonymous = await fetch(`${baseUrl}/cas/evidence-policy`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audio: "trigger", photo: "off", video: "off", timing: "immediate" }),
  });
  assert.equal(anonymous.status, 401);
  // The device token is not a console credential: it must not mutate policy.
  const asDevice = await fetch(`${baseUrl}/cas/evidence-policy`, {
    method: "PUT",
    headers: { ...DEVICE, "content-type": "application/json" },
    body: JSON.stringify({ audio: "trigger", photo: "off", video: "off", timing: "immediate" }),
  });
  assert.equal(asDevice.status, 401);
  const invalid = await fetch(`${baseUrl}/cas/evidence-policy`, {
    method: "PUT",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ audio: "always", photo: "off", video: "off", timing: "immediate", camera: "back" }),
  });
  assert.equal(invalid.status, 400);
  const invalidCamera = await fetch(`${baseUrl}/cas/evidence-policy`, {
    method: "PUT",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ audio: "off", photo: "off", video: "off", timing: "immediate", camera: "selfie" }),
  });
  assert.equal(invalidCamera.status, 400);
});

test("policy write round-trips and is what the handset fetches", async () => {
  await putPolicy({ audio: "trigger", photo: "responder", video: "off", timing: "screen-off", camera: "both" });
  const response = await fetch(`${baseUrl}/cas/evidence-policy`, { headers: HANDSET });
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.audio, "trigger");
  assert.equal(body.photo, "responder");
  assert.equal(body.video, "off");
  assert.equal(body.timing, "screen-off");
  assert.equal(body.camera, "both");
  assert.equal(typeof body.updatedAt, "string");
});

test("evidence upload requires an enrolled credential; the shared device token is not accepted", async () => {
  const incidentId = await triggerIncident();
  const anonymous = await fetch(`${baseUrl}/cas/incidents/${incidentId}/evidence`, {
    method: "POST",
    headers: { "content-type": "image/jpeg", "x-cas-evidence-kind": "photo" },
    body: Buffer.from("fake-jpeg-bytes"),
  });
  assert.equal(anonymous.status, 401);
  // The shared device token alone must not open the evidence endpoints.
  const sharedOnly = await fetch(`${baseUrl}/cas/incidents/${incidentId}/evidence`, {
    method: "POST",
    headers: { ...DEVICE, "content-type": "image/jpeg", "x-cas-evidence-kind": "photo" },
    body: Buffer.from("fake-jpeg-bytes"),
  });
  assert.equal(sharedOnly.status, 401);
  const wrongBearer = await fetch(`${baseUrl}/cas/incidents/${incidentId}/evidence`, {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "image/jpeg", "x-cas-evidence-kind": "photo" },
    body: Buffer.from("fake-jpeg-bytes"),
  });
  assert.equal(wrongBearer.status, 401);
});

test("evidence-gate rejections pass through the same per-IP tarpit and burst alert as the other credential gates", async () => {
  // requireEnrolledDevice is a public credential gate like the enrollment and
  // delivery gates: repeated guesses against it must slow down and alert, or
  // it would be the fastest oracle on the box.
  setCasAuthFailureLimitConfig({ baseDelayMs: 50, maxDelayMs: 5_000, burstThreshold: 3, resetWindowMs: 60_000 });
  resetCasAuthFailureTracking();
  const bursts: CasAuthFailureBurst[] = [];
  const rejections: CasAuthRejection[] = [];
  setCasAuthBurstRecorder((burst) => bursts.push(burst));
  setCasAuthRejectionRecorder((rejection) => rejections.push(rejection));
  try {
    const guess = () => fetch(`${baseUrl}/cas/capture-requests/pending`, {
      headers: { authorization: "Bearer casdev_evidence-guess" },
    });

    let response = await guess();
    assert.equal(response.status, 401);
    let started = performance.now();
    response = await guess();
    assert.equal(response.status, 401);
    const second = performance.now() - started;
    assert.ok(second >= 45, `second evidence-gate rejection should wait ~50ms, took ${second}ms`);
    started = performance.now();
    response = await guess();
    assert.equal(response.status, 401);
    const third = performance.now() - started;
    assert.ok(third >= 95, `third evidence-gate rejection should wait ~100ms, took ${third}ms`);

    // The burst alert fires on this gate too, and every rejection was
    // recorded without the presented credential.
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0].failures, 3);
    assert.deepEqual(rejections.map((rejection) => rejection.reason), ["invalid-token", "invalid-token", "invalid-token"]);
    assert.ok(rejections.every((rejection) => rejection.path === "/api/cas/capture-requests/pending"));
    assert.ok(!JSON.stringify([bursts, rejections]).includes("casdev_evidence-guess"));

    // The enrolled handset's own polling is never delayed, even mid-streak.
    started = performance.now();
    const legit = await fetch(`${baseUrl}/cas/capture-requests/pending`, { headers: HANDSET });
    assert.equal(legit.status, 200);
    const legitElapsed = performance.now() - started;
    assert.ok(legitElapsed < 150, `credentialed handset polling must not be tarpitted, took ${legitElapsed}ms`);
  } finally {
    setCasAuthBurstRecorder();
    setCasAuthRejectionRecorder();
    setCasAuthFailureLimitConfig(SUITE_FAILURE_LIMIT_CONFIG);
    resetCasAuthFailureTracking();
  }
});

test("revocation fails closed: a revoked handset cannot use evidence endpoints, even with the shared token configured", async () => {
  // Enroll a dedicated handset credential, prove it works, then revoke it:
  // every subsequent evidence request must be rejected, and the shared
  // device token must not reopen anything.
  const revokedHandset = await enrollHandset("evidence-test-revoked-handset");
  const revokedAuth = { authorization: `Bearer ${revokedHandset.token}` };
  const incidentId = await triggerIncident();
  const upload = (headers: Record<string, string>) => fetch(`${baseUrl}/cas/incidents/${incidentId}/evidence`, {
    method: "POST",
    headers: { ...headers, "content-type": "image/jpeg", "x-cas-evidence-kind": "photo" },
    body: Buffer.from("fake-jpeg-bytes"),
  });
  assert.equal((await upload(revokedAuth)).status, 201);

  const revoke = await fetch(`${baseUrl}/cas/devices/${revokedHandset.device.id}/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CAS_ALERT_TOKEN}` },
  });
  assert.equal(revoke.status, 200);

  assert.equal((await upload(revokedAuth)).status, 401);
  assert.equal((await fetch(`${baseUrl}/cas/capture-requests/pending`, { headers: revokedAuth })).status, 401);
  // Fail closed across subsequent requests even though CAS_DEVICE_TOKEN is
  // configured: the legacy shared-token path does not exist here.
  assert.equal((await upload(DEVICE)).status, 401);
  assert.equal((await fetch(`${baseUrl}/cas/capture-requests/pending`, { headers: DEVICE })).status, 401);
});

test("evidence upload rejects unknown kinds and mismatched content types", async () => {
  const incidentId = await triggerIncident();
  const badKind = await uploadEvidence(incidentId, { kind: "screenshot" });
  assert.equal(badKind.status, 400);
  const badType = await uploadEvidence(incidentId, { kind: "photo", contentType: "video/mp4" });
  assert.equal(badType.status, 400);
  const missing = await uploadEvidence("no-such-incident");
  assert.equal(missing.status, 404);
});

test("evidence upload stores the clip, journals it, and lists it in /cas/state", async () => {
  const incidentId = await triggerIncident();
  const payload = Buffer.from("fake-jpeg-bytes");
  const response = await uploadEvidence(incidentId, { body: payload });
  assert.equal(response.status, 201);
  const stored = await response.json() as { id: string; kind: string; sizeBytes: number };
  assert.equal(stored.kind, "photo");
  assert.equal(stored.sizeBytes, payload.length);

  const rows = await db.select().from(casEvidence).where(eq(casEvidence.incidentId, incidentId));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].data, payload);
  assert.equal(rows[0].capturedAt?.toISOString(), new Date(1759000000000).toISOString());
  // Uploads without a camera header (older APKs) store no label.
  assert.equal(rows[0].camera, null);

  const journal = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, incidentId));
  assert.ok(journal.some((event) => event.type === "EVIDENCE_UPLOADED"));

  const state = await (await fetch(`${baseUrl}/cas/state`, { headers: AUTH })).json() as {
    activeIncident: { id: string; evidence: { id: string; kind: string; sizeBytes: number; camera: string | null }[] };
  };
  assert.equal(state.activeIncident.id, incidentId);
  assert.equal(state.activeIncident.evidence.length, 1);
  assert.equal(state.activeIncident.evidence[0].id, stored.id);
  assert.equal(state.activeIncident.evidence[0].camera, null);
});

test("evidence upload labels the capturing camera and the label reaches journal, state, and filename", async () => {
  const incidentId = await triggerIncident();
  const back = await uploadEvidence(incidentId, { headers: { "x-cas-evidence-camera": "back" } });
  assert.equal(back.status, 201);
  const front = await uploadEvidence(incidentId, {
    headers: { "x-cas-evidence-camera": "front", "x-cas-sequence": "2" },
  });
  assert.equal(front.status, 201);
  const frontId = ((await front.json()) as { id: string }).id;

  const rows = await db.select().from(casEvidence).where(eq(casEvidence.incidentId, incidentId));
  assert.deepEqual(rows.map((row) => row.camera).sort(), ["back", "front"]);

  const journal = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, incidentId));
  assert.ok(journal.some((event) => event.type === "EVIDENCE_UPLOADED" && event.detail.includes("front camera")));

  const state = await (await fetch(`${baseUrl}/cas/state`, { headers: AUTH })).json() as {
    activeIncident: { evidence: { id: string; camera: string | null }[] };
  };
  assert.deepEqual(
    state.activeIncident.evidence.find((item) => item.id === frontId)?.camera,
    "front",
  );

  const download = await fetch(`${baseUrl}/cas/evidence/${frontId}/download`, { headers: AUTH });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition") ?? "", /attachment; filename="cas-.*-photo-front-2\.jpg"/);
});

test("evidence upload rejects an unknown camera label and drops the label from audio clips", async () => {
  const incidentId = await triggerIncident();
  const invalid = await uploadEvidence(incidentId, { headers: { "x-cas-evidence-camera": "selfie" } });
  assert.equal(invalid.status, 400);

  // Audio has no lens; a camera header on an audio upload is meaningless
  // metadata and must not be stored.
  const audio = await uploadEvidence(incidentId, {
    kind: "audio",
    contentType: "audio/mp4",
    body: Buffer.from("fake-audio"),
    headers: { "x-cas-evidence-camera": "front" },
  });
  assert.equal(audio.status, 201);
  const rows = await db.select().from(casEvidence).where(eq(casEvidence.incidentId, incidentId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "audio");
  assert.equal(rows[0].camera, null);
});

test("evidence download streams the bytes to the console credential only", async () => {
  const incidentId = await triggerIncident();
  const upload = await uploadEvidence(incidentId, { kind: "video", contentType: "video/mp4", body: Buffer.from("fake-video") });
  const stored = await upload.json() as { id: string };

  const anonymous = await fetch(`${baseUrl}/cas/evidence/${stored.id}/download`);
  assert.equal(anonymous.status, 401);

  const response = await fetch(`${baseUrl}/cas/evidence/${stored.id}/download`, { headers: AUTH });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="cas-.*-video-1\.mp4"/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from("fake-video"));
});

test("capture requests require the matching responder policy setting", async () => {
  const incidentId = await triggerIncident();
  const request = (kind: string) => fetch(`${baseUrl}/cas/incidents/${incidentId}/capture-requests`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  // Policy default off: a loud 409, not a silently queued request.
  assert.equal((await request("audio")).status, 409);
  await putPolicy({ audio: "responder", photo: "trigger", video: "off", timing: "immediate" });
  // "trigger" means capture already starts on every trigger: 409 too.
  const triggerMode = await request("photo");
  assert.equal(triggerMode.status, 409);
  const ok = await request("audio");
  assert.equal(ok.status, 201);
  const created = await ok.json() as { id: string; state: string };
  assert.equal(created.state, "PENDING");
  const journal = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, incidentId));
  assert.ok(journal.some((event) => event.type === "CAPTURE_REQUESTED"));
});

test("capture request lifecycle: pending pickup, started ack, completed by upload", async () => {
  const incidentId = await triggerIncident();
  await putPolicy({ audio: "responder", photo: "off", video: "off", timing: "immediate" });
  const created = await (await fetch(`${baseUrl}/cas/incidents/${incidentId}/capture-requests`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ kind: "audio" }),
  })).json() as { id: string };

  const pending = await fetch(`${baseUrl}/cas/capture-requests/pending`, { headers: HANDSET });
  assert.equal(pending.status, 200);
  const pendingBody = await pending.json() as { items: { id: string; incidentId: string; kind: string }[] };
  assert.deepEqual(pendingBody.items.map((item) => item.id), [created.id]);

  // Pending list requires the enrolled handset credential.
  assert.equal((await fetch(`${baseUrl}/cas/capture-requests/pending`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/cas/capture-requests/pending`, { headers: DEVICE })).status, 401);

  const ack = await fetch(`${baseUrl}/cas/capture-requests/${created.id}/ack`, {
    method: "POST",
    headers: { ...HANDSET, "content-type": "application/json" },
    body: JSON.stringify({ outcome: "started" }),
  });
  assert.equal(ack.status, 200);

  // A second ack conflicts: the request has already left PENDING.
  const ackAgain = await fetch(`${baseUrl}/cas/capture-requests/${created.id}/ack`, {
    method: "POST",
    headers: { ...HANDSET, "content-type": "application/json" },
    body: JSON.stringify({ outcome: "started" }),
  });
  assert.equal(ackAgain.status, 409);

  // The answering upload flips the request to COMPLETED.
  const upload = await uploadEvidence(incidentId, {
    kind: "audio",
    contentType: "audio/mp4",
    body: Buffer.from("fake-aac-audio"),
    headers: { "x-cas-capture-request-id": created.id },
  });
  assert.equal(upload.status, 201);
  const request = await db.select().from(casCaptureRequests).where(eq(casCaptureRequests.id, created.id));
  assert.equal(request[0].state, "COMPLETED");
  const journal = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, incidentId));
  assert.ok(journal.some((event) => event.type === "CAPTURE_STARTED"));
  assert.ok(journal.some((event) => event.type === "CAPTURE_COMPLETED"));
});

test("failed ack records the measured background-start restriction", async () => {
  const incidentId = await triggerIncident();
  await putPolicy({ audio: "responder", photo: "off", video: "off", timing: "immediate" });
  const created = await (await fetch(`${baseUrl}/cas/incidents/${incidentId}/capture-requests`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ kind: "audio" }),
  })).json() as { id: string };

  const ack = await fetch(`${baseUrl}/cas/capture-requests/${created.id}/ack`, {
    method: "POST",
    headers: { ...HANDSET, "content-type": "application/json" },
    body: JSON.stringify({ outcome: "failed", detail: "ForegroundServiceStartNotAllowedException: background mic start blocked" }),
  });
  assert.equal(ack.status, 200);
  const request = await db.select().from(casCaptureRequests).where(eq(casCaptureRequests.id, created.id));
  assert.equal(request[0].state, "FAILED");
  assert.match(request[0].detail ?? "", /ForegroundServiceStartNotAllowedException/);
  const journal = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, incidentId));
  const failed = journal.find((event) => event.type === "CAPTURE_FAILED");
  assert.ok(failed);
  assert.match(failed.detail, /background mic start blocked/);
});

test("handset evidence endpoints do not depend on CAS_DEVICE_TOKEN at all", async () => {
  // The enrolled handset credential stands alone: with the shared device
  // token unset, enrolled handsets keep working and nothing falls back.
  const incidentId = await triggerIncident();
  const saved = process.env.CAS_DEVICE_TOKEN;
  delete process.env.CAS_DEVICE_TOKEN;
  try {
    const upload = await uploadEvidence(incidentId);
    assert.equal(upload.status, 201);
    const pending = await fetch(`${baseUrl}/cas/capture-requests/pending`, { headers: HANDSET });
    assert.equal(pending.status, 200);
    const policy = await fetch(`${baseUrl}/cas/evidence-policy`, { headers: HANDSET });
    assert.equal(policy.status, 200);
  } finally {
    process.env.CAS_DEVICE_TOKEN = saved;
  }
});

// --- Responder capture-request push wake -----------------------------------

function registerPushToken(auth: Record<string, string>, token: string) {
  return fetch(`${baseUrl}/cas/devices/push-token`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

function createCaptureRequest(incidentId: string, kind = "audio") {
  return fetch(`${baseUrl}/cas/incidents/${incidentId}/capture-requests`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  });
}

const PUSH_ENV_KEYS = [
  "CAS_FCM_SERVICE_ACCOUNT_JSON",
  "CAS_FCM_SERVICE_ACCOUNT_FILE",
  "CAS_FCM_TOKEN_URI",
  "CAS_FCM_SEND_URL",
];

/** Run a block with the push env replaced; the real env is restored after. */
async function withPushEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved = Object.fromEntries(PUSH_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PUSH_ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key]!;
  }
  resetCasPushTokenCache();
  try {
    await run();
  } finally {
    for (const key of PUSH_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
    resetCasPushTokenCache();
  }
}

test("push-token registration requires an enrolled credential and upserts per credential", async () => {
  assert.equal((await registerPushToken({}, "tok")).status, 401);
  assert.equal((await fetch(`${baseUrl}/cas/devices/push-token`, {
    method: "PUT",
    headers: { ...HANDSET, "content-type": "application/json" },
    body: JSON.stringify({ token: "" }),
  })).status, 400);

  assert.equal((await registerPushToken(HANDSET, "fcm-token-v1")).status, 200);
  // Rotation replaces the row instead of accumulating stale tokens.
  assert.equal((await registerPushToken(HANDSET, "fcm-token-v2")).status, 200);
  const rows = await db.select().from(casPushRegistrations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token, "fcm-token-v2");
  assert.equal(rows[0].deviceCredentialId, handset.device.id);
});

test("capture request without push configured journals the polling fallback", async () => {
  await withPushEnv({}, async () => {
    const incidentId = await triggerIncident();
    await putPolicy({ audio: "responder", photo: "off", video: "off", timing: "immediate" });
    const created = await createCaptureRequest(incidentId);
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { push: string }).push, "unconfigured");
    const journal = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, incidentId));
    const event = journal.find((entry) => entry.type === "CAPTURE_PUSH_UNAVAILABLE");
    assert.ok(event, "journal must record that no push wake was sent");
    assert.match(event.detail, /next server contact/);
    // The request still exists for the polling pickup.
    const pending = await fetch(`${baseUrl}/cas/capture-requests/pending`, { headers: HANDSET });
    assert.equal((await pending.json() as { items: unknown[] }).items.length, 1);
  });
});

test("capture request with push configured sends a high-priority wake to non-revoked handsets only", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccount = {
    project_id: "cas-test-project",
    client_email: "cas-push@cas-test-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
  const sent: { authorization?: string; body: string }[] = [];
  const stub: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url === "/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "stub-access-token", expires_in: 3599 }));
        return;
      }
      sent.push({ authorization: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "projects/cas-test-project/messages/1" }));
    });
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const stubPort = (stub.address() as AddressInfo).port;
  try {
    await withPushEnv({
      CAS_FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
      CAS_FCM_SERVICE_ACCOUNT_FILE: undefined,
      CAS_FCM_TOKEN_URI: `http://127.0.0.1:${stubPort}/token`,
      CAS_FCM_SEND_URL: `http://127.0.0.1:${stubPort}/send`,
    }, async () => {
      // A second handset registers, then gets revoked: its token must not
      // receive the wake — revocation is meant to cut the phone off.
      const revokedHandset = await enrollHandset("evidence-test-push-revoked");
      assert.equal((await registerPushToken({ authorization: `Bearer ${revokedHandset.token}` }, "revoked-token")).status, 200);
      assert.equal((await registerPushToken(HANDSET, "live-token")).status, 200);
      const revoke = await fetch(`${baseUrl}/cas/devices/${revokedHandset.device.id}/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.CAS_ALERT_TOKEN}` },
      });
      assert.equal(revoke.status, 200);

      const incidentId = await triggerIncident();
      await putPolicy({ audio: "responder", photo: "off", video: "off", timing: "immediate" });
      const createdResponse = await createCaptureRequest(incidentId);
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json() as { id: string; push: string };
      assert.equal(created.push, "sent");

      assert.equal(sent.length, 1, "only the live handset's token receives the wake");
      assert.equal(sent[0].authorization, "Bearer stub-access-token");
      const message = JSON.parse(sent[0].body).message;
      assert.equal(message.token, "live-token");
      assert.equal(message.android.priority, "HIGH");
      assert.equal(message.data.requestId, created.id);
      assert.equal(message.data.incidentId, incidentId);
      assert.equal(message.notification, undefined);

      const journal = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, incidentId));
      const pushEvent = journal.find((entry) => entry.type === "CAPTURE_PUSH_SENT");
      assert.ok(pushEvent);
      assert.match(pushEvent.detail, /1 enrolled handset/);

      // The handset honors the request over the push path and says so.
      const ack = await fetch(`${baseUrl}/cas/capture-requests/${created.id}/ack`, {
        method: "POST",
        headers: { ...HANDSET, "content-type": "application/json" },
        body: JSON.stringify({ outcome: "started", via: "push" }),
      });
      assert.equal(ack.status, 200);
      const request = await db.select().from(casCaptureRequests).where(eq(casCaptureRequests.id, created.id));
      assert.equal(request[0].via, "push");
      const after = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, incidentId));
      const started = after.find((entry) => entry.type === "CAPTURE_STARTED");
      assert.match(started?.detail ?? "", /high-priority push/);
    });
  } finally {
    stub.close();
    await once(stub, "close");
  }
});

test("ack without a via field journals the polling path (older APKs have no push)", async () => {
  await withPushEnv({}, async () => {
    const incidentId = await triggerIncident();
    await putPolicy({ audio: "responder", photo: "off", video: "off", timing: "immediate" });
    const created = await (await createCaptureRequest(incidentId)).json() as { id: string };
    const ack = await fetch(`${baseUrl}/cas/capture-requests/${created.id}/ack`, {
      method: "POST",
      headers: { ...HANDSET, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "started" }),
    });
    assert.equal(ack.status, 200);
    const request = await db.select().from(casCaptureRequests).where(eq(casCaptureRequests.id, created.id));
    assert.equal(request[0].via, "poll");
    const journal = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, incidentId));
    const started = journal.find((entry) => entry.type === "CAPTURE_STARTED");
    assert.match(started?.detail ?? "", /polling path/);
  });
});
