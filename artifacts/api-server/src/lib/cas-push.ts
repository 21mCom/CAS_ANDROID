import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { casDeviceCredentials, casPushRegistrations } from "@workspace/db/schema";
import { logger } from "./logger";

/**
 * Responder-requested capture wake: high-priority FCM dispatch.
 *
 * Without a push message the handset only honors a responder's capture
 * request on its next server contact (trigger, app resume, or the manual
 * "Check re-queued deliveries"), which can be minutes during a live incident
 * — and an idle phone may also be denied the background mic/camera
 * foreground-service start. A high-priority, data-only FCM message is the
 * documented path that wakes the phone immediately AND grants the
 * background-start exemption for mic/camera capture.
 *
 * Configuration (self-hosting runbook covers provisioning):
 * - CAS_FCM_SERVICE_ACCOUNT_JSON — the Firebase service account JSON, inline.
 * - CAS_FCM_SERVICE_ACCOUNT_FILE — path to that JSON instead (systemd
 *   credentials dir friendly).
 * With neither set the module reports "unconfigured" and the capture-request
 * endpoint journals that polling is the only wake path; nothing else changes.
 *
 * Provider-gateway contract (same invariants as the alert delivery
 * adapters): endpoints are HTTPS-only — plain HTTP is accepted only for
 * loopback test stubs — and redirects are never followed, so a redirect can
 * neither drop the message nor forward the service-account assertion or
 * registration tokens to an unintended origin.
 *
 * Test overrides (loopback stubs): CAS_FCM_TOKEN_URI and CAS_FCM_SEND_URL.
 */

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export type CasPushConfig = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  sendUrl: string;
};

export type CasPushDispatch =
  | { status: "unconfigured" }
  | { status: "no-registrations" }
  | { status: "sent"; delivered: number; staleRemoved: number }
  | { status: "failed"; detail: string };

function assertEndpointUrl(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`${label} must be HTTPS (plain HTTP is only accepted for loopback test stubs)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not embed credentials`);
  }
  return raw;
}

/** Resolve the push configuration from the environment; null = push off. */
export function resolveCasPushConfig(env: NodeJS.ProcessEnv = process.env): CasPushConfig | null {
  const inline = env.CAS_FCM_SERVICE_ACCOUNT_JSON?.trim();
  const file = env.CAS_FCM_SERVICE_ACCOUNT_FILE?.trim();
  if (!inline && !file) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(inline || readFileSync(file!, "utf8"));
  } catch (error) {
    // Fail loud: an operator who configured push expects the wake path; a
    // silent fallback to polling would hide a broken deployment.
    throw new Error(`CAS_FCM_SERVICE_ACCOUNT_* is not readable JSON: ${(error as Error).message}`);
  }
  const projectId = typeof parsed.project_id === "string" ? parsed.project_id : "";
  const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email : "";
  const privateKey = typeof parsed.private_key === "string" ? parsed.private_key : "";
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("CAS_FCM_SERVICE_ACCOUNT_* JSON must contain project_id, client_email, and private_key");
  }
  const tokenUri = env.CAS_FCM_TOKEN_URI?.trim() ||
    (typeof parsed.token_uri === "string" ? parsed.token_uri : "") ||
    DEFAULT_TOKEN_URI;
  const sendUrl = env.CAS_FCM_SEND_URL?.trim() ||
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  return {
    projectId,
    clientEmail,
    privateKey,
    tokenUri: assertEndpointUrl(tokenUri, "FCM token URI"),
    sendUrl: assertEndpointUrl(sendUrl, "FCM send URL"),
  };
}

/** True when a service account is configured and parses — used for status surfaces. */
export function casPushConfigured(): boolean {
  try {
    return resolveCasPushConfig() !== null;
  } catch {
    return false;
  }
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Mint a short-lived OAuth2 access token for the FCM HTTP v1 API. */
export async function fetchFcmAccessToken(config: CasPushConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: config.clientEmail,
    scope: FCM_SCOPE,
    aud: config.tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(config.privateKey, "base64url");
  const response = await fetch(config.tokenUri, {
    method: "POST",
    // Never follow redirects: a redirect can drop the POST body or forward
    // the signed assertion to an unintended origin.
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`FCM token endpoint HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("FCM token endpoint returned no access_token");
  return body.access_token;
}

// The OAuth token is cached process-locally until one minute before expiry;
// a fresh JWT exchange per capture request would add latency to the exact
// path whose whole point is immediacy.
let cachedToken: { value: string; expiresAtMs: number; tokenUri: string } | null = null;

async function accessToken(config: CasPushConfig): Promise<string> {
  if (cachedToken && cachedToken.tokenUri === config.tokenUri && cachedToken.expiresAtMs > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const value = await fetchFcmAccessToken(config);
  cachedToken = { value, expiresAtMs: Date.now() + 3_540_000, tokenUri: config.tokenUri };
  return value;
}

/** Deliver one high-priority, data-only capture-request message to one token. */
export async function deliverCaptureRequestMessage(
  config: CasPushConfig,
  token: string,
  payload: { requestId: string; incidentId: string; kind: string },
): Promise<"delivered" | "stale-token" | { failed: string }> {
  const response = await fetch(config.sendUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${await accessToken(config)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token,
        // Data-only + HIGH priority: no notification is shown; the message
        // wakes the app's messaging service even from idle, and the
        // documented exemption lets it start the mic/camera foreground
        // service from the background.
        android: { priority: "HIGH" },
        data: {
          type: "cas-capture-request",
          requestId: payload.requestId,
          incidentId: payload.incidentId,
          kind: payload.kind,
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) return "delivered";
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  if (response.status === 404 || (response.status === 400 && detail.includes("UNREGISTERED"))) {
    // The app was uninstalled or the token rotated away server-side: drop
    // the registration so later requests stop paying for a dead token.
    return "stale-token";
  }
  return { failed: `FCM send HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
}

/**
 * Send the capture-request wake to every non-revoked registered handset.
 * Never throws — the caller journals the outcome and the request stays
 * PENDING for the polling fallback regardless.
 */
export async function sendCaptureRequestPush(payload: {
  requestId: string;
  incidentId: string;
  kind: string;
}): Promise<CasPushDispatch> {
  let config: CasPushConfig | null;
  try {
    config = resolveCasPushConfig();
  } catch (error) {
    return { status: "failed", detail: (error as Error).message };
  }
  if (!config) return { status: "unconfigured" };
  try {
    const registrations = await db
      .select({ id: casPushRegistrations.id, token: casPushRegistrations.token })
      .from(casPushRegistrations)
      .innerJoin(
        casDeviceCredentials,
        and(
          eq(casPushRegistrations.deviceCredentialId, casDeviceCredentials.id),
          isNull(casDeviceCredentials.revokedAt),
        ),
      );
    if (registrations.length === 0) return { status: "no-registrations" };
    let delivered = 0;
    let staleRemoved = 0;
    const failures: string[] = [];
    for (const registration of registrations) {
      const outcome = await deliverCaptureRequestMessage(config, registration.token, payload);
      if (outcome === "delivered") {
        delivered += 1;
      } else if (outcome === "stale-token") {
        await db.delete(casPushRegistrations).where(eq(casPushRegistrations.id, registration.id));
        staleRemoved += 1;
      } else {
        failures.push(outcome.failed);
      }
    }
    if (delivered === 0 && failures.length > 0) {
      return { status: "failed", detail: failures.join("; ") };
    }
    if (failures.length > 0) {
      logger.warn({ failures, requestId: payload.requestId }, "Some FCM capture wakes failed");
    }
    return { status: "sent", delivered, staleRemoved };
  } catch (error) {
    logger.error({ err: error, requestId: payload.requestId }, "FCM capture wake dispatch failed");
    return { status: "failed", detail: (error as Error).message };
  }
}

/** Test hook: drop the cached OAuth token between configurations. */
export function resetCasPushTokenCache() {
  cachedToken = null;
}
