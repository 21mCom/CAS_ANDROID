import assert from "node:assert/strict";
import { once } from "node:events";
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
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";

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
    body: JSON.stringify(policy),
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
    audio: "off", photo: "off", video: "off", timing: "immediate", updatedAt: null,
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
    body: JSON.stringify({ audio: "always", photo: "off", video: "off", timing: "immediate" }),
  });
  assert.equal(invalid.status, 400);
});

test("policy write round-trips and is what the handset fetches", async () => {
  await putPolicy({ audio: "trigger", photo: "responder", video: "off", timing: "screen-off" });
  const response = await fetch(`${baseUrl}/cas/evidence-policy`, { headers: HANDSET });
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.audio, "trigger");
  assert.equal(body.photo, "responder");
  assert.equal(body.video, "off");
  assert.equal(body.timing, "screen-off");
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

  const journal = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, incidentId));
  assert.ok(journal.some((event) => event.type === "EVIDENCE_UPLOADED"));

  const state = await (await fetch(`${baseUrl}/cas/state`, { headers: AUTH })).json() as {
    activeIncident: { id: string; evidence: { id: string; kind: string; sizeBytes: number }[] };
  };
  assert.equal(state.activeIncident.id, incidentId);
  assert.equal(state.activeIncident.evidence.length, 1);
  assert.equal(state.activeIncident.evidence[0].id, stored.id);
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
