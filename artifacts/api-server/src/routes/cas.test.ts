import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";
import app from "../app";
import { db, pool } from "@workspace/db";
import {
  casIncidentEvents,
  casIncidents,
  casOutbox,
} from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";

const server = app.listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}/api`;
const apiServerDirectory = fileURLToPath(new URL("../../", import.meta.url));

async function clearCasData() {
  await db.delete(casIncidentEvents);
  await db.delete(casOutbox);
  await db.delete(casIncidents);
}

async function startApiProcess() {
  const portServer = createServer();
  portServer.listen(0);
  await once(portServer, "listening");
  const port = (portServer.address() as AddressInfo).port;
  portServer.close();
  await once(portServer, "close");

  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "src/index.ts"],
    {
      cwd: apiServerDirectory,
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
    },
  );
  const childBaseUrl = `http://127.0.0.1:${port}/api`;

  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `API process exited before becoming ready: ${child.exitCode}`,
      );
    }

    try {
      const response = await fetch(`${childBaseUrl}/healthz`);
      if (response.ok) return { child, baseUrl: childBaseUrl };
    } catch {
      // The child process has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill();
  await once(child, "exit");
  throw new Error("Timed out waiting for API process to become ready");
}

async function stopApiProcess(child: ChildProcess) {
  if (child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
}

beforeEach(async () => {
  await clearCasData();
});

after(async () => {
  await clearCasData();
  server.close();
  await once(server, "close");
  await pool.end();
});

test("concurrent triggers reuse one incident and preserve both observations", async () => {
  const [first, second] = await Promise.all([
    fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" }),
    fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" }),
  ]);

  assert.ok([201, 200].includes(first.status));
  assert.ok([201, 200].includes(second.status));

  const firstBody = (await first.json()) as { id: string; reused: boolean };
  const secondBody = (await second.json()) as { id: string; reused: boolean };
  assert.equal(firstBody.id, secondBody.id);
  assert.deepEqual(
    [firstBody.reused, secondBody.reused].sort(),
    [false, true],
  );

  const incidents = await db.select().from(casIncidents);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].id, firstBody.id);
  assert.equal(incidents[0].triggerCount, 2);
  assert.equal(incidents[0].status, "ACTIVE_UNACKED");

  const events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, firstBody.id))
    .orderBy(asc(casIncidentEvents.createdAt));
  assert.equal(events.filter((event) => event.type.startsWith("TRIGGER")).length, 2);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("TRIGGER")).map((event) => event.type).sort(),
    ["TRIGGER_RECEIVED", "TRIGGER_REUSED"],
  );

  const outbox = await db
    .select()
    .from(casOutbox)
    .where(eq(casOutbox.incidentId, firstBody.id));
  assert.equal(outbox.length, 2);
  assert.deepEqual(outbox.map((item) => item.transport).sort(), ["SMS", "XMPP"]);

  const ack = await fetch(`${baseUrl}/cas/incidents/${firstBody.id}/ack`, {
    method: "POST",
  });
  assert.equal(ack.status, 200);
  assert.deepEqual(await ack.json(), {
    id: firstBody.id,
    status: "ACTIVE_ACKED",
  });

  const resolve = await fetch(
    `${baseUrl}/cas/incidents/${firstBody.id}/resolve`,
    { method: "POST" },
  );
  assert.equal(resolve.status, 200);
  assert.deepEqual(await resolve.json(), {
    id: firstBody.id,
    status: "RESOLVED",
  });

  const [resolved] = await db
    .select()
    .from(casIncidents)
    .where(eq(casIncidents.id, firstBody.id));
  assert.equal(resolved.status, "RESOLVED");

  const transitionTypes = (
    await db
      .select({ type: casIncidentEvents.type })
      .from(casIncidentEvents)
      .where(eq(casIncidentEvents.incidentId, firstBody.id))
  ).map((event) => event.type);
  assert.ok(transitionTypes.includes("RESPONDER_ACK"));
  assert.ok(transitionTypes.includes("RESPONDER_RESOLVE"));
});

test("concurrent ACK requests accept one transition and conflict the other", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  const responses = await Promise.all([
    fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST" }),
    fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST" }),
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);

  const incident = await db.select().from(casIncidents).where(eq(casIncidents.id, id));
  assert.equal(incident[0].status, "ACTIVE_ACKED");

  const events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, id));
  assert.equal(events.filter((event) => event.type === "RESPONDER_ACK").length, 1);
});

test("concurrent RESOLVE requests accept one transition and conflict the other", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };
  const ack = await fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST" });
  assert.equal(ack.status, 200);

  const responses = await Promise.all([
    fetch(`${baseUrl}/cas/incidents/${id}/resolve`, { method: "POST" }),
    fetch(`${baseUrl}/cas/incidents/${id}/resolve`, { method: "POST" }),
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);

  const incident = await db.select().from(casIncidents).where(eq(casIncidents.id, id));
  assert.equal(incident[0].status, "RESOLVED");

  const events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, id));
  assert.equal(events.filter((event) => event.type === "RESPONDER_ACK").length, 1);
  assert.equal(events.filter((event) => event.type === "RESPONDER_RESOLVE").length, 1);
});

test("separate API processes accept one concurrent ACK and journal one event", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  const first = await startApiProcess();
  const second = await startApiProcess();
  try {
    const responses = await Promise.all([
      fetch(`${first.baseUrl}/cas/incidents/${id}/ack`, { method: "POST" }),
      fetch(`${second.baseUrl}/cas/incidents/${id}/ack`, { method: "POST" }),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);

    const [incident] = await db
      .select()
      .from(casIncidents)
      .where(eq(casIncidents.id, id));
    assert.equal(incident.status, "ACTIVE_ACKED");

    const events = await db
      .select()
      .from(casIncidentEvents)
      .where(eq(casIncidentEvents.incidentId, id));
    assert.equal(events.filter((event) => event.type === "RESPONDER_ACK").length, 1);
    } finally {
    await Promise.all([
      stopApiProcess(first.child),
      stopApiProcess(second.child),
    ]);
  }
});

test("separate API processes accept one concurrent RESOLVE and journal one event", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };
  const ack = await fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST" });
  assert.equal(ack.status, 200);

  const first = await startApiProcess();
  const second = await startApiProcess();
  try {
    const responses = await Promise.all([
      fetch(`${first.baseUrl}/cas/incidents/${id}/resolve`, { method: "POST" }),
      fetch(`${second.baseUrl}/cas/incidents/${id}/resolve`, { method: "POST" }),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);

    const [incident] = await db
      .select()
      .from(casIncidents)
      .where(eq(casIncidents.id, id));
    assert.equal(incident.status, "RESOLVED");

    const events = await db
      .select()
      .from(casIncidentEvents)
      .where(eq(casIncidentEvents.incidentId, id));
    assert.equal(events.filter((event) => event.type === "RESPONDER_RESOLVE").length, 1);
  } finally {
    await Promise.all([
      stopApiProcess(first.child),
      stopApiProcess(second.child),
    ]);
  }
});
