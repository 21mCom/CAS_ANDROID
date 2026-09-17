import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { logger } from "./logger";

/**
 * Credential gate for every CAS mutation: incident trigger/ack/resolve,
 * outbox re-queue, readiness bootstrap, test incidents, setup/gate edits,
 * and the Gate 0A report import. The enrolled phone and the operator console
 * both present the shared alert token as `Authorization: Bearer <token>`;
 * the token lives in the CAS_ALERT_TOKEN secret on the server and is entered
 * on each client.
 *
 * Fail closed: with no CAS_ALERT_TOKEN configured every guarded request is
 * rejected, so a freshly deployed server can never silently run unlocked.
 */

export type CasAuthRejectionReason =
  | "missing-token"
  | "invalid-token"
  | "server-not-configured";

export type CasAuthRejection = {
  reason: CasAuthRejectionReason;
  method: string;
  path: string;
  ip: string | undefined;
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

function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const ERROR_BY_REASON: Record<CasAuthRejectionReason, string> = {
  "missing-token":
    "This endpoint requires the enrolled-device alert credential (Authorization: Bearer <token>).",
  "invalid-token": "The presented alert credential was rejected.",
  "server-not-configured":
    "The alert credential is not configured on the server (CAS_ALERT_TOKEN); refusing all alert mutations.",
};

// Typed as RequestHandler (not a plain function) so route-specific param
// inference (req.params.id) is preserved on the handlers it guards.
export const requireCasCredential: RequestHandler = (req, res, next) => {
  const configured = process.env.CAS_ALERT_TOKEN?.trim();
  const presented = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1]?.trim();

  const reason: CasAuthRejectionReason | null = !configured
    ? "server-not-configured"
    : !presented
      ? "missing-token"
      : !tokensEqual(presented, configured)
        ? "invalid-token"
        : null;

  if (reason) {
    recordRejection({
      reason,
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      ip: req.ip,
    });
    res.setHeader("WWW-Authenticate", 'Bearer realm="cas"');
    return res.status(401).json({ error: ERROR_BY_REASON[reason] });
  }
  return next();
};
