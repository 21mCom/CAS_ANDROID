import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import app from "../app";
import { eq } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  casIncidentEvents,
  casIncidents,
  casMessageTemplates,
  casOutbox,
  casProviderDeliveries,
  casResponders,
  casTransportCooldowns,
} from "@workspace/db/schema";
import {
  createCasDeliverySender,
  createSmsProvider,
  buildCasAlertMessage,
} from "../lib/delivery-providers";
import { issueDeviceCredential, setCasAuthFailureLimitConfig } from "../lib/cas-auth";
import { assertDisposableTestDatabase } from "../lib/cas-test-db-guard";
import { loadConsoleMirrors } from "../lib/cas-console-mirror";
import {
  findUnknownPlaceholders,
  renderTemplate,
  smsSegmentCount,
  validateTemplateBody,
  templateWarnings,
  DEFAULT_TEMPLATE_BODY,
  MAX_TEMPLATE_CHARS,
} from "../lib/cas-message-template";

// This suite runs as its own `tsx --test` invocation (see package.json
// test:direct): it shares the review database with cas.test.ts, and the
// trigger fan-out reads cas_responders, so the two DB-heavy files must never
// run concurrently. beforeEach/after leave the config tables empty, which is
// exactly the env-fallback state cas.test.ts expects.
//
// Alert-API mutations are gated on per-device enrolled credentials (the
// shared CAS_ALERT_TOKEN is enrollment-only), so the suite enrolls one device
// credential up front and presents its token on every guarded call — the same
// pattern cas.test.ts uses.
process.env.CAS_ALERT_TOKEN ??= "cas-test-alert-token";
// This suite writes to whatever DATABASE_URL points at: refuse to boot unless
// the contract runner's disposable review database is provably the target.
assertDisposableTestDatabase();

const suiteCredential = await issueDeviceCredential("config-test-suite");

// This suite intentionally strings credential rejections together; run the
// per-IP rejection tarpit (see lib/cas-auth.ts) on a near-zero schedule so
// the 401s stay instant. The tarpit's own route tests live in cas.test.ts.
setCasAuthFailureLimitConfig({ baseDelayMs: 3, maxDelayMs: 15, burstThreshold: 1_000 });const AUTH_HEADERS = { authorization: `Bearer ${suiteCredential.token}` };

process.env.CAS_SMS_DELIVERY_MODE = "gateway";
delete process.env.CAS_DEVICE_CHANNELS;
delete process.env.CAS_DEVICE_TOKEN;
process.env.CAS_SMS_PROVIDER_URL = "https://sms-provider.invalid/submit";
process.env.CAS_SMS_RECIPIENTS = "+1555000111";
process.env.CAS_XMPP_PROVIDER_URL = "http://127.0.0.1:9/cas-test-xmpp";
process.env.CAS_XMPP_RECIPIENTS = "ops@example.org";
delete process.env.CAS_EMAIL_PROVIDER_URL;
delete process.env.CAS_EMAIL_RECIPIENTS;
delete process.env.CAS_WHATSAPP_PROVIDER_URL;
delete process.env.CAS_WHATSAPP_RECIPIENTS;

const server = app.listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}/api`;

async function clearCasData() {
  await db.delete(casIncidentEvents);
  await db.delete(casOutbox);
  await db.delete(casProviderDeliveries);
  await db.delete(casIncidents);
  await db.delete(casTransportCooldowns);
  await db.delete(casMessageTemplates);
  await db.delete(casResponders);
}

beforeEach(clearCasData);

after(async () => {
  await clearCasData();
  server.close();
  await pool.end();
});

async function api(path: string, init: RequestInit = {}, authed = true) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(authed ? AUTH_HEADERS : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Responder CRUD + env seeding
// ---------------------------------------------------------------------------

test("config routes reject unauthenticated requests", async () => {
  const response = await api("/cas/config/responders", {}, false);
  assert.equal(response.status, 401);
});

test("first responder read seeds from the environment recipient lists, once", async () => {
  const first = await api("/cas/config/responders");
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as {
    seeded: boolean;
    responders: Array<{ id: string; seeded: boolean; enabled: boolean; channels: Record<string, string | null> }>;
  };
  assert.equal(firstBody.seeded, true);
  assert.equal(firstBody.responders.length, 2);
  const sms = firstBody.responders.find((row) => row.channels.sms === "+1555000111");
  const xmpp = firstBody.responders.find((row) => row.channels.xmpp === "ops@example.org");
  assert.ok(sms, "expected a seeded SMS responder");
  assert.ok(xmpp, "expected a seeded XMPP responder");
  assert.equal(sms.enabled, true);
  assert.equal(sms.seeded, true);

  const second = await api("/cas/config/responders");
  const secondBody = (await second.json()) as { seeded: boolean; responders: unknown[] };
  assert.equal(secondBody.seeded, false);
  assert.equal(secondBody.responders.length, 2, "seeding must not duplicate rows");
});

test("responder create/validate/edit/disable cycle", async () => {
  const created = await api("/cas/config/responders", {
    method: "POST",
    body: JSON.stringify({ name: "Alex", smsNumber: "+15557654321", emailAddress: "alex@example.org" }),
  });
  assert.equal(created.status, 201);
  const responder = (await created.json()) as { id: string; enabled: boolean; channels: Record<string, string | null> };
  assert.equal(responder.enabled, true);
  assert.equal(responder.channels.sms, "+15557654321");
  assert.equal(responder.channels.email, "alex@example.org");
  assert.equal(responder.channels.whatsapp, null);

  const noChannels = await api("/cas/config/responders", {
    method: "POST",
    body: JSON.stringify({ name: "Nobody" }),
  });
  assert.equal(noChannels.status, 400);

  const badEmail = await api("/cas/config/responders", {
    method: "POST",
    body: JSON.stringify({ name: "Bad", emailAddress: "not-an-email" }),
  });
  assert.equal(badEmail.status, 400);

  const patched = await api(`/cas/config/responders/${responder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Alexandra", emailAddress: null }),
  });
  assert.equal(patched.status, 200);
  const patchedBody = (await patched.json()) as { name: string; channels: Record<string, string | null> };
  assert.equal(patchedBody.name, "Alexandra");
  assert.equal(patchedBody.channels.email, null, "null clears a channel");
  assert.equal(patchedBody.channels.sms, "+15557654321", "untouched channels survive a patch");

  const disabled = await api(`/cas/config/responders/${responder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(((await disabled.json()) as { enabled: boolean }).enabled, false);

  const missing = await api("/cas/config/responders/rsp-does-not-exist", {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// Templates: defaults, validation, preview, reset
// ---------------------------------------------------------------------------

// The live config payloads must satisfy the console's mirror schemas: the
// parity test (lib/cas-outbox-config-schema.test.ts) pins field NAMES, but
// only these runtime parses catch a same-key type or nullability change on
// either side (they throw CasStateShapeError on drift).
test("config responses satisfy the console mirror schemas", async () => {
  const mirrors = await loadConsoleMirrors();

  const responders = await api("/cas/config/responders");
  assert.equal(responders.status, 200);
  mirrors.parseCasRespondersResponse(await responders.json());

  const templates = await api("/cas/config/templates");
  assert.equal(templates.status, 200);
  mirrors.parseCasTemplatesResponse(await templates.json());

  const saved = await api("/cas/config/templates/SMS", {
    method: "PUT",
    body: JSON.stringify({ body: "Help needed: {{incident_id}} at {{time}}. {{location}}" }),
  });
  assert.equal(saved.status, 200);
  mirrors.parseCasTemplateInfo(await saved.json());

  const okPreview = await api("/cas/config/templates/preview", {
    method: "POST",
    body: JSON.stringify({ channel: "SMS", body: "Alert {{incident_id}} at {{time}}" }),
  });
  assert.equal(okPreview.status, 200);
  mirrors.parseCasTemplatePreviewResult(await okPreview.json());

  const badPreview = await api("/cas/config/templates/preview", {
    method: "POST",
    body: JSON.stringify({ channel: "SMS", body: "Alert {{not_a_placeholder}}" }),
  });
  assert.equal(badPreview.status, 200);
  mirrors.parseCasTemplatePreviewResult(await badPreview.json());
});

test("templates default to the built-in wording and render a preview", async () => {
  const response = await api("/cas/config/templates");
  assert.equal(response.status, 200);
  const { templates } = (await response.json()) as {
    templates: Array<{ channel: string; source: string; body: string; preview: string; warnings: string[] }>;
  };
  assert.deepEqual(templates.map((t) => t.channel), ["SMS", "XMPP", "EMAIL", "WHATSAPP"]);
  for (const template of templates) {
    assert.equal(template.source, "default");
    assert.equal(template.body, DEFAULT_TEMPLATE_BODY);
    assert.match(template.preview, /sim-preview-0001/);
    assert.match(template.preview, /maps\.google\.com/);
  }
});

test("template save validates placeholders, secrets, and length; delete resets", async () => {
  const custom = await api("/cas/config/templates/SMS", {
    method: "PUT",
    body: JSON.stringify({ body: "Help needed: {{incident_id}} at {{time}}. {{location}}" }),
  });
  assert.equal(custom.status, 200);
  const saved = (await custom.json()) as { source: string; preview: string };
  assert.equal(saved.source, "custom");
  assert.match(saved.preview, /^Help needed: sim-preview-0001 at /);

  const listed = await api("/cas/config/templates");
  const { templates } = (await listed.json()) as { templates: Array<{ channel: string; source: string }> };
  assert.equal(templates.find((t) => t.channel === "SMS")?.source, "custom");
  assert.equal(templates.find((t) => t.channel === "EMAIL")?.source, "default");

  const unknown = await api("/cas/config/templates/SMS", {
    method: "PUT",
    body: JSON.stringify({ body: "Alert {{incident_id}} {{operatr_name}}" }),
  });
  assert.equal(unknown.status, 400);
  assert.match(((await unknown.json()) as { error: string }).error, /Unknown placeholder.*operatr_name/);

  const secret = await api("/cas/config/templates/SMS", {
    method: "PUT",
    body: JSON.stringify({ body: "Alert {{incident_id}} api_key: xkcd9393secret" }),
  });
  assert.equal(secret.status, 400);
  assert.match(((await secret.json()) as { error: string }).error, /credentials/i);

  const tooLong = await api("/cas/config/templates/SMS", {
    method: "PUT",
    body: JSON.stringify({ body: "x".repeat(MAX_TEMPLATE_CHARS + 1) }),
  });
  assert.equal(tooLong.status, 400);

  const badChannel = await api("/cas/config/templates/PAGER", {
    method: "PUT",
    body: JSON.stringify({ body: "Alert {{incident_id}}" }),
  });
  assert.equal(badChannel.status, 404);

  const reset = await api("/cas/config/templates/SMS", { method: "DELETE" });
  assert.equal(reset.status, 200);
  assert.equal(((await reset.json()) as { source: string }).source, "default");
});

test("preview endpoint renders unsaved bodies and reports problems without failing", async () => {
  const ok = await api("/cas/config/templates/preview", {
    method: "POST",
    body: JSON.stringify({ channel: "SMS", body: "Ping {{incident_id}} {{location}}" }),
  });
  const okBody = (await ok.json()) as { ok: boolean; preview: string; warnings: string[] };
  assert.equal(okBody.ok, true);
  assert.match(okBody.preview, /^Ping sim-preview-0001 /);

  const invalid = await api("/cas/config/templates/preview", {
    method: "POST",
    body: JSON.stringify({ channel: "SMS", body: "password: hunter2 {{incident_id}}" }),
  });
  const invalidBody = (await invalid.json()) as { ok: boolean; error: string };
  assert.equal(invalidBody.ok, false);
  assert.match(invalidBody.error, /credentials/i);

  const long = await api("/cas/config/templates/preview", {
    method: "POST",
    body: JSON.stringify({ channel: "SMS", body: `{{incident_id}} ${"y".repeat(200)}` }),
  });
  const longBody = (await long.json()) as { ok: boolean; warnings: string[] };
  assert.equal(longBody.ok, true, "overlong SMS is flagged, not refused");
  assert.equal(longBody.warnings.length, 1);
  assert.match(longBody.warnings[0], /segments/);
});

// ---------------------------------------------------------------------------
// Fan-out from the console-managed responder circle
// ---------------------------------------------------------------------------

async function trigger() {
  const response = await api("/cas/incidents/trigger", { method: "POST", body: JSON.stringify({}) });
  assert.ok(response.status === 201 || response.status === 200, `trigger failed: ${response.status}`);
  return (await response.json()) as { id: string; reused: boolean };
}

async function outboxTransports(): Promise<string[]> {
  const rows = await db.select({ transport: casOutbox.transport }).from(casOutbox);
  return rows.map((row) => row.transport).sort();
}

test("fan-out queues only channels with an enabled responder", async () => {
  await api("/cas/config/responders", {
    method: "POST",
    body: JSON.stringify({ name: "Alex", smsNumber: "+15557654321" }),
  });
  const { reused } = await trigger();
  assert.equal(reused, false);
  // XMPP has a provider endpoint and env recipients, but no enabled responder
  // carries an XMPP address — the DB circle is the configuration now.
  assert.deepEqual(await outboxTransports(), ["SMS"]);
});

test("disabling every responder on a channel stops its fan-out", async () => {
  const created = await api("/cas/config/responders", {
    method: "POST",
    body: JSON.stringify({ name: "Alex", smsNumber: "+15557654321" }),
  });
  const responder = (await created.json()) as { id: string };
  await api(`/cas/config/responders/${responder.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  const { reused } = await trigger();
  assert.equal(reused, false);
  assert.deepEqual(await outboxTransports(), []);
});

test("env recipient lists remain the fallback while no DB responders exist", async () => {
  const { reused } = await trigger();
  assert.equal(reused, false);
  assert.deepEqual(await outboxTransports(), ["SMS", "XMPP"]);
});

// ---------------------------------------------------------------------------
// Delivery: per-send recipients and template wording from the DB
// ---------------------------------------------------------------------------

type CapturedPost = { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> };

async function withStubProvider(run: (url: string, posts: CapturedPost[]) => Promise<void>) {
  const posts: CapturedPost[] = [];
  const stub: HttpServer = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      posts.push({ headers: req.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/submit`;
  try {
    await run(url, posts);
  } finally {
    stub.close();
    await once(stub, "close");
  }
}

async function insertIncidentWithSmsOutbox() {
  const now = new Date();
  const id = `sim-${now.getTime()}-cfg`;
  await db.insert(casIncidents).values({ id, priority: "P1", status: "ACTIVE_UNACKED", createdAt: now, updatedAt: now });
  await db.insert(casOutbox).values({ id: `${id}-sms`, incidentId: id, transport: "SMS", state: "QUEUED", priority: "P1", createdAt: now });
  const [item] = await db.select().from(casOutbox);
  return { id, item };
}

test("delivery sends to console-managed recipients with the custom template", async () => {
  await api("/cas/config/responders", {
    method: "POST",
    body: JSON.stringify({ name: "Alex", smsNumber: "+15557654321" }),
  });
  await api("/cas/config/templates/SMS", {
    method: "PUT",
    body: JSON.stringify({ body: "Custom wording for {{incident_id}}. {{location}}" }),
  });
  const { id, item } = await insertIncidentWithSmsOutbox();

  await withStubProvider(async (url, posts) => {
    const sender = createCasDeliverySender({
      sms: createSmsProvider({ url, recipients: ["+10000000000"] }),
    });
    await sender(item, item.id);
    assert.equal(posts.length, 1, "only the enabled responder receives the alert");
    assert.equal(posts[0].body.to, "+15557654321");
    const body = posts[0].body.body as string;
    assert.match(body, new RegExp(`^Custom wording for ${id}\\. `));
    assert.match(body, /no fix captured/);
    assert.ok(!body.includes("Begin response protocol"), "custom template replaces the default wording");
  });
});

test("delivery falls back to env recipients and default wording with an empty circle", async () => {
  const { id, item } = await insertIncidentWithSmsOutbox();
  await withStubProvider(async (url, posts) => {
    const sender = createCasDeliverySender({
      sms: createSmsProvider({ url, recipients: ["+1555000111"] }),
    });
    await sender(item, item.id);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.to, "+1555000111");
    assert.match(posts[0].body.body as string, new RegExp(`^CAS P1 alert ${id} at `));
  });
});

test("an empty enabled circle fails loudly instead of silently sending nothing", async () => {
  const created = await api("/cas/config/responders", {
    method: "POST",
    body: JSON.stringify({ name: "Alex", smsNumber: "+15557654321" }),
  });
  const responder = (await created.json()) as { id: string };
  await api(`/cas/config/responders/${responder.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  const { item } = await insertIncidentWithSmsOutbox();
  await withStubProvider(async (url, posts) => {
    const sender = createCasDeliverySender({
      sms: createSmsProvider({ url, recipients: ["+10000000000"] }),
    });
    await assert.rejects(() => sender(item, item.id), /no recipients/);
    assert.equal(posts.length, 0, "nothing was submitted to the provider");
  });
});

// ---------------------------------------------------------------------------
// Device-direct SMS: the console circle and template govern the handset too
// ---------------------------------------------------------------------------

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const DEVICE_ENV = {
  CAS_SMS_DELIVERY_MODE: "device",
  CAS_DEVICE_TOKEN: "cas-config-test-device-token",
} as const;
// The pickup presents the suite's enrolled credential the way the handset
// does (Bearer): once any device credential exists the shared
// CAS_DEVICE_TOKEN on x-cas-device-token is retired (otherwise a revoked
// handset could resume with it), so the env token alone no longer
// authorizes device-pending.
const DEVICE_HEADERS = { authorization: `Bearer ${suiteCredential.token}` };

test("device-mode trigger hands the handset the console circle and template", async () => {
  await withEnv(DEVICE_ENV, async () => {
    await api("/cas/config/responders", {
      method: "POST",
      body: JSON.stringify({ name: "Alex", smsNumber: "+15557654321" }),
    });
    await api("/cas/config/templates/SMS", {
      method: "PUT",
      body: JSON.stringify({ body: "Custom wording for {{incident_id}}. {{location}}" }),
    });
    const { id, reused, deviceSms } = (await trigger()) as unknown as {
      id: string;
      reused: boolean;
      deviceSms?: { recipients: string[] | null; message: string };
    };
    assert.equal(reused, false);
    assert.deepEqual(deviceSms?.recipients, ["+15557654321"], "the handset texts the console circle, not a local list");
    assert.match(deviceSms?.message ?? "", new RegExp(`^Custom wording for ${id}\\. `));
    assert.deepEqual(await outboxTransports(), ["SMS"]);

    const pending = await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: DEVICE_HEADERS });
    assert.equal(pending.status, 200);
    const { items } = (await pending.json()) as { items: Array<{ recipients: string[] | null; message?: string }> };
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].recipients, ["+15557654321"]);
    assert.match(items[0].message ?? "", new RegExp(`^Custom wording for ${id}\\. `), "re-queued sends use the console template too");
  });
});

test("device-mode trigger with an unseeded circle keeps the handset list authoritative", async () => {
  await withEnv(DEVICE_ENV, async () => {
    const { deviceSms } = (await trigger()) as unknown as {
      deviceSms?: { recipients: string[] | null; message: string };
    };
    assert.equal(deviceSms?.recipients, null, "null means: handset's own list stays authoritative");
    assert.match(deviceSms?.message ?? "", /^CAS P1 alert sim-/, "default wording renders");
    // SMS goes to the handset; XMPP still fans out server-side from the env
    // fallback list.
    assert.deepEqual(await outboxTransports(), ["SMS", "XMPP"]);
  });
});

test("a managed circle with no enabled SMS numbers queues nothing and tells the handset to text nobody", async () => {
  await withEnv(DEVICE_ENV, async () => {
    const created = await api("/cas/config/responders", {
      method: "POST",
      body: JSON.stringify({ name: "Alex", smsNumber: "+15557654321" }),
    });
    const responder = (await created.json()) as { id: string };
    await api(`/cas/config/responders/${responder.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    const { deviceSms } = (await trigger()) as unknown as {
      deviceSms?: { recipients: string[] | null; message: string };
    };
    assert.deepEqual(deviceSms?.recipients, [], "explicitly nobody — distinct from the null legacy case");
    assert.deepEqual(await outboxTransports(), [], "no SMS row is queued to sit QUEUED forever");
  });
});

test("gateway-mode triggers carry no deviceSms directive", async () => {
  const { deviceSms } = (await trigger()) as unknown as { deviceSms?: unknown };
  assert.equal(deviceSms, undefined);
});

test("a revoked handset stays blocked on every successive request, even presenting the shared device token", async () => {
  await withEnv(DEVICE_ENV, async () => {
    const enrollmentCredential = process.env.CAS_ALERT_TOKEN ?? "";
    // Enroll exactly like the handset does: shared enrollment credential in,
    // per-device bearer out.
    const enroll = await fetch(`${baseUrl}/cas/devices/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${enrollmentCredential}` },
      body: JSON.stringify({ label: "revocation-regression-handset" }),
    });
    assert.equal(enroll.status, 201);
    const { token: deviceToken, device } = (await enroll.json()) as { token: string; device: { id: string } };

    const triggerResponse = await fetch(`${baseUrl}/cas/incidents/trigger`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ deviceChannels: ["SMS"] }),
    });
    assert.equal(triggerResponse.status, 201);
    const { id } = (await triggerResponse.json()) as { id: string };
    const receipt = { channel: "SMS", results: [{ recipient: "+1555000111", ok: true }] };
    const handsetHeaders = {
      // What the handset actually sent before the fix: its Bearer plus the
      // shared device token it still had configured.
      "content-type": "application/json",
      authorization: `Bearer ${deviceToken}`,
      "x-cas-device-token": DEVICE_ENV.CAS_DEVICE_TOKEN,
    };

    const revoke = await fetch(`${baseUrl}/cas/devices/${device.id}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${enrollmentCredential}` },
    });
    assert.equal(revoke.status, 200);

    // The handset's next pickup attempt is refused, so it clears its cached
    // credential — and every later call keeps being refused rather than
    // silently degrading to the shared token.
    const pickup = await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: handsetHeaders });
    assert.equal(pickup.status, 401);
    const pickupBody = (await pickup.json()) as { error?: string };
    assert.match(pickupBody.error ?? "", /revoked/i);

    const receiptAttempt = await fetch(`${baseUrl}/cas/incidents/${id}/device-receipt`, {
      method: "POST",
      headers: handsetHeaders,
      body: JSON.stringify(receipt),
    });
    assert.equal(receiptAttempt.status, 401, "a revoked handset must not mark deliveries sent");

    const retrigger = await fetch(`${baseUrl}/cas/incidents/trigger`, {
      method: "POST",
      headers: handsetHeaders,
      body: JSON.stringify({ deviceChannels: ["SMS"] }),
    });
    assert.equal(retrigger.status, 401, "a revoked handset must not open new incidents");

    // The outbox items (SMS plus the env-fallback XMPP) were never
    // transitioned by the rejected receipt.
    const outboxItems = await db.select().from(casOutbox).where(eq(casOutbox.incidentId, id));
    assert.ok(outboxItems.length > 0);
    assert.ok(outboxItems.every((item) => item.state === "QUEUED"), `rejected receipt must not transition anything: ${outboxItems.map((item) => `${item.transport}=${item.state}`).join(", ")}`);
  });
});

// ---------------------------------------------------------------------------
// Template engine unit tests
// ---------------------------------------------------------------------------

test("template renderer substitutes known placeholders and passes unknowns through", () => {
  const rendered = renderTemplate("A {{incident_id}} B {{ priority }} C {{bogus}}", {
    incident_id: "x1",
    priority: "P1",
    time: "t",
    location: "l",
  });
  assert.equal(rendered, "A x1 B P1 C {{bogus}}");
  assert.deepEqual(findUnknownPlaceholders("A {{incident_id}} {{bogus}} {{ bogus2 }}"), ["bogus", "bogus2"]);
});

test("template validation rejects empty, unknown placeholders, secrets, and oversize", () => {
  assert.equal(validateTemplateBody("   ").ok, false);
  assert.equal(validateTemplateBody("Hi {{nope}}").ok, false);
  assert.equal(validateTemplateBody("client_secret: abcdef123").ok, false);
  assert.equal(validateTemplateBody("x".repeat(MAX_TEMPLATE_CHARS + 1)).ok, false);
  assert.equal(validateTemplateBody("CAS {{priority}} alert {{incident_id}} at {{time}}. {{location}}").ok, true);
});

test("sms segment counting and overlength warning", () => {
  assert.equal(smsSegmentCount(160), 1);
  assert.equal(smsSegmentCount(161), 2);
  assert.equal(smsSegmentCount(153 * 3), 3);
  assert.equal(templateWarnings("SMS", "x".repeat(160)).length, 0);
  assert.equal(templateWarnings("SMS", "x".repeat(161)).length, 1);
  assert.equal(templateWarnings("EMAIL", "x".repeat(500)).length, 0, "length flag is SMS-specific");
});

test("default template renders byte-identical legacy wording", () => {
  const now = new Date("2026-09-27T10:15:00.000Z");
  const item = {
    incidentId: "sim-1",
    transport: "SMS",
    priority: "P1",
    createdAt: now,
  } as Parameters<typeof buildCasAlertMessage>[0];
  const message = buildCasAlertMessage(item, null);
  assert.equal(
    message.body,
    "CAS P1 alert sim-1 at 2026-09-27 10:15Z. Begin response protocol. Do not call handset. Location: no fix captured for this alert.",
  );
});
