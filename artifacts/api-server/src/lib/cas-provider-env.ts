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
