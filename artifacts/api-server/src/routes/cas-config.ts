import { Router, type IRouter, type Request } from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { casMessageTemplates, casResponders } from "@workspace/db/schema";
import { z } from "zod";
import { requireCasCredential } from "../lib/cas-auth";
import { listCasResponders } from "../lib/cas-delivery-config";
import {
  CAS_TEMPLATE_CHANNELS,
  DEFAULT_TEMPLATE_BODY,
  isCasTemplateChannel,
  renderTemplate,
  templateWarnings,
  validateTemplateBody,
  type CasTemplateChannel,
} from "../lib/cas-message-template";
import {
  buildLocationClause,
  testHarnessDeliveryForced,
  type CasIncidentLocation,
} from "../lib/delivery-providers";
import {
  deleteEmailAccount,
  emailDeliverySource,
  getEmailAccount,
  isEmailAccountSlot,
  listEmailAccounts,
  saveEmailAccount,
  type EmailAccountRow,
} from "../lib/cas-email-accounts";
import { probeSmtpAccount } from "../lib/cas-smtp";
import { CasProviderError } from "../lib/cas-provider-error";

/**
 * Console-managed delivery configuration: the responder circle (who gets
 * alerted, on which channels) and the per-channel message templates (what the
 * alert says). Every route is credential-gated — responder addresses are
 * personal data and template wording shapes every future alert.
 *
 * Backward compatibility: the CAS_*_RECIPIENTS environment lists remain the
 * fan-out fallback while no responder rows exist, so a deployment that never
 * opens these pages behaves exactly as before. They are never copied into
 * the responders table — an earlier first-read seed created ENABLED rows
 * holding real addresses without any operator action, so it was removed.
 */

const router: IRouter = Router();

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 .()\-]{2,29}$/, "not a valid phone number");
const emailSchema = z.string().trim().email("not a valid email address").max(120);
const xmppSchema = z
  .string()
  .trim()
  .regex(/^[^\s@]+@[^\s@]+$/, "not a valid XMPP address (user@host)")
  .max(120);

const channelFields = {
  smsNumber: phoneSchema.nullable().optional(),
  whatsappNumber: phoneSchema.nullable().optional(),
  emailAddress: emailSchema.nullable().optional(),
  xmppAddress: xmppSchema.nullable().optional(),
} as const;

const createResponderSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional(),
  ...channelFields,
});

const patchResponderSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  ...channelFields,
});

type ChannelFieldName = keyof typeof channelFields;
const CHANNEL_FIELD_NAMES = Object.keys(channelFields) as ChannelFieldName[];

function normalizeChannels<T extends Partial<Record<ChannelFieldName, string | null | undefined>>>(
  input: T,
): Partial<Record<ChannelFieldName, string | null>> {
  const out: Partial<Record<ChannelFieldName, string | null>> = {};
  for (const field of CHANNEL_FIELD_NAMES) {
    if (input[field] !== undefined) {
      const value = input[field];
      out[field] = value === null || value.trim() === "" ? null : value.trim();
    }
  }
  return out;
}

function shapeResponder(row: typeof casResponders.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    channels: {
      sms: row.smsNumber,
      whatsapp: row.whatsappNumber,
      email: row.emailAddress,
      xmpp: row.xmppAddress,
    },
    // Lets the console mark rows that came from the environment seed.
    seeded: row.id.startsWith("seed-"),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Lists the responder circle. Rows are only ever created by an authenticated
// POST below — the environment recipient lists are a delivery-time fallback
// (see cas-delivery-config.ts), never a source of responder rows. The
// `seeded` field stays in the response shape (the console schema requires
// it) and is always false now that first-read env seeding is retired.
router.get("/cas/config/responders", requireCasCredential, async (_req, res, next) => {
  try {
    const rows = await listCasResponders();
    return res.json({ seeded: false, responders: rows.map(shapeResponder) });
  } catch (error) { return next(error); }
});

router.post("/cas/config/responders", requireCasCredential, async (req, res, next) => {
  try {
    const parsed = createResponderSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid responder", issues: parsed.error.issues });
    }
    const channels = normalizeChannels(parsed.data);
    if (!Object.values(channels).some((value) => value)) {
      return res.status(400).json({
        error: "A responder needs at least one channel (SMS number, WhatsApp number, email address, or XMPP address). To park someone, disable them instead.",
      });
    }
    const now = new Date();
    const row = {
      id: `rsp-${randomUUID()}`,
      name: parsed.data.name,
      enabled: parsed.data.enabled ?? true,
      smsNumber: channels.smsNumber ?? null,
      whatsappNumber: channels.whatsappNumber ?? null,
      emailAddress: channels.emailAddress ?? null,
      xmppAddress: channels.xmppAddress ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(casResponders).values(row);
    return res.status(201).json(shapeResponder(row as typeof casResponders.$inferSelect));
  } catch (error) { return next(error); }
});

// Edit or disable a responder. A channel set to null (or "") is cleared —
// that responder stops receiving on it. Disabling suspends every channel
// without losing the record.
router.patch("/cas/config/responders/:id", requireCasCredential, async (req: Request<{ id: string }>, res, next) => {
  try {
    const parsed = patchResponderSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid responder update", issues: parsed.error.issues });
    }
    const channels = normalizeChannels(parsed.data);
    const [updated] = await db
      .update(casResponders)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        ...channels,
        updatedAt: new Date(),
      })
      .where(eq(casResponders.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Responder not found" });
    return res.json(shapeResponder(updated));
  } catch (error) { return next(error); }
});

// Permanently removes a responder and every channel address they had (hard
// delete — personal data must not linger once an operator removes someone).
// Nothing references cas_responders with a foreign key, and delivery resolves
// recipients per send attempt, so pending outbox items simply skip the deleted
// responder. Deleting the last row returns delivery to the env-recipient
// fallback (resolveDbRecipients returns null for an empty table).
router.delete("/cas/config/responders/:id", requireCasCredential, async (req: Request<{ id: string }>, res, next) => {
  try {
    const [deleted] = await db
      .delete(casResponders)
      .where(eq(casResponders.id, req.params.id))
      .returning({ id: casResponders.id });
    if (!deleted) return res.status(404).json({ error: "Responder not found" });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

// A representative preview context: exactly what a responder would receive
// for a current P1 alert with a fresh fix. Placeholders are substituted
// server-side so the console preview can never drift from the real sender.
function previewValues(): Record<string, string> {
  const now = new Date();
  const location: CasIncidentLocation = {
    latitude: 37.422,
    longitude: -122.0841,
    accuracyM: 18,
    capturedAt: now,
  };
  return {
    incident_id: "sim-preview-0001",
    priority: "P1",
    time: `${now.toISOString().replace("T", " ").slice(0, 16)}Z`,
    location: buildLocationClause(location, now),
  };
}

function shapeTemplate(channel: CasTemplateChannel, body: string | undefined) {
  const effective = body ?? DEFAULT_TEMPLATE_BODY;
  const preview = renderTemplate(effective, previewValues());
  return {
    channel,
    body: effective,
    source: body === undefined ? ("default" as const) : ("custom" as const),
    placeholders: ["incident_id", "priority", "time", "location"],
    preview,
    warnings: templateWarnings(channel, preview),
  };
}

router.get("/cas/config/templates", requireCasCredential, async (_req, res, next) => {
  try {
    const rows = await db.select().from(casMessageTemplates);
    const byChannel = new Map(rows.map((row) => [row.channel, row.body]));
    return res.json({
      templates: CAS_TEMPLATE_CHANNELS.map((channel) =>
        shapeTemplate(channel, byChannel.get(channel)),
      ),
    });
  } catch (error) { return next(error); }
});

const templateBodySchema = z.object({
  body: z.string().min(1).max(2000),
});

// Renders an unsaved template against the preview context. Never fails for
// validation problems — it reports them, so the console can show inline
// feedback while the operator types.
router.post("/cas/config/templates/preview", requireCasCredential, async (req, res, next) => {
  try {
    const parsed = z
      .object({ channel: z.string(), body: z.string().max(2000) })
      .safeParse(req.body ?? {});
    if (!parsed.success || !isCasTemplateChannel(parsed.data.channel)) {
      return res.status(400).json({ error: "Invalid preview request", issues: parsed.success ? [] : parsed.error.issues });
    }
    const channel = parsed.data.channel;
    const validation = validateTemplateBody(parsed.data.body);
    if (!validation.ok) {
      return res.json({ ok: false as const, error: validation.error });
    }
    const preview = renderTemplate(parsed.data.body.trim(), previewValues());
    return res.json({ ok: true as const, preview, warnings: templateWarnings(channel, preview) });
  } catch (error) { return next(error); }
});

router.put("/cas/config/templates/:channel", requireCasCredential, async (req: Request<{ channel: string }>, res, next) => {
  try {
    const channel = req.params.channel.toUpperCase();
    if (!isCasTemplateChannel(channel)) {
      return res.status(404).json({ error: `Unknown channel "${req.params.channel}" (known: ${CAS_TEMPLATE_CHANNELS.join(", ")})` });
    }
    const parsed = templateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid template", issues: parsed.error.issues });
    }
    const validation = validateTemplateBody(parsed.data.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const body = parsed.data.body.trim();
    const now = new Date();
    await db
      .insert(casMessageTemplates)
      .values({ channel, body, updatedAt: now })
      .onConflictDoUpdate({ target: casMessageTemplates.channel, set: { body, updatedAt: now } });
    return res.json(shapeTemplate(channel, body));
  } catch (error) { return next(error); }
});

// Restores the channel's built-in default wording by removing the custom row.
router.delete("/cas/config/templates/:channel", requireCasCredential, async (req: Request<{ channel: string }>, res, next) => {
  try {
    const channel = req.params.channel.toUpperCase();
    if (!isCasTemplateChannel(channel)) {
      return res.status(404).json({ error: `Unknown channel "${req.params.channel}"` });
    }
    await db.delete(casMessageTemplates).where(eq(casMessageTemplates.channel, channel));
    return res.json(shapeTemplate(channel, undefined));
  } catch (error) { return next(error); }
});

// ---- Email delivery accounts (SMTP) -----------------------------------------
// Console-managed mailbox settings for the email channel: a primary account
// plus an optional fallback for redundancy. Passwords are write-only — reads
// return metadata only — and every route is credential-gated like the rest of
// this surface. When a primary row exists it owns the channel (the CAS_EMAIL_*
// environment config is ignored for sends); deleting it reverts to the
// environment.

const emailAccountBodySchema = z.object({
  host: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().min(1).max(200),
  // Optional on update (kept from the stored row), required on create.
  password: z.string().min(1).max(200).optional(),
  fromAddress: emailSchema.nullable().optional(),
});

const emailAccountTestSchema = z.object({
  host: z.string().trim().min(1).max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().min(1).max(200).optional(),
  password: z.string().min(1).max(200).optional(),
  fromAddress: emailSchema.nullable().optional(),
});

function shapeEmailAccount(row: EmailAccountRow) {
  // Never the password: the API is write-only for credentials.
  return {
    slot: row.slot,
    host: row.host,
    port: row.port,
    user: row.smtpUser,
    fromAddress: row.fromAddress,
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/cas/config/email-accounts", requireCasCredential, async (_req, res, next) => {
  try {
    const rows = await listEmailAccounts();
    const status = await emailDeliverySource();
    return res.json({ ...status, accounts: rows.map(shapeEmailAccount) });
  } catch (error) { return next(error); }
});

router.put("/cas/config/email-accounts/:slot", requireCasCredential, async (req: Request<{ slot: string }>, res, next) => {
  try {
    if (!isEmailAccountSlot(req.params.slot)) {
      return res.status(404).json({ error: `Unknown account slot "${req.params.slot}" (known: primary, fallback)` });
    }
    const parsed = emailAccountBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid email account", issues: parsed.error.issues });
    }
    const existing = await getEmailAccount(req.params.slot);
    const password = parsed.data.password ?? existing?.password;
    if (!password) {
      return res.status(400).json({
        error: "An app password is required when adding an account (it may only be omitted when updating an existing one).",
      });
    }
    await saveEmailAccount(req.params.slot, {
      host: parsed.data.host,
      port: parsed.data.port ?? 465,
      user: parsed.data.user,
      password,
      fromAddress: parsed.data.fromAddress,
    });
    const saved = await getEmailAccount(req.params.slot);
    return res.json(shapeEmailAccount(saved!));
  } catch (error) { return next(error); }
});

router.delete("/cas/config/email-accounts/:slot", requireCasCredential, async (req: Request<{ slot: string }>, res, next) => {
  try {
    if (!isEmailAccountSlot(req.params.slot)) {
      return res.status(404).json({ error: `Unknown account slot "${req.params.slot}"` });
    }
    const deleted = await deleteEmailAccount(req.params.slot);
    if (!deleted) return res.status(404).json({ error: "No account stored in that slot" });
    return res.json({ ok: true as const });
  } catch (error) { return next(error); }
});

// Connect + authenticate probe: proves TLS and the app password without
// sending mail. Unsaved form values may be supplied; anything omitted falls
// back to the stored row, so a saved password never needs to round-trip.
// Under a test harness the dial is skipped entirely (see the handler) so a
// suite with live CAS_EMAIL_SMTP_* secrets in the environment can never log
// into the real mailbox from this route either.
router.post("/cas/config/email-accounts/:slot/test", requireCasCredential, async (req: Request<{ slot: string }>, res, next) => {
  try {
    if (!isEmailAccountSlot(req.params.slot)) {
      return res.status(404).json({ error: `Unknown account slot "${req.params.slot}"` });
    }
    const parsed = emailAccountTestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid test request", issues: parsed.error.issues });
    }
    const stored = await getEmailAccount(req.params.slot);
    const host = parsed.data.host ?? stored?.host;
    const user = parsed.data.user ?? stored?.smtpUser;
    const password = parsed.data.password ?? stored?.password;
    const port = parsed.data.port ?? stored?.port ?? 465;
    const fromAddress =
      parsed.data.fromAddress === undefined ? stored?.fromAddress : parsed.data.fromAddress;
    if (!host || !user || !password) {
      return res.status(400).json({
        error: "Nothing to test: save the account first or provide host, user, and password.",
      });
    }
    // Same rail as the outbox delivery forcing and the boot-time probe-worker
    // skip: under a test harness this route must never open a TLS+AUTH
    // session to the configured mailbox — a suite running with live
    // CAS_EMAIL_SMTP_* secrets in the environment would otherwise log into
    // the real account. Validation above still runs, so the request/response
    // contract is unchanged; only the dial is skipped, and the result says
    // so explicitly instead of faking a success.
    if (testHarnessDeliveryForced()) {
      return res.json({
        ok: false as const,
        classification: "test-harness-skip",
        message:
          "Test harness detected (NODE_ENV=test or CAS_TEST_DISPOSABLE_DB=1): the mailbox login check was skipped without connecting, so no test run ever opens a session to a real mailbox with the configured CAS_EMAIL_SMTP_* secrets. Run the check from a non-test deployment to verify these credentials.",
      });
    }
    await probeSmtpAccount({ host, port, secure: port === 465, user, password, from: fromAddress ?? user });
    return res.json({ ok: true as const });
  } catch (error) {
    if (error instanceof CasProviderError) {
      return res.json({ ok: false as const, classification: error.classification, message: error.message });
    }
    return next(error);
  }
});

export default router;
