import { Router, type IRouter } from "express";

/**
 * Dev-only in-process delivery-provider sink.
 *
 * Stands in for real SMS/XMPP/email provider endpoints so the outbox worker's
 * gateway path can be exercised end-to-end (claim -> provider POST -> SENT)
 * without any third-party account. Enabled only when NODE_ENV is not
 * "production" AND CAS_DEV_PROVIDER_SINK=1; point CAS_*_PROVIDER_URL at
 * http://127.0.0.1:<port>/api/cas/dev/provider-inbox/<channel> (loopback HTTP
 * is the one plain-HTTP exception the provider adapters allow).
 *
 * The sink honors the gateway idempotency contract from
 * lib/delivery-providers.ts: a repeated Idempotency-Key gets 409 with
 * X-Idempotency-Replayed: true so a retry counts as delivered instead of
 * double-sending. For the failure drill, a submission whose alert body
 * contains "[sink-fail]" gets a 500 so the operator can watch the outbox mark
 * FAILED and back off.
 *
 * Deliveries live in memory only and are listed/cleared through GET/DELETE on
 * the same path, so the handoff test kit can assert exactly what would have
 * been sent.
 */
export type SinkDelivery = {
  channel: string;
  idempotencyKey: string | null;
  authorized: boolean;
  payload: unknown;
  receivedAt: string;
};

const deliveries: SinkDelivery[] = [];
const acceptedKeys = new Set<string>();
// In-memory bound so a long-running dev server cannot accumulate deliveries
// without limit; drills clear the inbox between runs anyway.
const MAX_DELIVERIES = 500;

export function devProviderSinkEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return process.env.NODE_ENV !== "production" && env.CAS_DEV_PROVIDER_SINK === "1";
}

export function createDevProviderSinkRouter(): IRouter {
  const router = Router();

  router.post("/cas/dev/provider-inbox/:channel", (req, res) => {
    const channel = String(req.params.channel ?? "").toUpperCase();
    if (!/^[A-Z0-9_-]{1,20}$/.test(channel)) {
      return res.status(400).json({ error: "Invalid sink channel" });
    }
    const key = req.header("idempotency-key") ?? null;
    const payload = (req.body ?? {}) as { body?: unknown };
    if (typeof payload.body === "string" && payload.body.includes("[sink-fail]")) {
      return res.status(500).json({ error: "sink-fail marker present in alert body" });
    }
    if (key && acceptedKeys.has(key)) {
      res.setHeader("x-idempotency-replayed", "true");
      return res.status(409).json({ error: "idempotency key already accepted", replayed: true });
    }
    if (key) acceptedKeys.add(key);
    deliveries.push({
      channel,
      idempotencyKey: key,
      authorized: Boolean(req.header("authorization")),
      payload,
      receivedAt: new Date().toISOString(),
    });
    if (deliveries.length > MAX_DELIVERIES) {
      deliveries.splice(0, deliveries.length - MAX_DELIVERIES);
    }
    return res.status(202).json({ accepted: true, channel });
  });

  router.get("/cas/dev/provider-inbox", (_req, res) => {
    return res.json({ deliveries });
  });

  router.delete("/cas/dev/provider-inbox", (_req, res) => {
    deliveries.length = 0;
    acceptedKeys.clear();
    return res.json({ cleared: true });
  });

  return router;
}
