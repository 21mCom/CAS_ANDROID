import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  deliverCaptureRequestMessage,
  fetchFcmAccessToken,
  resolveCasPushConfig,
  type CasPushConfig,
} from "./cas-push";

// Pure contract tests for the FCM push module: no database. The stub stands
// in for Google's token/send endpoints over loopback HTTP — the only place
// plain HTTP is allowed — and cryptographically verifies the service-account
// JWT instead of trusting its shape.

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = {
  project_id: "cas-test-project",
  client_email: "cas-push@cas-test-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
};

type StubRequest = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

async function withStub(
  handler: (req: StubRequest, respond: (status: number, body: unknown) => void) => void,
  run: (baseUrl: string, requests: StubRequest[]) => Promise<void>,
): Promise<void> {
  const requests: StubRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const record = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(record);
      handler(record, (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    server.close();
    await once(server, "close");
  }
}

const configWith = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv => ({
  CAS_FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
  ...overrides,
});

test("resolveCasPushConfig returns null when no service account is configured", () => {
  assert.equal(resolveCasPushConfig({}), null);
});

test("resolveCasPushConfig builds the v1 send URL from the project id and defaults the token URI", () => {
  const config = resolveCasPushConfig(configWith({}));
  assert.equal(config?.projectId, "cas-test-project");
  assert.equal(config?.tokenUri, "https://oauth2.googleapis.com/token");
  assert.equal(
    config?.sendUrl,
    "https://fcm.googleapis.com/v1/projects/cas-test-project/messages:send",
  );
});

test("resolveCasPushConfig fails loud on unreadable or incomplete service account JSON", () => {
  assert.throws(() => resolveCasPushConfig({ CAS_FCM_SERVICE_ACCOUNT_JSON: "{not json" }), /not readable JSON/);
  assert.throws(
    () => resolveCasPushConfig({ CAS_FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "x" }) }),
    /project_id, client_email, and private_key/,
  );
  assert.throws(
    () => resolveCasPushConfig({ CAS_FCM_SERVICE_ACCOUNT_FILE: "/nonexistent/service-account.json" }),
    /not readable JSON/,
  );
});

test("endpoint overrides must be HTTPS — plain HTTP is only accepted for loopback test stubs", () => {
  assert.throws(
    () => resolveCasPushConfig(configWith({ CAS_FCM_SEND_URL: "http://fcm.example.com/send" })),
    /must be HTTPS/,
  );
  assert.throws(
    () => resolveCasPushConfig(configWith({ CAS_FCM_TOKEN_URI: "http://10.1.2.3/token" })),
    /must be HTTPS/,
  );
  assert.throws(
    () => resolveCasPushConfig(configWith({ CAS_FCM_SEND_URL: "https://user:pw@fcm.googleapis.com/x" })),
    /must not embed credentials/,
  );
  const loopback = resolveCasPushConfig(configWith({
    CAS_FCM_TOKEN_URI: "http://127.0.0.1:1/token",
    CAS_FCM_SEND_URL: "http://localhost:1/send",
  }));
  assert.equal(loopback?.tokenUri, "http://127.0.0.1:1/token");
  assert.equal(loopback?.sendUrl, "http://localhost:1/send");
});

test("fetchFcmAccessToken posts a verifiably signed RS256 service-account JWT", async () => {
  await withStub(
    (req, respond) => {
      assert.equal(req.url, "/token");
      const params = new URLSearchParams(req.body);
      const assertion = params.get("assertion") ?? "";
      const [header, claims, signature] = assertion.split(".");
      // The stub verifies the signature cryptographically — a malformed or
      // wrongly-keyed JWT fails here, not in front of Google.
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${header}.${claims}`);
      assert.ok(verifier.verify(publicKey, signature, "base64url"), "JWT signature must verify against the service-account key");
      const payload = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
      assert.equal(payload.iss, serviceAccount.client_email);
      assert.match(payload.scope, /firebase\.messaging/);
      respond(200, { access_token: "stub-access-token", expires_in: 3599 });
    },
    async (baseUrl, requests) => {
      const config = resolveCasPushConfig(configWith({ CAS_FCM_TOKEN_URI: `${baseUrl}/token` }))!;
      const token = await fetchFcmAccessToken(config);
      assert.equal(token, "stub-access-token");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "POST");
      assert.match(requests[0].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
    },
  );
});

test("fetchFcmAccessToken fails loud when the token endpoint rejects the exchange", async () => {
  await withStub(
    (_req, respond) => respond(403, { error: "access_denied" }),
    async (baseUrl) => {
      const config = resolveCasPushConfig(configWith({ CAS_FCM_TOKEN_URI: `${baseUrl}/token` }))!;
      await assert.rejects(() => fetchFcmAccessToken(config), /HTTP 403/);
    },
  );
});

const payload = { requestId: "capreq-1", incidentId: "inc-1", kind: "audio" };

function sendConfig(baseUrl: string, accessToken: string): CasPushConfig {
  // deliverCaptureRequestMessage goes through the cached token path; seed it
  // by pointing the token URI at the stub too and serving a fixed token.
  void accessToken;
  return {
    ...resolveCasPushConfig(configWith({
      CAS_FCM_TOKEN_URI: `${baseUrl}/token`,
      CAS_FCM_SEND_URL: `${baseUrl}/send`,
    }))!,
  };
}

test("deliverCaptureRequestMessage sends a high-priority, data-only message addressed to the registration token", async () => {
  await withStub(
    (req, respond) => {
      if (req.url === "/token") return respond(200, { access_token: "stub-access-token" });
      respond(200, { name: "projects/cas-test-project/messages/1" });
    },
    async (baseUrl, requests) => {
      const config = sendConfig(baseUrl, "stub-access-token");
      const outcome = await deliverCaptureRequestMessage(config, "fcm-registration-token-abc", payload);
      assert.equal(outcome, "delivered");
      const send = requests.find((req) => req.url === "/send")!;
      assert.equal(send.headers.authorization, "Bearer stub-access-token");
      const body = JSON.parse(send.body);
      assert.equal(body.message.token, "fcm-registration-token-abc");
      assert.equal(body.message.android.priority, "HIGH");
      assert.deepEqual(body.message.data, {
        type: "cas-capture-request",
        requestId: "capreq-1",
        incidentId: "inc-1",
        kind: "audio",
      });
      // Data-only: no notification key, so nothing is ever shown on screen.
      assert.equal(body.message.notification, undefined);
    },
  );
});

test("deliverCaptureRequestMessage classifies an unregistered token as stale and other failures as failed", async () => {
  await withStub(
    (req, respond) => {
      if (req.url === "/token") return respond(200, { access_token: "stub-access-token" });
      if (req.url === "/send-stale") return respond(404, { error: { status: "NOT_FOUND" } });
      if (req.url === "/send-unregistered") {
        return respond(400, { error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "UNREGISTERED" }] } });
      }
      respond(500, { error: "backend exploded" });
    },
    async (baseUrl) => {
      const config = sendConfig(baseUrl, "stub-access-token");
      assert.equal(
        await deliverCaptureRequestMessage({ ...config, sendUrl: `${baseUrl}/send-stale` }, "tok", payload),
        "stale-token",
      );
      assert.equal(
        await deliverCaptureRequestMessage({ ...config, sendUrl: `${baseUrl}/send-unregistered` }, "tok", payload),
        "stale-token",
      );
      const failed = await deliverCaptureRequestMessage({ ...config, sendUrl: `${baseUrl}/send` }, "tok", payload);
      assert.ok(typeof failed === "object" && /HTTP 500/.test(failed.failed));
    },
  );
});

test("redirects are never followed — a redirecting endpoint is a failure, not a delivery", async () => {
  await withStub(
    (req, respond) => {
      if (req.url === "/token") return respond(200, { access_token: "stub-access-token" });
      respond(302, "");
    },
    async (baseUrl) => {
      const config = sendConfig(baseUrl, "stub-access-token");
      await assert.rejects(
        () => deliverCaptureRequestMessage(config, "tok", payload),
        /redirect|unexpected|fetch failed/i,
      );
    },
  );
});
