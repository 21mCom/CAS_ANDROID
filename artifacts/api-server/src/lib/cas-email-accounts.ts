import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { casEmailAccounts } from "@workspace/db/schema";
import { readEmailSmtpConfig } from "./cas-provider-env";
import type { SmtpSendConfig } from "./cas-smtp";

/**
 * Console-managed SMTP accounts for the email alert channel: a primary
 * mailbox plus an optional fallback for redundancy, persisted in
 * cas_email_accounts and edited on the console's Email delivery page.
 *
 * Precedence, matching the responder-circle pattern: once a primary row
 * exists, console settings own the channel and the CAS_EMAIL_SMTP_* /
 * CAS_EMAIL_PROVIDER_URL environment config is ignored for sends (the page
 * shows which source is live). Deleting the primary row reverts to the
 * environment, so env-only deployments are unaffected.
 *
 * The app password is stored in the database because the server must present
 * it on every send; API reads never return it. Anyone with database access
 * can read it — the same exposure as the env file on a self-hosted host.
 */

export type EmailAccountSlot = "primary" | "fallback";

export type EmailAccountRow = typeof casEmailAccounts.$inferSelect;

export function isEmailAccountSlot(value: string): value is EmailAccountSlot {
  return value === "primary" || value === "fallback";
}

export async function getEmailAccount(slot: EmailAccountSlot): Promise<EmailAccountRow | undefined> {
  const [row] = await db
    .select()
    .from(casEmailAccounts)
    .where(eq(casEmailAccounts.slot, slot))
    .limit(1);
  return row;
}

export async function listEmailAccounts(): Promise<EmailAccountRow[]> {
  return db.select().from(casEmailAccounts);
}

export async function saveEmailAccount(
  slot: EmailAccountSlot,
  fields: { host: string; port: number; user: string; password: string; fromAddress?: string | null },
): Promise<void> {
  const now = new Date();
  const row = {
    host: fields.host,
    port: fields.port,
    smtpUser: fields.user,
    password: fields.password,
    fromAddress: fields.fromAddress ?? null,
    updatedAt: now,
  };
  await db
    .insert(casEmailAccounts)
    .values({ slot, ...row })
    .onConflictDoUpdate({ target: casEmailAccounts.slot, set: row });
}

export async function deleteEmailAccount(slot: EmailAccountSlot): Promise<boolean> {
  const deleted = await db
    .delete(casEmailAccounts)
    .where(eq(casEmailAccounts.slot, slot))
    .returning({ slot: casEmailAccounts.slot });
  return deleted.length > 0;
}

/**
 * Console rows feed the same sender as the env path; the TLS mode mirrors
 * the env rule (implicit TLS on 465, mandatory STARTTLS on any other port).
 */
export function accountToSmtpConfig(row: EmailAccountRow): SmtpSendConfig {
  return {
    host: row.host,
    port: row.port,
    secure: row.port === 465,
    user: row.smtpUser,
    password: row.password,
    from: row.fromAddress ?? row.smtpUser,
  };
}

export type EmailDeliverySource = "console" | "environment" | "none";

/** Which configuration owns the email channel right now (drives the console banner). */
export async function emailDeliverySource(env: NodeJS.ProcessEnv = process.env): Promise<{
  source: EmailDeliverySource;
  environment: { smtpConfigured: boolean; providerConfigured: boolean };
}> {
  const primary = await getEmailAccount("primary");
  const smtpConfigured = readEmailSmtpConfig(env) !== undefined;
  const providerConfigured = Boolean(env.CAS_EMAIL_PROVIDER_URL?.trim());
  return {
    source: primary ? "console" : smtpConfigured || providerConfigured ? "environment" : "none",
    environment: { smtpConfigured, providerConfigured },
  };
}
