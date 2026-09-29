/**
 * Environment layout for the CAS gateway providers, shared between the
 * delivery adapters (delivery-providers.ts) and the console-managed delivery
 * configuration (cas-delivery-config.ts). Single source of truth for which
 * variables configure which transport, so the env seed/fallback and the
 * adapters can never disagree about variable names.
 *
 * Endpoint variables (URL/token/from) stay environment-only: they carry
 * provider credentials and are deployment concerns. Recipient lists are the
 * seed/fallback for the console-managed responder circle.
 */
export type GatewayTransport = "SMS" | "XMPP" | "EMAIL" | "WHATSAPP";

export const GATEWAY_TRANSPORTS: GatewayTransport[] = ["SMS", "XMPP", "EMAIL", "WHATSAPP"];

const TRANSPORT_ENV: Record<GatewayTransport, { prefix: string; fromKey: string }> = {
  SMS: { prefix: "CAS_SMS", fromKey: "CAS_SMS_FROM" },
  XMPP: { prefix: "CAS_XMPP", fromKey: "CAS_XMPP_FROM_JID" },
  EMAIL: { prefix: "CAS_EMAIL", fromKey: "CAS_EMAIL_FROM" },
  WHATSAPP: { prefix: "CAS_WHATSAPP", fromKey: "CAS_WHATSAPP_FROM" },
};

export function parseRecipientList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export type ProviderEndpoint = {
  url: string;
  token?: string;
  from?: string;
};

/**
 * The provider endpoint configuration for a transport (URL present), ignoring
 * recipients. Recipients are resolved per send: console-managed responders
 * first, this environment's recipient list as the pre-console fallback.
 */
export function readProviderEndpoint(
  env: NodeJS.ProcessEnv,
  transport: GatewayTransport,
): ProviderEndpoint | undefined {
  const { prefix, fromKey } = TRANSPORT_ENV[transport];
  const url = env[`${prefix}_PROVIDER_URL`];
  if (!url) return undefined;
  return {
    url,
    token: env[`${prefix}_PROVIDER_TOKEN`] || undefined,
    from: env[fromKey] || undefined,
  };
}

/** The transport's env recipient list — the seed/fallback, never the live config once responders exist in the DB. */
export function readProviderRecipients(
  env: NodeJS.ProcessEnv,
  transport: GatewayTransport,
): string[] {
  return parseRecipientList(env[`${TRANSPORT_ENV[transport].prefix}_RECIPIENTS`]);
}

/**
 * Direct-SMTP configuration for the email channel — the alternative to an
 * HTTPS mail-submission provider for personal-scale deployments (a dedicated
 * mailbox with an app password, e.g. Gmail's smtp.gmail.com:465).
 *
 *   CAS_EMAIL_SMTP_HOST      submission host; presence enables the SMTP path
 *   CAS_EMAIL_SMTP_PORT      default 465 (implicit TLS); 587 uses STARTTLS.
 *                            TLS is mandatory either way — a server that
 *                            cannot encrypt fails loudly, never cleartext.
 *   CAS_EMAIL_SMTP_USER      mailbox login (usually the full address)
 *   CAS_EMAIL_SMTP_PASSWORD  app password for that mailbox
 *   CAS_EMAIL_SMTP_CA_FILE   optional PEM bundle for relays on internal CAs
 *   CAS_EMAIL_FROM           sender address; defaults to the SMTP user
 *
 * "Configured" means the host is set; missing user/password fail loudly at
 * send time (not-configured) so a half-written env block is never silently
 * treated as "email disabled".
 */
export type EmailSmtpEnvConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from?: string;
  caFile?: string;
};

export const DEFAULT_SMTP_PORT = 465;

export function readEmailSmtpConfig(
  env: NodeJS.ProcessEnv,
): EmailSmtpEnvConfig | undefined {
  const host = env.CAS_EMAIL_SMTP_HOST?.trim();
  if (!host) return undefined;
  const rawPort = env.CAS_EMAIL_SMTP_PORT?.trim();
  let port = DEFAULT_SMTP_PORT;
  if (rawPort) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(
        `Invalid CAS_EMAIL_SMTP_PORT value: "${rawPort}" (expected a port number 1-65535)`,
      );
    }
    port = parsed;
  }
  return {
    host,
    port,
    // 465 is the implicit-TLS submission port; anything else upgrades via
    // STARTTLS (and the client refuses servers that cannot).
    secure: port === 465,
    user: env.CAS_EMAIL_SMTP_USER?.trim() || undefined,
    password: env.CAS_EMAIL_SMTP_PASSWORD || undefined,
    from: env.CAS_EMAIL_FROM?.trim() || env.CAS_EMAIL_SMTP_USER?.trim() || undefined,
    caFile: env.CAS_EMAIL_SMTP_CA_FILE?.trim() || undefined,
  };
}

/**
 * Email delivery is configured when EITHER transport is present. Setting
 * both is contradictory — which one should send? — and fails loudly at boot
 * (the same posture as an unknown CAS_SMS_DELIVERY_MODE) instead of
 * silently picking one.
 */
export function assertUnambiguousEmailConfig(env: NodeJS.ProcessEnv): void {
  if (readEmailSmtpConfig(env) && readProviderEndpoint(env, "EMAIL")) {
    throw new Error(
      "CAS email is configured twice: set either CAS_EMAIL_SMTP_HOST (direct SMTP through a mailbox) or CAS_EMAIL_PROVIDER_URL (HTTPS mail provider), not both.",
    );
  }
}

/** True when the email channel has any working delivery path configured. */
export function emailChannelConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(readEmailSmtpConfig(env) ?? readProviderEndpoint(env, "EMAIL"));
}
