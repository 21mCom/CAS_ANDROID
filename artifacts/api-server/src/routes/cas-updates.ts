import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { casAppUpdates } from "@workspace/db/schema";
import { z } from "zod";
import {
  requireCasCredential,
  requireCasEnrollmentCredential,
} from "../lib/cas-auth";
import { logger } from "../lib/logger";

/**
 * One-tap in-app self-update for the field kit: the operator publishes a
 * signed kit APK here, the handset polls the manifest on app open, downloads
 * the APK, verifies the SHA-256 in the manifest against the downloaded
 * bytes, and hands the verified file to PackageInstaller — the owner
 * confirms one system prompt. (Fully silent updates are impossible without
 * Play or device-owner mode; one tap is the floor.)
 *
 * Auth model, matching the rest of the handset/console surface:
 * - Publishing is an operator-level action and takes the *enrollment*
 *   credential (same gate as enroll/list/revoke) — a field handset's own
 *   device credential must not be able to replace the binary every other
 *   handset will install.
 * - Manifest and download take any enrolled, non-revoked device credential —
 *   the handset's own. There is no anonymous read and no shared-token
 *   fallback: a revoked phone loses update access with everything else.
 *
 * Transport contract (same as provider delivery): HTTPS-only — the handset
 * refuses any update URL that is not HTTPS (loopback dev endpoints
 * excepted), follows no redirects, and treats the manifest's server-computed
 * SHA-256 + size as a hard pin: any byte-level mismatch aborts before
 * PackageInstaller ever sees the file. Android then independently enforces
 * the pinned signing key (cross-key updates are rejected by the OS).
 */

const router: IRouter = Router();

// The kit package this server ships updates for. Published rows may carry a
// different package name only by explicit override at publish time; the
// handset refuses any manifest whose package does not match its own, so a
// mislabeled publish can never become an install prompt for the wrong app.
const DEFAULT_PACKAGE_NAME = "com.covertalert.pixeltest";

// The APK body rides as raw bytes (like evidence uploads); 32 MB is generous
// headroom over the ~5 MB debug kit while bounding memory per request.
const MAX_APK_BYTES = 32 * 1024 * 1024;

const publishQuerySchema = z.object({
  versionCode: z.coerce.number().int().min(1),
  versionName: z.string().trim().min(1).max(40),
  packageName: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/, "not a valid Android package name")
    .optional(),
});

type UpdateRow = typeof casAppUpdates.$inferSelect;

function manifestFor(row: UpdateRow) {
  return {
    packageName: row.packageName,
    versionCode: row.versionCode,
    versionName: row.versionName,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    publishedAt: row.createdAt.toISOString(),
    // Handset resolves this against its configured server URL; keeping it a
    // path (not an absolute URL) means no redirect or origin games.
    downloadPath: "/api/cas/app-updates/latest.apk",
  };
}

const manifestColumns = {
  id: casAppUpdates.id,
  packageName: casAppUpdates.packageName,
  versionCode: casAppUpdates.versionCode,
  versionName: casAppUpdates.versionName,
  sha256: casAppUpdates.sha256,
  sizeBytes: casAppUpdates.sizeBytes,
  uploadedByDeviceId: casAppUpdates.uploadedByDeviceId,
  uploadedByLabel: casAppUpdates.uploadedByLabel,
  createdAt: casAppUpdates.createdAt,
} as const;

/** Newest = highest versionCode (monotonic publish is enforced below). */
async function latestUpdate(): Promise<UpdateRow | undefined> {
  const rows = await db
    .select(manifestColumns)
    .from(casAppUpdates)
    .orderBy(desc(casAppUpdates.versionCode))
    .limit(1);
  return rows[0] as UpdateRow | undefined;
}

/**
 * Publishes a new kit build. Body is the raw APK (Content-Type
 * application/vnd.android.package-archive or application/octet-stream);
 * version metadata rides the query string so publishing is one curl. The
 * server computes the SHA-256 itself — the publisher never supplies the hash,
 * so the manifest cannot drift from the bytes it pins.
 */
router.post(
  "/cas/app-updates",
  requireCasEnrollmentCredential,
  express.raw({
    type: ["application/vnd.android.package-archive", "application/octet-stream"],
    limit: MAX_APK_BYTES,
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = publishQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid publish request", issues: parsed.error.issues });
      }
      const body = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({
          error: "Empty APK body — send the APK as the raw request body (Content-Type application/vnd.android.package-archive).",
        });
      }
      const sha256 = createHash("sha256").update(body).digest("hex");
      const latest = await latestUpdate();
      if (latest && parsed.data.versionCode <= latest.versionCode) {
        // Monotonic publish: Android cannot downgrade, and a silent re-publish
        // of an existing build under new bytes would be an update-channel
        // attack surface. Build a new versionCode instead.
        return res.status(409).json({
          error: `versionCode ${parsed.data.versionCode} is not newer than the published ${latest.versionCode}; updates are append-only and versionCode must strictly increase.`,
          published: manifestFor(latest),
        });
      }
      // The enrollment gate authenticates the shared operator credential, not
      // a device row, so attribution is the gate itself.
      const row: UpdateRow = {
        id: `appupdate-${Date.now()}-${randomUUID()}`,
        packageName: parsed.data.packageName ?? DEFAULT_PACKAGE_NAME,
        versionCode: parsed.data.versionCode,
        versionName: parsed.data.versionName,
        sha256,
        sizeBytes: body.length,
        data: body,
        uploadedByDeviceId: null,
        uploadedByLabel: "operator (enrollment credential)",
        createdAt: new Date(),
      };
      await db.insert(casAppUpdates).values(row);
      logger.info(
        {
          versionCode: row.versionCode,
          versionName: row.versionName,
          sha256,
          sizeBytes: row.sizeBytes,
        },
        "Published CAS app update",
      );
      return res.status(201).json({ published: true, update: manifestFor(row) });
    } catch (error) { return next(error); }
  },
);

/**
 * The update manifest the handset polls on app open. Newest build only; the
 * hash and size in it were computed from the stored bytes at publish time.
 */
router.get("/cas/app-updates/manifest", requireCasCredential, async (_req, res, next) => {
  try {
    const latest = await latestUpdate();
    if (!latest) {
      return res.status(404).json({ error: "No app update has been published on this server." });
    }
    // The manifest is polled on every app open; never let a cache serve a
    // stale pin after a new build lands.
    res.setHeader("Cache-Control", "no-store");
    return res.json(manifestFor(latest));
  } catch (error) { return next(error); }
});

/**
 * The pinned APK bytes. Served directly from the stored row (no redirects,
 * no external host), with the SHA-256 repeated in a header so a downloader
 * can cross-check the manifest it already holds.
 */
router.get("/cas/app-updates/latest.apk", requireCasCredential, async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(casAppUpdates)
      .orderBy(desc(casAppUpdates.versionCode))
      .limit(1);
    const latest = rows[0];
    if (!latest) {
      return res.status(404).json({ error: "No app update has been published on this server." });
    }
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Length", String(latest.data.length));
    res.setHeader("Content-Disposition", `attachment; filename="cas-pixel-${latest.versionCode}.apk"`);
    res.setHeader("X-CAS-SHA256", latest.sha256);
    res.setHeader("Cache-Control", "no-store");
    return res.send(latest.data);
  } catch (error) { return next(error); }
});

export default router;
