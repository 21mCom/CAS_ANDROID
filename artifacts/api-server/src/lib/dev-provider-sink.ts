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
/**
 * Response header (value "true") the sink sends on every accepted submission
 * — including idempotent replays — so the provider adapters can record that
 * the alert went to the built-in test inbox, not a real provider. The console
 * then labels the delivery as simulated instead of showing a bare SENT.
 */
export const DEV_PROVIDER_SINK_HEADER = "x-cas-dev-provider-sink";

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

/**
 * Records a delivery in the sink inbox with the same dedup contract as the
 * HTTP endpoint: a repeated idempotency key is a replay (returned as such,
 * not double-counted). Shared by the HTTP router and by the in-process test
 * harness sink adapters (delivery-providers.ts), so a forced-sink test run
 * and a sink-URL drill leave the same evidence in the same inbox.
 */
export function recordDevSinkDelivery(entry: {
  channel: string;
  idempotencyKey: string | null;
  authorized: boolean;
  payload: unknown;
}): { replayed: boolean } {
  if (entry.idempotencyKey && acceptedKeys.has(entry.idempotencyKey)) {
    return { replayed: true };
  }
  if (entry.idempotencyKey) acceptedKeys.add(entry.idempotencyKey);
  deliveries.push({
    channel: entry.channel,
    idempotencyKey: entry.idempotencyKey,
    authorized: entry.authorized,
    payload: entry.payload,
    receivedAt: new Date().toISOString(),
  });
  if (deliveries.length > MAX_DELIVERIES) {
    deliveries.splice(0, deliveries.length - MAX_DELIVERIES);
  }
  return { replayed: false };
}

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
    const recorded = recordDevSinkDelivery({
      channel,
      idempotencyKey: key,
      authorized: Boolean(req.header("authorization")),
      payload,
    });
    // A replayed acceptance still went to the test inbox — carry the sink
    // marker so the retried delivery is labeled simulated too.
    res.setHeader(DEV_PROVIDER_SINK_HEADER, "true");
    if (recorded.replayed) {
      res.setHeader("x-idempotency-replayed", "true");
      return res.status(409).json({ error: "idempotency key already accepted", replayed: true, sink: "dev-provider-inbox" });
    }
    return res.status(202).json({ accepted: true, channel, sink: "dev-provider-inbox" });
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
