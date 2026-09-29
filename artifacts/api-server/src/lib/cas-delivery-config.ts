import { db } from "@workspace/db";
import {
  casMessageTemplates,
  casResponders,
  type CasResponder,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  GATEWAY_TRANSPORTS,
  emailChannelConfigured,
  readProviderEndpoint,
  readProviderRecipients,
  type GatewayTransport,
} from "./cas-provider-env";
import { getEmailAccount } from "./cas-email-accounts";
import { DEFAULT_TEMPLATE_BODY, type CasTemplateChannel } from "./cas-message-template";

/**
 * Console-managed delivery configuration: the responder circle (who gets
 * alerted, on which channels) and the per-channel message templates (what the
 * alert says). Both live in the database so the operator can change them from
 * the console without editing secrets or redeploying.
 *
 * Backward compatibility contract: the CAS_*_RECIPIENTS environment lists are
 * the delivery fallback only. They are NEVER copied into cas_responders —
 * an earlier migration seed did that on first console read and silently
 * created ENABLED responders holding real addresses, so every incident
 * (test or real) delivered to them. Responder rows are now created only by
 * an authenticated operator action in the console. Trigger fan-out and
 * delivery treat "no responder rows at all" as "use the env lists", so a
 * deployment that never opens the console behaves exactly as before.
 */

/** The responder's address for a channel, or null when they are not on it. */
export function responderAddressFor(
  responder: CasResponder,
  transport: GatewayTransport,
): string | null {
  const address =
    transport === "SMS"
      ? responder.smsNumber
      : transport === "WHATSAPP"
        ? responder.whatsappNumber
        : transport === "EMAIL"
          ? responder.emailAddress
          : responder.xmppAddress;
  return address && address.trim().length > 0 ? address : null;
}

export async function listCasResponders(): Promise<CasResponder[]> {
  return db.select().from(casResponders).orderBy(casResponders.createdAt, casResponders.id);
}

/**
 * The recipients a gateway transport must deliver to right now.
 * - null: the responders table is empty (never seeded / pre-console
 *   deployment) — the caller falls back to the env recipient list.
 * - otherwise: the enabled responders' addresses for the channel, possibly
 *   empty (operator disabled everyone — an explicit "deliver to nobody",
 *   which the sender surfaces as a loud failure, never a silent success).
 */
export async function resolveDbRecipients(
  transport: GatewayTransport,
): Promise<string[] | null> {
  const rows = await db.select().from(casResponders);
  if (rows.length === 0) return null;
  return rows
    .filter((row) => row.enabled)
    .map((row) => responderAddressFor(row, transport))
    .filter((address): address is string => address !== null);
}

/** The channel's saved template, or the built-in default when never edited. */
export async function resolveTemplateBody(channel: CasTemplateChannel): Promise<string> {
  const [row] = await db
    .select({ body: casMessageTemplates.body })
    .from(casMessageTemplates)
    .where(eq(casMessageTemplates.channel, channel))
    .limit(1);
  return row?.body ?? DEFAULT_TEMPLATE_BODY;
}

/**
 * Gateway transports that can actually deliver an alert right now: provider
 * endpoint configured AND at least one recipient reachable — console-managed
 * responders when the table has rows, the env recipient list otherwise. The
 * trigger route queues outbox items only for these channels, so a channel
 * nobody can receive never creates a row that can only dead-letter.
 */
export async function deliverableGatewayTransports(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayTransport[]> {
  const rows = await db.select().from(casResponders);
  // Console-managed email accounts (Email delivery page) count as configured
  // the moment a primary row exists — the same precedence the sender applies.
  const consoleEmail = await getEmailAccount("primary");
  const deliverable: GatewayTransport[] = [];
  for (const transport of GATEWAY_TRANSPORTS) {
    // Email is deliverable through any of its paths: console SMTP accounts,
    // direct SMTP (CAS_EMAIL_SMTP_HOST), or the HTTPS mail provider
    // (CAS_EMAIL_PROVIDER_URL).
    const configured =
      transport === "EMAIL"
        ? emailChannelConfigured(env) || Boolean(consoleEmail)
        : readProviderEndpoint(env, transport) !== undefined;
    if (!configured) continue;
    if (rows.length === 0) {
      if (readProviderRecipients(env, transport).length > 0) deliverable.push(transport);
    } else if (rows.some((row) => row.enabled && responderAddressFor(row, transport))) {
      deliverable.push(transport);
    }
  }
  return deliverable;
}
