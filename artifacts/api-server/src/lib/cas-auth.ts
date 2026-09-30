import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { RequestHandler, Response } from "express";
import { db } from "@workspace/db";
import { casAuthFailureStreaks, casDeviceCredentials } from "@workspace/db/schema";
import { logger } from "./logger";

/**
 * Per-device credential gate for every CAS mutation: incident trigger/
 * ack/resolve, outbox re-queue, readiness bootstrap, test incidents,
 * setup/gate edits, and the Gate 0A report import.
 *
 * The shared CAS_ALERT_TOKEN secret no longer authorizes those mutations.
 * It is the *enrollment credential*: its only powers are enrolling a new
 * device credential (POST /cas/devices/enroll), listing them, and revoking
 * one (POST /cas/devices/:id/revoke). Each enrolled device — the owner's
 * phone, each operator console browser — presents its own token as
 * `Authorization: Bearer <token>`, so a lost phone or leaked console
 * session is containable by revoking one row instead of rotating a secret
 * everywhere, and every journaled mutation is attributable to the device
 * that sent it (res.locals.casDevice).
 *
 * Only the SHA-256 hash of a device token is stored; the plaintext is
 * returned once at enrollment. Revocation takes effect on the very next
 * request — the gate reads the credential table on every call and never
 * caches, so there is no revocation-propagation window.
 *
 * Fail closed: with no CAS_ALERT_TOKEN configured the enrollment gate
 * rejects everything, and a server with no enrolled credentials rejects
 * every mutation — a freshly deployed server can never silently run
 * unlocked.
 *
 * Online-guessing tarpit: every credential rejection (here and in the
 * handset device-access gate) additionally passes through
 * delayCasAuthRejection, which slows repeated 401s from one client IP with
 * a doubling delay and emits a distinct burst warn line for log monitoring.
 * Successful credentialed requests are never delayed.
 */

export type CasAuthRejectionReason =
  | "missing-token"
  | "invalid-token"
  | "revoked-token"
  | "enrollment-token-not-authorized"
  | "shared-device-token-retired"
  | "server-not-configured";

export type CasAuthRejection = {
  reason: CasAuthRejectionReason;
  method: string;
  path: string;
  ip: string | undefined;
  // Set when the presented token matched a known (revoked) device
  // credential, so the rejection is attributable too. Never the token.
  deviceId?: string;
};

/** Identity of the enrolled device that authenticated the request. */
export type CasAuthenticatedDevice = {
  id: string;
  label: string;
};

// Rejections are recorded through an injectable sink so tests can prove the
// record happens without scraping logs. The default sink is the structured
// server log; the presented credential is never part of the record.
const defaultRecorder = (rejection: CasAuthRejection) => {
  logger.warn({ casAuthRejection: rejection }, "Rejected unauthenticated CAS mutation");
};

let recordRejection: (rejection: CasAuthRejection) => void = defaultRecorder;

/** Test hook: swap the rejection sink; call with no argument to restore. */
export function setCasAuthRejectionRecorder(
  recorder?: (rejection: CasAuthRejection) => void,
) {
  recordRejection = recorder ?? defaultRecorder;
}

/** Records a rejection produced outside reject() (the handset device-access
 * gate in routes/cas.ts keeps its own 401 bodies) so every credential
 * rejection reaches the same sink. */
export function recordCasCredentialRejection(rejection: CasAuthRejection) {
  recordRejection(rejection);
}

/**
 * Online-guessing tarpit for the credential gates. Self-hosting puts these
 * endpoints on a public URL; the tokens are high-entropy, but repeated 401s
 * from one client IP should still cost the guesser exponentially more time,
 * and a sustained burst should surface as a distinct log line that uptime/log
 * monitoring can alert on.
 *
 * Design: only *rejection responses* are delayed (never successful
 * credentialed requests), so legitimate polling — console state reads every
 * few seconds, outbox status every 12s — is never slowed, even from an IP
 * with a live failure streak. The delay doubles per consecutive failure from
 * the same IP (first failure answers at full speed so an honest typo is not
 * punished), capped at maxDelayMs; a streak decays after resetWindowMs of
 * quiet. Every burstThreshold consecutive failures emits one burst record.
 *
 * Keyed on req.ip: a self-hosting deployment behind a reverse proxy must set
 * Express `trust proxy` for the limiter to see real client addresses.
 *
 * Streaks live in the shared cas_auth_failure_streaks table, not in process
 * memory: when a deployment runs more than one API replica behind a load
 * balancer, every replica upserts the same row atomically, so a guesser's
 * failures are never diluted across processes and the doubling delay and
 * burst alert enforce one global streak per visitor IP.
 */
export type CasAuthFailureBurst = {
  ip: string;
  failures: number;
  windowMs: number;
};

export type CasAuthFailureLimitConfig = {
  /** Delay for the second consecutive failure; doubles per failure. */
  baseDelayMs: number;
  /** Cap on the per-response delay. */
  maxDelayMs: number;
  /** Consecutive failures from one IP that constitute an alertable burst. */
  burstThreshold: number;
  /** Quiet period after which an IP's streak decays back to zero. */
  resetWindowMs: number;
};

const DEFAULT_FAILURE_LIMIT_CONFIG: CasAuthFailureLimitConfig = {
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  burstThreshold: 10,
  resetWindowMs: 10 * 60_000,
};

let failureLimitConfig: CasAuthFailureLimitConfig = { ...DEFAULT_FAILURE_LIMIT_CONFIG };

// The burst sink is injectable for the same reason as the rejection sink:
// tests prove the alert fires without scraping logs. The default is one
// distinct structured warn line per threshold crossing.
const defaultBurstRecorder = (burst: CasAuthFailureBurst) => {
  logger.warn({ casAuthRejectionBurst: burst }, "CAS credential rejection burst detected");
};

let recordBurst: (burst: CasAuthFailureBurst) => void = defaultBurstRecorder;

/** Test hook: swap the burst sink; call with no argument to restore. */
export function setCasAuthBurstRecorder(
  recorder?: (burst: CasAuthFailureBurst) => void,
) {
  recordBurst = recorder ?? defaultBurstRecorder;
}

/** Test/ops hook: override the delay schedule; call with no argument to restore defaults. */
export function setCasAuthFailureLimitConfig(config?: Partial<CasAuthFailureLimitConfig>) {
  failureLimitConfig = { ...DEFAULT_FAILURE_LIMIT_CONFIG, ...config };
}

/** Test hook: forget all recorded failure streaks. */
export async function resetCasAuthFailureTracking() {
  await db.delete(casAuthFailureStreaks);
}

function clientIpKey(req: Parameters<RequestHandler>[0]): string {
  return req.ip ?? "unknown";
}

// The streak row is written with one atomic INSERT ... ON CONFLICT, so two
// replicas (or two requests) rejecting at the same moment both count — a
// read-modify-write here would let concurrent failures share one increment.
// A streak whose last failure is older than the reset window decays back to
// 1 on the next failure, matching the in-memory predecessor's semantics.
async function recordFailureStreak(key: string): Promise<number> {
  const windowMs = failureLimitConfig.resetWindowMs;
  const [row] = await db
    .insert(casAuthFailureStreaks)
    .values({ ip: key, count: 1 })
    .onConflictDoUpdate({
      target: casAuthFailureStreaks.ip,
      set: {
        count: sql`case when now() - ${casAuthFailureStreaks.lastFailureAt} > (${windowMs}::double precision * interval '1 millisecond') then 1 else ${casAuthFailureStreaks.count} + 1 end`,
        lastFailureAt: sql`now()`,
      },
    })
    .returning({ count: casAuthFailureStreaks.count });
  return row.count;
}

// Bound the table under a flood of spoofed/source-NATted addresses: stale
// rows are worthless, so sweep them occasionally. Probabilistic (any replica
// sweeping suffices) so the rejection path does not pay a DELETE per request.
let sweepCounter = 0;
function sweepStaleFailureStreaks() {
  if (++sweepCounter % 64 !== 0) return;
  const windowMs = failureLimitConfig.resetWindowMs;
  db.delete(casAuthFailureStreaks)
    .where(
      sql`${casAuthFailureStreaks.lastFailureAt} < now() - (${windowMs}::double precision * interval '1 millisecond')`,
    )
    .catch((error) => {
      logger.warn({ err: error }, "CAS auth failure-streak sweep failed");
    });
}

/** Response delay for the n-th consecutive failure from one IP: the first is free, then doubling. */
export function casAuthFailureDelayMs(streak: number): number {
  if (streak <= 1) return 0;
  return Math.min(
    failureLimitConfig.baseDelayMs * 2 ** (streak - 2),
    failureLimitConfig.maxDelayMs,
  );
}

/**
 * Records a credential rejection for the client IP, emits a burst record at
 * each threshold multiple, and holds the response for the streak's delay.
 * Call exactly once per rejection, before sending the 401 body.
 */
export async function delayCasAuthRejection(req: Parameters<RequestHandler>[0]): Promise<void> {
  const key = clientIpKey(req);
  let streak: number;
  try {
    streak = await recordFailureStreak(key);
    sweepStaleFailureStreaks();
  } catch (error) {
    // The tarpit is hardening around the gate, not the gate itself: a
    // streak-store outage must never turn a credential rejection into a
    // 500. The 401 still goes out undelayed, and the warn line keeps the
    // unprotected window visible to log monitoring.
    logger.warn({ err: error }, "CAS auth failure-streak store unavailable; rejection not tarpitted");
    return;
  }
  if (streak % failureLimitConfig.burstThreshold === 0) {
    recordBurst({ ip: key, failures: streak, windowMs: failureLimitConfig.resetWindowMs });
  }
  const delayMs = casAuthFailureDelayMs(streak);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const ERROR_BY_REASON: Record<CasAuthRejectionReason, string> = {
  "missing-token":
    "This endpoint requires an enrolled-device alert credential (Authorization: Bearer <token>); enroll one via POST /api/cas/devices/enroll.",
  "invalid-token": "The presented alert credential was rejected.",
  "revoked-token":
    "The presented device credential has been revoked; enroll a new device credential via POST /api/cas/devices/enroll.",
  "enrollment-token-not-authorized":
    "That is the enrollment credential (CAS_ALERT_TOKEN); it only authorizes enrolling, listing, and revoking device credentials. Present an enrolled device credential instead.",
  "shared-device-token-retired":
    "The shared device token is retired once device credentials are enrolled; present an enrolled device credential (Authorization: Bearer).",
  "server-not-configured":
    "The enrollment credential is not configured on the server (CAS_ALERT_TOKEN); refusing all device-credential management and failing closed.",
};

function bearerToken(req: Parameters<RequestHandler>[0]): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1]?.trim();
}

async function reject(
  res: Response,
  req: Parameters<RequestHandler>[0],
  reason: CasAuthRejectionReason,
  deviceId?: string,
) {
  recordRejection({
    reason,
    method: req.method,
    path: `${req.baseUrl}${req.path}`,
    ip: req.ip,
    ...(deviceId ? { deviceId } : {}),
  });
  // Tarpit repeated failures from this IP before the response goes out;
  // successful credentialed requests never pass through here.
  await delayCasAuthRejection(req);
  res.setHeader("WWW-Authenticate", 'Bearer realm="cas"');
  return res.status(401).json({ error: ERROR_BY_REASON[reason] });
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Looks up an enrolled credential by its plaintext token (hashed here). */
export async function findDeviceCredentialByToken(token: string) {
  const [credential] = await db
    .select()
    .from(casDeviceCredentials)
    .where(eq(casDeviceCredentials.tokenHash, hashDeviceToken(token)))
    .limit(1);
  return credential;
}

/**
 * Issues a fresh enrolled-device credential: mints a high-entropy token,
 * stores only its hash, and returns the plaintext exactly once. Callers
 * must hand the token to the device and never log or journal it.
 */
export async function issueDeviceCredential(label: string) {
  const token = `casdev_${randomBytes(24).toString("hex")}`;
  const id = `dev-${randomBytes(8).toString("hex")}`;
  const [record] = await db
    .insert(casDeviceCredentials)
    .values({ id, label, tokenHash: hashDeviceToken(token) })
    .returning();
  return { record, token };
}

/**
 * Revokes a credential by id. Returns the updated record, or undefined when
 * no such credential exists. Re-revoking is a no-op that keeps the original
 * revocation time.
 */
export async function revokeDeviceCredential(id: string) {
  const [existing] = await db
    .select()
    .from(casDeviceCredentials)
    .where(eq(casDeviceCredentials.id, id))
    .limit(1);
  if (!existing) return undefined;
  if (existing.revokedAt) return existing;
  const [updated] = await db
    .update(casDeviceCredentials)
    .set({ revokedAt: new Date() })
    .where(eq(casDeviceCredentials.id, id))
    .returning();
  return updated;
}

/** Operator-facing list; never includes the token hash. */
export async function listDeviceCredentials() {
  const rows = await db.select().from(casDeviceCredentials);
  return rows.map(({ id, label, createdAt, lastUsedAt, revokedAt }) => ({
    id,
    label,
    createdAt,
    lastUsedAt,
    revokedAt,
  }));
}

/**
 * True once any device credential row exists, active or revoked (revocation
 * keeps the row). Used to retire the legacy shared-device-token fallback on
 * the handset endpoints: after the first enrollment, only enrolled Bearer
 * credentials authorize pickup and receipts.
 */
export async function anyDeviceCredentialExists(): Promise<boolean> {
  const rows = await db.select({ id: casDeviceCredentials.id }).from(casDeviceCredentials).limit(1);
  return rows.length > 0;
}

/** Reads the authenticated device identity the gate attached. */
export function casDeviceFrom(res: Response): CasAuthenticatedDevice {
  return res.locals.casDevice as CasAuthenticatedDevice;
}

// Typed as RequestHandler (not a plain function) so route-specific param
// inference (req.params.id) is preserved on the handlers it guards.
export const requireCasCredential: RequestHandler = async (req, res, next) => {
  const presented = bearerToken(req);
  if (!presented) {
    return reject(res, req, "missing-token");
  }

  const credential = await findDeviceCredentialByToken(presented);

  if (!credential) {
    // A presenter holding the (valid) enrollment credential gets a
    // distinguishing rejection so operators learn the shared token retired
    // instead of seeing an opaque invalid-token. This reveals nothing: the
    // presenter already holds the value being compared.
    const enrollmentToken = process.env.CAS_ALERT_TOKEN?.trim();
    const reason: CasAuthRejectionReason =
      enrollmentToken && tokensEqual(presented, enrollmentToken)
        ? "enrollment-token-not-authorized"
        : "invalid-token";
    return reject(res, req, reason);
  }
  if (credential.revokedAt) {
    return reject(res, req, "revoked-token", credential.id);
  }

  res.locals.casDevice = { id: credential.id, label: credential.label } satisfies CasAuthenticatedDevice;
  // Awaited (not fire-and-forget) so tests observe a settled database; one
  // PK update is negligible next to the mutation the request is about to do.
  await db
    .update(casDeviceCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(casDeviceCredentials.id, credential.id));
  return next();
};

/**
 * Gate for device-credential management (enroll/list/revoke). Only the
 * shared CAS_ALERT_TOKEN enrollment credential passes — deliberately NOT an
 * enrolled device token, so a leaked device credential cannot mint more
 * credentials and escalate itself.
 */
export const requireCasEnrollmentCredential: RequestHandler = async (req, res, next) => {
  const configured = process.env.CAS_ALERT_TOKEN?.trim();
  const presented = bearerToken(req);

  const reason: CasAuthRejectionReason | null = !configured
    ? "server-not-configured"
    : !presented
      ? "missing-token"
      : !tokensEqual(presented, configured)
        ? "invalid-token"
        : null;

  if (reason) {
    return reject(res, req, reason);
  }
  return next();
};
