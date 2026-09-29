/**
 * In-process health registry for the CAS email alert channel.
 *
 * The email channel depends on a mailbox app password that can silently rot
 * (revoked, expired for inactivity, invalidated by a password reset). The
 * outbox worker heartbeats itself but would only discover a dead mailbox
 * when a real alert dead-letters — during the incident that needed it. The
 * probe worker (lib/cas-email-health-worker.ts) therefore authenticates
 * against the configured mailbox on a low-frequency schedule and records
 * the outcome here; the /api/cas/outbox/status route (routes/cas.ts) ships
 * it to the console, which turns a failed probe into a visible warning
 * while a dead mailbox is still harmless.
 *
 * This mirrors lib/cas-outbox-status.ts: process-local on purpose (it
 * reports this deployment's mailbox reachability), in its own module to
 * avoid a circular import between the worker and the router.
 *
 * The registry never stores credentials — only classifications, timestamps,
 * and the already-redacted error text produced by cas-smtp.ts.
 */

/** Probe lifecycle: "pending" until the first probe finishes, then the last outcome. */
export type CasEmailProbeState = "pending" | "ok" | "failed" | "skipped";

/**
 * What the most recent probe authenticated against: a console-managed
 * account row, the CAS_EMAIL_SMTP_* environment, or "none" when there is no
 * SMTP target (HTTPS provider, or email not configured).
 */
export type CasEmailProbeTarget = "console" | "environment" | "none";

export interface CasEmailChannelHealth {
  /** Configured probe interval in milliseconds. */
  probeIntervalMs: number;
  /** ISO timestamps — serialized ready for the status endpoint. */
  startedAt: string;
  state: CasEmailProbeState;
  target: CasEmailProbeTarget;
  lastProbeAt: string | null;
  lastOkAt: string | null;
  /** Most recent probe failure; kept after recovery so history is inspectable. */
  lastFailure: { classification: string; message: string; at: string } | null;
  /** Why probing does not apply right now (HTTPS provider / unconfigured). */
  note: string | null;
  stoppedAt: string | null;
}

let health: CasEmailChannelHealth | null = null;

export function registerCasEmailChannelHealth(init: { probeIntervalMs: number }): void {
  health = {
    probeIntervalMs: init.probeIntervalMs,
    startedAt: new Date().toISOString(),
    state: "pending",
    target: "none",
    lastProbeAt: null,
    lastOkAt: null,
    lastFailure: null,
    note: null,
    stoppedAt: null,
  };
}

export function recordCasEmailProbeOk(target: Exclude<CasEmailProbeTarget, "none">): void {
  if (!health) return;
  const now = new Date().toISOString();
  health.state = "ok";
  health.target = target;
  health.lastProbeAt = now;
  health.lastOkAt = now;
  health.note = null;
}

export function recordCasEmailProbeFailure(
  target: Exclude<CasEmailProbeTarget, "none">,
  failure: { classification: string; message: string },
): void {
  if (!health) return;
  const now = new Date().toISOString();
  health.state = "failed";
  health.target = target;
  health.lastProbeAt = now;
  health.lastFailure = { ...failure, at: now };
  health.note = null;
}

/** No SMTP target this tick (HTTPS provider or email unconfigured): not a failure. */
export function recordCasEmailProbeSkipped(note: string): void {
  if (!health) return;
  health.state = "skipped";
  health.target = "none";
  health.note = note;
}

export function markCasEmailProbeStopped(): void {
  if (!health) return;
  health.stoppedAt = new Date().toISOString();
}

export function getCasEmailChannelHealth(): CasEmailChannelHealth | null {
  return health ? { ...health } : null;
}

/** Test-only: clears the registry so probe tests do not leak state. */
export function resetCasEmailChannelHealth(): void {
  health = null;
}
