import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import express from "express";
import { randomUUID } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  casCapturePolicy,
  casCaptureRequests,
  casEvidence,
  casIncidentEvents,
  casIncidents,
} from "@workspace/db/schema";
import { z } from "zod";
import {
  casDeviceFrom,
  delayCasAuthRejection,
  findDeviceCredentialByToken,
  recordCasCredentialRejection,
  requireCasCredential,
} from "../lib/cas-auth";
import { sendCaptureRequestPush } from "../lib/cas-push";

const router: IRouter = Router();

/**
 * Evidence capture playground: bounded audio/photo/video clips the handset
 * records after a trigger (or on a responder's request) and uploads here,
 * attached to the incident. The capture policy (per-type toggle plus
 * immediate/screen-off timing) is set from the console and fetched by the
 * handset on every trigger and server contact, so policy changes take effect
 * with no app reinstall.
 *
 * Auth model:
 * - Handset endpoints (upload, pending capture requests, acks) require an
 *   enrolled, non-revoked device credential (Authorization: Bearer). Unlike
 *   the older delivery endpoints they have no shared-token fallback — no
 *   evidence-capable handset predates enrollment, so revocation fails closed
 *   by construction and a revoked phone cannot resume uploading by falling
 *   back to the shared device token.
 * - Policy reads are anonymous (console /cas/state posture); writes and the
 *   download endpoint require an enrolled console credential.
 */

export const CAPTURE_KINDS = ["audio", "photo", "video"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export const CAPTURE_SETTINGS = ["off", "trigger", "responder"] as const;
export type CaptureSetting = (typeof CAPTURE_SETTINGS)[number];

export const CAPTURE_TIMINGS = ["immediate", "screen-off"] as const;
export type CaptureTiming = (typeof CAPTURE_TIMINGS)[number];

// Camera selection for photo/video: "back" (the original behavior), "front",
// or "both" — front and back captured on handsets with concurrent-camera
// support; the handset journals an honest degradation on handsets without it.
export const CAPTURE_CAMERAS = ["back", "front", "both"] as const;
export type CaptureCamera = (typeof CAPTURE_CAMERAS)[number];

// Per-artifact camera label on uploads: the lens a photo/video clip actually
// came from. Audio clips and older APKs omit it (stored as null).
export const EVIDENCE_CAMERAS = ["back", "front"] as const;
export type EvidenceCamera = (typeof EVIDENCE_CAMERAS)[number];

// Uploads are bounded clips by design (rolling audio segments, one still,
// one short video); 48 MB is generous headroom, not a streaming budget.
const MAX_EVIDENCE_BYTES = 48 * 1024 * 1024;

const CONTENT_TYPES: Record<CaptureKind, Set<string>> = {
  audio: new Set(["audio/mp4", "audio/aac", "audio/m4a", "audio/x-m4a", "application/octet-stream"]),
  photo: new Set(["image/jpeg", "application/octet-stream"]),
  video: new Set(["video/mp4", "application/octet-stream"]),
};

const DEFAULT_POLICY = {
  audio: "off" as CaptureSetting,
  photo: "off" as CaptureSetting,
  video: "off" as CaptureSetting,
  timing: "immediate" as CaptureTiming,
  camera: "back" as CaptureCamera,
};

/**
 * Device gate for the handset evidence endpoints. Unlike the older delivery
 * endpoints — which keep a shared-token fallback for APKs already in the
 * field — the evidence endpoints are new: no handset in the field predates
 * enrollment, so they accept ONLY an enrolled, non-revoked device credential
 * as `Authorization: Bearer`. That makes revocation fail closed by
 * construction: a revoked handset's next request is 401, and presenting the
 * shared device token afterwards cannot reopen evidence upload or
 * capture-request pickup. Returns true when the request may proceed.
 *
 * Every 401 passes through the same rejection sink and per-IP tarpit as the
 * other credential gates (see cas-auth.ts): without it these public
 * endpoints would be a faster, quieter guessing oracle than the gates that
 * already slow repeated failures.
 */
export async function requireEnrolledDevice(req: Request, res: Response): Promise<boolean> {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1]?.trim();
  const credential = bearer ? await findDeviceCredentialByToken(bearer) : null;
  if (!credential || credential.revokedAt) {
    recordCasCredentialRejection({
      reason: !bearer ? "missing-token" : !credential ? "invalid-token" : "revoked-token",
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      ip: req.ip,
      ...(credential?.revokedAt ? { deviceId: credential.id } : {}),
    });
    await delayCasAuthRejection(req);
    res.status(401).json({ error: "Evidence endpoints require an enrolled, non-revoked device credential (Authorization: Bearer); enroll via POST /api/cas/devices/enroll. The shared device token is not accepted here." });
    return false;
  }
  return true;
}

const policyBodySchema = z.object({
  audio: z.enum(CAPTURE_SETTINGS),
  photo: z.enum(CAPTURE_SETTINGS),
  video: z.enum(CAPTURE_SETTINGS),
  timing: z.enum(CAPTURE_TIMINGS),
  camera: z.enum(CAPTURE_CAMERAS),
});

async function readPolicy() {
  const rows = await db.select().from(casCapturePolicy).where(eq(casCapturePolicy.id, "current")).limit(1);
  const row = rows[0];
  if (!row) return { ...DEFAULT_POLICY, updatedAt: null as string | null };
  const setting = (value: string): CaptureSetting =>
    (CAPTURE_SETTINGS as readonly string[]).includes(value) ? (value as CaptureSetting) : "off";
  const timing = (value: string): CaptureTiming =>
    (CAPTURE_TIMINGS as readonly string[]).includes(value) ? (value as CaptureTiming) : "immediate";
  const camera = (value: string): CaptureCamera =>
    (CAPTURE_CAMERAS as readonly string[]).includes(value) ? (value as CaptureCamera) : "back";
  return {
    audio: setting(row.audio),
    photo: setting(row.photo),
    video: setting(row.video),
    timing: timing(row.timing),
    camera: camera(row.camera),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Policy reads are credentialed like every other console read (the policy
// reveals the system's capture posture); the handset already presents its
// enrolled credential on this GET and falls back to the cached policy when
// it is rejected. Writes ride the same gate below.
router.get("/cas/evidence-policy", requireCasCredential, async (_req, res, next) => {
  try {
    return res.json(await readPolicy());
  } catch (error) { return next(error); }
});

// Console-only: policy changes are an operator mutation, so they ride the
// same credential gate as every other console mutation.
router.put("/cas/evidence-policy", requireCasCredential, async (req, res, next) => {
  try {
    const parsed = policyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid capture policy", issues: parsed.error.issues });
    }
    const now = new Date();
    await db.insert(casCapturePolicy)
      .values({ id: "current", ...parsed.data, updatedAt: now })
      .onConflictDoUpdate({
        target: casCapturePolicy.id,
        set: { ...parsed.data, updatedAt: now },
      });
    return res.json(await readPolicy());
  } catch (error) { return next(error); }
});

/**
 * Bounded evidence upload from the handset. The clip travels as the raw
 * request body (no multipart) with the metadata in headers:
 *   X-Cas-Evidence-Kind: audio | photo | video
 *   X-Cas-Captured-At: epoch milliseconds of the on-device capture start
 *   X-Cas-Sequence: rolling-clip sequence number (optional, default 1)
 *   X-Cas-Capture-Request-Id: responder request this clip satisfies (optional)
 *   X-Cas-Evidence-Camera: front | back (optional; which lens captured a
 *     photo/video clip — older APKs and audio omit it)
 * The upload is the only state transition: it stores the clip, journals it
 * on the incident, and completes the responder request it answers.
 */
router.post(
  "/cas/incidents/:id/evidence",
  express.raw({ type: () => true, limit: MAX_EVIDENCE_BYTES }),
  async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      if (!(await requireEnrolledDevice(req, res))) return;
      const incidentId = req.params.id;
      const kind = req.get("x-cas-evidence-kind") ?? "";
      if (!(CAPTURE_KINDS as readonly string[]).includes(kind)) {
        return res.status(400).json({ error: `Invalid or missing X-Cas-Evidence-Kind (expected one of: ${CAPTURE_KINDS.join(", ")})` });
      }
      const captureKind = kind as CaptureKind;
      const contentType = (req.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
      if (!CONTENT_TYPES[captureKind].has(contentType)) {
        return res.status(400).json({ error: `Content-Type ${contentType} is not accepted for ${captureKind} evidence` });
      }
      const body = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: "Empty evidence body" });
      }
      if (body.length > MAX_EVIDENCE_BYTES) {
        return res.status(413).json({ error: `Evidence exceeds the ${MAX_EVIDENCE_BYTES}-byte bound` });
      }
      const capturedAtMs = Number(req.get("x-cas-captured-at") ?? "");
      const capturedAt = Number.isFinite(capturedAtMs) && capturedAtMs > 0 ? new Date(capturedAtMs) : null;
      const sequenceRaw = Number(req.get("x-cas-sequence") ?? "1");
      const sequence = Number.isInteger(sequenceRaw) && sequenceRaw > 0 && sequenceRaw < 10_000 ? sequenceRaw : 1;
      const requestId = req.get("x-cas-capture-request-id")?.trim() || null;
      const cameraRaw = req.get("x-cas-evidence-camera")?.trim().toLowerCase() || null;
      if (cameraRaw && !(EVIDENCE_CAMERAS as readonly string[]).includes(cameraRaw)) {
        return res.status(400).json({ error: `Invalid X-Cas-Evidence-Camera (expected one of: ${EVIDENCE_CAMERAS.join(", ")})` });
      }
      // Only photo/video clips carry a lens; a camera label on audio would be
      // meaningless metadata, so it is dropped rather than stored.
      const camera = captureKind === "audio" ? null : (cameraRaw as EvidenceCamera | null);

      const now = new Date();
      const evidenceId = `ev-${now.getTime()}-${randomUUID()}`;
      const result = await db.transaction(async (tx) => {
        const incident = await tx.select({ id: casIncidents.id })
          .from(casIncidents).where(eq(casIncidents.id, incidentId)).limit(1);
        if (!incident[0]) return "missing-incident" as const;

        await tx.insert(casEvidence).values({
          id: evidenceId,
          incidentId,
          kind: captureKind,
          contentType,
          sizeBytes: body.length,
          capturedAt,
          requestId,
          sequence,
          camera,
          data: body,
          createdAt: now,
        });
        await tx.insert(casIncidentEvents).values({
          id: `${evidenceId}-uploaded`,
          incidentId,
          type: "EVIDENCE_UPLOADED",
          priority: "P2",
          detail: `${captureKind} evidence received from the handset (${formatBytes(body.length)}${camera ? `, ${camera} camera` : ""}${capturedAt ? `, captured ${capturedAt.toISOString()}` : ""}${requestId ? ", answering a responder capture request" : ""}). Downloadable from this incident's evidence panel.`,
          createdAt: now,
        });

        if (requestId) {
          // Completing the request is part of the same transaction so a
          // request can never read STARTED while its clip is already stored.
          const requestRows = await tx.execute(sql`
            SELECT id, state FROM cas_capture_requests
            WHERE id = ${requestId} AND incident_id = ${incidentId}
            FOR UPDATE
          `);
          const request = requestRows.rows[0] as { id?: string; state?: string } | undefined;
          if (request?.id && (request.state === "PENDING" || request.state === "STARTED")) {
            await tx.update(casCaptureRequests)
              .set({ state: "COMPLETED", updatedAt: now })
              .where(eq(casCaptureRequests.id, requestId));
            await tx.insert(casIncidentEvents).values({
              id: `${requestId}-completed`,
              incidentId,
              type: "CAPTURE_COMPLETED",
              priority: "P2",
              detail: `Responder-requested ${captureKind} capture landed on the server.`,
              createdAt: now,
            });
          }
        }
        return "stored" as const;
      });

      if (result === "missing-incident") {
        return res.status(404).json({ error: "No incident with this id" });
      }
      return res.status(201).json({ id: evidenceId, kind: captureKind, sizeBytes: body.length });
    } catch (error) { return next(error); }
  },
);

/**
 * Evidence download, console-only: the console fetches the bytes with its
 * Bearer credential and hands the operator a file. Metadata listing rides
 * /cas/state (the incident's evidence array), matching the console's
 * existing read posture.
 */
router.get("/cas/evidence/:id/download", requireCasCredential, async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const rows = await db.select({
      id: casEvidence.id,
      incidentId: casEvidence.incidentId,
      kind: casEvidence.kind,
      contentType: casEvidence.contentType,
      sequence: casEvidence.sequence,
      camera: casEvidence.camera,
      data: casEvidence.data,
    }).from(casEvidence).where(eq(casEvidence.id, req.params.id)).limit(1);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "No evidence with this id" });
    const extension = row.kind === "photo" ? "jpg" : row.kind === "video" ? "mp4" : "m4a";
    res.setHeader("Content-Type", row.contentType);
    res.setHeader("Content-Length", String(row.data.length));
    res.setHeader("Content-Disposition", `attachment; filename="cas-${row.incidentId}-${row.kind}${row.camera ? `-${row.camera}` : ""}-${row.sequence}.${extension}"`);
    return res.end(row.data);
  } catch (error) { return next(error); }
});

/**
 * Per-incident evidence detail, console-only: /cas/state carries evidence
 * metadata for the latest incident only, so browsing any older alert's
 * evidence goes through this route. Metadata only — the clip bytes never
 * appear in listings; viewing and downloading ride the credentialed
 * download endpoint above. The incident's append-only journal rides along
 * so a deletion the operator just made is immediately visible as an
 * EVIDENCE_DELETED entry without a separate fetch.
 */
router.get("/cas/incidents/:id/evidence", requireCasCredential, async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const incidentRows = await db.select({
      id: casIncidents.id,
      status: casIncidents.status,
      priority: casIncidents.priority,
      triggerCount: casIncidents.triggerCount,
      createdAt: casIncidents.createdAt,
    }).from(casIncidents).where(eq(casIncidents.id, req.params.id)).limit(1);
    const incident = incidentRows[0];
    if (!incident) return res.status(404).json({ error: "No incident with this id" });
    const [evidenceRows, eventRows] = await Promise.all([
      db.select({
        id: casEvidence.id,
        kind: casEvidence.kind,
        contentType: casEvidence.contentType,
        sizeBytes: casEvidence.sizeBytes,
        sequence: casEvidence.sequence,
        camera: casEvidence.camera,
        capturedAt: casEvidence.capturedAt,
        requestId: casEvidence.requestId,
        createdAt: casEvidence.createdAt,
      }).from(casEvidence)
        .where(eq(casEvidence.incidentId, incident.id))
        .orderBy(asc(casEvidence.createdAt)),
      db.select().from(casIncidentEvents)
        .where(eq(casIncidentEvents.incidentId, incident.id))
        .orderBy(asc(casIncidentEvents.createdAt)),
    ]);
    return res.json({
      incident: {
        id: incident.id,
        status: incident.status,
        priority: incident.priority,
        triggerCount: incident.triggerCount,
        createdAt: incident.createdAt.toISOString(),
      },
      evidence: evidenceRows.map((item) => ({
        id: item.id,
        kind: item.kind,
        contentType: item.contentType,
        sizeBytes: item.sizeBytes,
        sequence: item.sequence,
        camera: item.camera,
        capturedAt: item.capturedAt ? item.capturedAt.toISOString() : null,
        uploadedAt: item.createdAt.toISOString(),
        requestId: item.requestId,
      })),
      events: eventRows.map((event) => ({
        id: event.id,
        type: event.type,
        priority: event.priority,
        time: event.createdAt.toISOString(),
        detail: event.detail,
      })),
    });
  } catch (error) { return next(error); }
});

/**
 * Evidence deletion, console-only: removes one clip's row and bytes (e.g.
 * for privacy or storage hygiene) and appends an EVIDENCE_DELETED entry to
 * the incident's journal in the same transaction, mirroring the upload
 * pattern. The journal stays append-only — deletion erases the bytes and
 * the listing entry, never the history that the clip existed, and never
 * the incident or its other events.
 */
router.delete("/cas/evidence/:id", requireCasCredential, async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const device = casDeviceFrom(res);
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      // Lock the row before reading it so a concurrent delete 404s instead
      // of double-journaling the deletion.
      const rows = await tx.execute(sql`
        SELECT id, incident_id AS "incidentId", kind, size_bytes AS "sizeBytes",
               sequence, camera, captured_at AS "capturedAt"
        FROM cas_evidence
        WHERE id = ${req.params.id}
        FOR UPDATE
      `);
      const row = rows.rows[0] as {
        id?: string;
        incidentId?: string;
        kind?: string;
        sizeBytes?: number;
        sequence?: number;
        camera?: string | null;
        // Raw driver rows return timestamptz as strings, not Dates.
        capturedAt?: string | null;
      } | undefined;
      if (!row?.id || !row.incidentId || !row.kind) return "missing" as const;
      await tx.delete(casEvidence).where(eq(casEvidence.id, row.id));
      const capturedDetail = row.capturedAt ? `, captured ${new Date(row.capturedAt).toISOString()}` : "";
      await tx.insert(casIncidentEvents).values({
        id: `${row.id}-deleted`,
        incidentId: row.incidentId,
        type: "EVIDENCE_DELETED",
        priority: "P2",
        detail: `Responder deleted the ${row.kind} evidence clip (${formatBytes(row.sizeBytes ?? 0)}${row.camera ? `, ${row.camera} camera` : ""}${(row.sequence ?? 1) > 1 ? `, clip ${row.sequence}` : ""}${capturedDetail}) from this incident. The clip's bytes and listing entry are permanently removed; its upload entry stays in this append-only journal. Deleted by enrolled device "${device.label}" (${device.id}).`,
        createdAt: now,
      });
      return { id: row.id, incidentId: row.incidentId } as const;
    });
    if (result === "missing") return res.status(404).json({ error: "No evidence with this id" });
    return res.json({ ...result, deleted: true });
  } catch (error) { return next(error); }
});

const captureRequestSchema = z.object({
  kind: z.enum(CAPTURE_KINDS),
});

/**
 * Responder-requested capture. Only kinds whose policy toggle is "responder"
 * can be requested: "off" means the owner turned the capability off and the
 * request could never be honored; "trigger" means capture already starts on
 * every trigger, so a request adds nothing. Both get a loud 409.
 */
router.post("/cas/incidents/:id/capture-requests", requireCasCredential, async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const parsed = captureRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid capture request", issues: parsed.error.issues });
    }
    const incidentId = req.params.id;
    const kind = parsed.data.kind;
    const policy = await readPolicy();
    const setting = policy[kind];
    if (setting === "off") {
      return res.status(409).json({ error: `${kind} capture is set to off in the capture policy; enable "only when a responder asks" first` });
    }
    if (setting === "trigger") {
      return res.status(409).json({ error: `${kind} capture already starts on every trigger (policy setting "start on trigger"); a responder request would duplicate it` });
    }
    const now = new Date();
    const id = `capreq-${now.getTime()}-${randomUUID()}`;
    const created = await db.transaction(async (tx) => {
      const incident = await tx.select({ id: casIncidents.id, status: casIncidents.status })
        .from(casIncidents).where(eq(casIncidents.id, incidentId)).limit(1);
      if (!incident[0]) return false;
      await tx.insert(casCaptureRequests).values({ id, incidentId, kind, state: "PENDING", createdAt: now, updatedAt: now });
      await tx.insert(casIncidentEvents).values({
        id: `${id}-requested`,
        incidentId,
        type: "CAPTURE_REQUESTED",
        priority: "P1",
        detail: `Responder requested ${kind} capture. The handset picks the request up on its next server contact; if Android blocks the background mic/camera start, the handset reports the exact restriction back here.`,
        createdAt: now,
      });
      return true;
    });
    if (!created) return res.status(404).json({ error: "No incident with this id" });

    // Near-real-time wake: a high-priority FCM message both wakes the idle
    // phone immediately and grants the background mic/camera start exemption.
    // Runs after the commit so the request is durable no matter what the
    // push does; polling pickup stays as the fallback and the journal records
    // which path was live for this request.
    const push = await sendCaptureRequestPush({ requestId: id, incidentId, kind });
    const pushEvent = push.status === "sent"
      ? {
          type: "CAPTURE_PUSH_SENT",
          priority: "P2",
          detail: `High-priority push wake sent to ${push.delivered} enrolled handset(s)${push.staleRemoved ? ` (${push.staleRemoved} stale registration(s) dropped)` : ""}. If no handset acks, polling pickup remains as fallback.`,
        }
      : push.status === "unconfigured"
        ? {
            type: "CAPTURE_PUSH_UNAVAILABLE",
            priority: "P2",
            detail: "Push wake is not configured on this server (no Firebase service account); the handset will pick the request up on its next server contact. See SELF-HOSTING.md to enable instant wake.",
          }
        : push.status === "no-registrations"
          ? {
              type: "CAPTURE_PUSH_UNAVAILABLE",
              priority: "P2",
              detail: "No enrolled handset has registered a push token, so no wake was sent; the handset will pick the request up on its next server contact.",
            }
          : {
              type: "CAPTURE_PUSH_FAILED",
              priority: "P1",
              detail: `Push wake failed (${push.detail}); the handset will still pick the request up on its next server contact.`,
            };
    await db.insert(casIncidentEvents).values({
      id: `${id}-push-${push.status}-${Date.now()}`,
      incidentId,
      type: pushEvent.type,
      priority: pushEvent.priority,
      detail: pushEvent.detail,
      createdAt: new Date(),
    });

    return res.status(201).json({ id, incidentId, kind, state: "PENDING", push: push.status });
  } catch (error) { return next(error); }
});

/**
 * Handset pickup list for responder-requested captures. Read-only: requests
 * stay PENDING until the handset acks, so a crash between pickup and capture
 * start can never lose a request.
 */
router.get("/cas/capture-requests/pending", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await requireEnrolledDevice(req, res))) return;
    const items = await db.select({
      id: casCaptureRequests.id,
      incidentId: casCaptureRequests.incidentId,
      kind: casCaptureRequests.kind,
      createdAt: casCaptureRequests.createdAt,
    }).from(casCaptureRequests)
      .where(eq(casCaptureRequests.state, "PENDING"))
      .orderBy(asc(casCaptureRequests.createdAt))
      .limit(20);
    return res.json({
      items: items.map((item) => ({
        id: item.id,
        incidentId: item.incidentId,
        kind: item.kind,
        requestedAt: item.createdAt.toISOString(),
      })),
    });
  } catch (error) { return next(error); }
});

const captureAckSchema = z.object({
  outcome: z.enum(["started", "failed"]),
  // The measured reason a start failed — e.g. Android's background
  // mic/camera start restriction — is recorded verbatim for the handoff docs.
  detail: z.string().trim().min(1).max(500).optional(),
  // Which wake path brought the request to the handset: "push" (high-priority
  // FCM) or "poll" (the handset's own server contact). Older APKs omit it;
  // the journal treats a missing value as the polling path, which is the only
  // one they have.
  via: z.enum(["push", "poll"]).optional(),
});

/**
 * Handset ack for a responder capture request. PENDING -> STARTED when the
 * capture service is running, PENDING -> FAILED with the measured detail when
 * Android refuses the start (e.g. background mic/camera restrictions). The
 * later evidence upload flips STARTED -> COMPLETED.
 */
router.post("/cas/capture-requests/:id/ack", async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    if (!(await requireEnrolledDevice(req, res))) return;
    const parsed = captureAckSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid capture ack", issues: parsed.error.issues });
    }
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, incident_id AS "incidentId", kind, state FROM cas_capture_requests
        WHERE id = ${req.params.id}
        FOR UPDATE
      `);
      const request = rows.rows[0] as { id?: string; incidentId?: string; kind?: string; state?: string } | undefined;
      if (!request?.id || !request.incidentId || !request.kind || !request.state) return "missing" as const;
      if (request.state !== "PENDING") return "conflict" as const;
      const nextState = parsed.data.outcome === "started" ? "STARTED" : "FAILED";
      // Older APKs have no push support and omit `via`; their only path is
      // the polling pickup, so the journal never loses the wake-path record.
      const via = parsed.data.via ?? "poll";
      const wakePath = via === "push"
        ? "woken instantly by a high-priority push message"
        : "picked up on the handset's own server contact (polling path)";
      await tx.update(casCaptureRequests)
        .set({ state: nextState, detail: parsed.data.detail ?? null, via, updatedAt: now })
        .where(eq(casCaptureRequests.id, request.id));
      await tx.insert(casIncidentEvents).values({
        id: `${request.id}-${nextState.toLowerCase()}-${now.getTime()}`,
        incidentId: request.incidentId,
        type: nextState === "STARTED" ? "CAPTURE_STARTED" : "CAPTURE_FAILED",
        priority: nextState === "STARTED" ? "P2" : "P1",
        detail: nextState === "STARTED"
          ? `Handset started responder-requested ${request.kind} capture (${wakePath}).`
          : `Handset could not start responder-requested ${request.kind} capture (${wakePath}): ${parsed.data.detail ?? "no detail reported"}.`,
        createdAt: now,
      });
      return nextState;
    });
    if (result === "missing") return res.status(404).json({ error: "No capture request with this id" });
    if (result === "conflict") return res.status(409).json({ error: "Capture request is no longer pending" });
    return res.json({ id: req.params.id, state: result });
  } catch (error) { return next(error); }
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default router;
