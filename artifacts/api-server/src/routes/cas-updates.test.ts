import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import app from "../app";
import { db, pool } from "@workspace/db";
import { casAppUpdates } from "@workspace/db/schema";
import {
  issueDeviceCredential,
  resetCasAuthFailureTracking,
  revokeDeviceCredential,
} from "../lib/cas-auth";
import { assertDisposableTestDatabase } from "../lib/cas-test-db-guard";

// This suite writes to whatever DATABASE_URL points at (it deletes
// cas_app_updates rows in setup and teardown): refuse to boot unless the
// contract runner's disposable review database is provably the target —
// before any credential is issued or any row is touched.
assertDisposableTestDatabase();

// Publishing takes the enrollment credential; manifest/download take any
// enrolled device credential. Set up one of each, like the main CAS suite.
process.env.CAS_ALERT_TOKEN ??= "cas-test-alert-token";
const ENROLLMENT_HEADERS = { authorization: `Bearer ${process.env.CAS_ALERT_TOKEN}` };
const suiteCredential = await issueDeviceCredential("test-suite-updates");
const DEVICE_HEADERS = { authorization: `Bearer ${suiteCredential.token}` };

const server = app.listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}/api`;

// A stand-in APK body; the endpoints treat it as opaque bytes.
const APK_V7 = Buffer.from("PKfake-apk-build-7-bytes");
const APK_V8 = Buffer.from("PKfake-apk-build-8-bytes-longer");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function publish(
  bytes: Buffer,
  query: string,
  headers: Record<string, string> = ENROLLMENT_HEADERS,
) {
  return fetch(`${baseUrl}/cas/app-updates?${query}`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/vnd.android.package-archive",
    },
    body: bytes,
  });
}

// Credential rejections go through the per-IP tarpit; this suite strings
// several intentional 401s, so keep the schedule from snowballing.
beforeEach(async () => {
  await db.delete(casAppUpdates);
  resetCasAuthFailureTracking();
});

after(async () => {
  await db.delete(casAppUpdates);
  server.close();
  await once(server, "close");
  await pool.end();
});

test("manifest is 404 before any build is published", async () => {
  const res = await fetch(`${baseUrl}/cas/app-updates/manifest`, { headers: DEVICE_HEADERS });
  assert.equal(res.status, 404);
});

test("manifest and download reject anonymous and wrong-gate callers", async () => {
  await publish(APK_V7, "versionCode=7&versionName=0.8.0-selfupdate");
  for (const headers of [{}, ENROLLMENT_HEADERS]) {
    // Anonymous: 401. The enrollment credential is operator-only and is NOT
    // a valid device credential for reads.
    const manifest = await fetch(`${baseUrl}/cas/app-updates/manifest`, { headers });
    assert.equal(manifest.status, 401, `manifest with headers ${JSON.stringify(headers)}`);
    const apk = await fetch(`${baseUrl}/cas/app-updates/latest.apk`, { headers });
    assert.equal(apk.status, 401, "apk download must be gated like the manifest");
  }
});

test("publishing requires the enrollment credential, not a device credential", async () => {
  const anonymous = await publish(APK_V7, "versionCode=7&versionName=0.8.0", {});
  assert.equal(anonymous.status, 401);
  const device = await publish(APK_V7, "versionCode=7&versionName=0.8.0", DEVICE_HEADERS);
  assert.equal(device.status, 401, "a field handset's device credential must not publish builds");
  assert.equal(await db.select().from(casAppUpdates).then((rows) => rows.length), 0);
});

test("publish then manifest: hash and size are computed from the bytes", async () => {
  const res = await publish(APK_V7, "versionCode=7&versionName=0.8.0-selfupdate");
  assert.equal(res.status, 201);
  const body = await res.json() as {
    published: boolean;
    update: {
      packageName: string;
      versionCode: number;
      versionName: string;
      sha256: string;
      sizeBytes: number;
      downloadPath: string;
    };
  };
  assert.equal(body.published, true);
  assert.equal(body.update.packageName, "com.covertalert.pixeltest");
  assert.equal(body.update.versionCode, 7);
  assert.equal(body.update.versionName, "0.8.0-selfupdate");
  assert.equal(body.update.sha256, sha256(APK_V7));
  assert.equal(body.update.sizeBytes, APK_V7.length);
  assert.equal(body.update.downloadPath, "/api/cas/app-updates/latest.apk");

  const manifestRes = await fetch(`${baseUrl}/cas/app-updates/manifest`, { headers: DEVICE_HEADERS });
  assert.equal(manifestRes.status, 200);
  assert.equal(manifestRes.headers.get("cache-control"), "no-store");
  const manifest = await manifestRes.json() as { versionCode: number; sha256: string };
  assert.equal(manifest.versionCode, 7);
  assert.equal(manifest.sha256, sha256(APK_V7));
});

test("download serves the exact published bytes, hash-pinned headers, no-store", async () => {
  await publish(APK_V8, "versionCode=8&versionName=0.8.1");
  const res = await fetch(`${baseUrl}/cas/app-updates/latest.apk`, { headers: DEVICE_HEADERS });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal(res.headers.get("x-cas-sha256"), sha256(APK_V8));
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(Number(res.headers.get("content-length")), APK_V8.length);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(bytes, APK_V8);
});

test("download is 404 before any build is published", async () => {
  const res = await fetch(`${baseUrl}/cas/app-updates/latest.apk`, { headers: DEVICE_HEADERS });
  assert.equal(res.status, 404);
});

test("publishing is monotonic: equal or lower versionCode is refused", async () => {
  assert.equal((await publish(APK_V8, "versionCode=8&versionName=0.8.1")).status, 201);
  const same = await publish(APK_V7, "versionCode=8&versionName=0.8.1-respin");
  assert.equal(same.status, 409, "re-publishing the same versionCode must never swap bytes");
  const lower = await publish(APK_V7, "versionCode=7&versionName=0.8.0");
  assert.equal(lower.status, 409, "Android cannot downgrade; a lower build must not publish");
  // The served build is still the original v8 bytes.
  const res = await fetch(`${baseUrl}/cas/app-updates/latest.apk`, { headers: DEVICE_HEADERS });
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), APK_V8);
});

test("the newest manifest tracks the highest published versionCode", async () => {
  await publish(APK_V7, "versionCode=7&versionName=0.8.0");
  await publish(APK_V8, "versionCode=8&versionName=0.8.1");
  const manifest = await (
    await fetch(`${baseUrl}/cas/app-updates/manifest`, { headers: DEVICE_HEADERS })
  ).json() as { versionCode: number; sha256: string };
  assert.equal(manifest.versionCode, 8);
  assert.equal(manifest.sha256, sha256(APK_V8));
});

test("invalid publish metadata is a 400, not a stored row", async () => {
  for (const query of [
    "versionName=0.8.0", // missing versionCode
    "versionCode=abc&versionName=0.8.0",
    "versionCode=0&versionName=0.8.0",
    "versionCode=7", // missing versionName
    "versionCode=7&versionName=0.8.0&packageName=not a package",
  ]) {
    const res = await publish(APK_V7, query);
    assert.equal(res.status, 400, `query ${query}`);
  }
  const empty = await fetch(`${baseUrl}/cas/app-updates?versionCode=7&versionName=0.8.0`, {
    method: "POST",
    headers: { ...ENROLLMENT_HEADERS, "content-type": "application/vnd.android.package-archive" },
  });
  assert.equal(empty.status, 400, "an empty body is not a publishable APK");
  assert.equal(await db.select().from(casAppUpdates).then((rows) => rows.length), 0);
});

test("a revoked device credential loses manifest and download access", async () => {
  await publish(APK_V7, "versionCode=7&versionName=0.8.0");
  const shortLived = await issueDeviceCredential("revoked-handset");
  const manifestBefore = await fetch(`${baseUrl}/cas/app-updates/manifest`, {
    headers: { authorization: `Bearer ${shortLived.token}` },
  });
  assert.equal(manifestBefore.status, 200, "the credential works until revoked");
  await revokeDeviceCredential(shortLived.record.id);
  // The gate re-reads the credential table on every request, so the revoked
  // handset is out from its very next call.
  const res = await fetch(`${baseUrl}/cas/app-updates/manifest`, {
    headers: { authorization: `Bearer ${shortLived.token}` },
  });
  assert.equal(res.status, 401);
  const apk = await fetch(`${baseUrl}/cas/app-updates/latest.apk`, {
    headers: { authorization: `Bearer ${shortLived.token}` },
  });
  assert.equal(apk.status, 401);
});
