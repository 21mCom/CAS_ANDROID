import { Router, type IRouter, type Request } from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { casMessageTemplates, casResponders } from "@workspace/db/schema";
import { z } from "zod";
import { requireCasCredential } from "../lib/cas-auth";
import {
  ensureCasRespondersSeeded,
  listCasResponders,
} from "../lib/cas-delivery-config";
import {
  CAS_TEMPLATE_CHANNELS,
  DEFAULT_TEMPLATE_BODY,
  isCasTemplateChannel,
  renderTemplate,
  templateWarnings,
  validateTemplateBody,
  type CasTemplateChannel,
} from "../lib/cas-message-template";
import { buildLocationClause, type CasIncidentLocation } from "../lib/delivery-providers";

/**
 * Console-managed delivery configuration: the responder circle (who gets
 * alerted, on which channels) and the per-channel message templates (what the
 * alert says). Every route is credential-gated — responder addresses are
 * personal data and template wording shapes every future alert.
 *
 * Backward compatibility: the CAS_*_RECIPIENTS environment lists seed the
 * responders table on first read (ensureCasRespondersSeeded only ever writes
 * into a completely empty table) and remain the fan-out fallback while no
 * responder rows exist, so a deployment that never opens these pages behaves
 * exactly as before.
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

// Lists the responder circle, seeding from the CAS_*_RECIPIENTS environment
// lists on first run so the current setup is never lost when configuration
// moves to the console.
router.get("/cas/config/responders", requireCasCredential, async (_req, res, next) => {
  try {
    const seeded = await ensureCasRespondersSeeded();
    const rows = await listCasResponders();
    return res.json({ seeded, responders: rows.map(shapeResponder) });
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

export default router;
