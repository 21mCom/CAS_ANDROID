import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { casIncidents, casProviderDeliveries } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { CasOutbox } from "@workspace/db/schema";
import { maskRecipient } from "./cas-device-delivery";
import {
  GATEWAY_TRANSPORTS,
  assertUnambiguousEmailConfig,
  emailChannelConfigured,
  readEmailSmtpConfig,
  readProviderEndpoint,
  readProviderRecipients,
  type GatewayTransport,
} from "./cas-provider-env";
import {
  CasProviderError,
  type ProviderErrorClassification,
} from "./cas-provider-error";
import { readSmtpCaPem, sendSmtpMessage } from "./cas-smtp";
import { accountToSmtpConfig, getEmailAccount } from "./cas-email-accounts";
import { DEV_PROVIDER_SINK_HEADER } from "./dev-provider-sink";

export { CasProviderError, type ProviderErrorClassification };
import {
  DEFAULT_TEMPLATE_BODY,
  renderTemplate,
  isCasTemplateChannel,
} from "./cas-message-template";
import {
  resolveDbRecipients,
  resolveTemplateBody,
} from "./cas-delivery-config";
import type { CasDeliverySender } from "../routes/cas";

/**
 * External delivery provider adapters for the CAS durable outbox.
 *
 * Each adapter sends through its configured provider and passes a stable
 * idempotency key derived from the durable outbox record ID, so a worker
 * crash after provider acceptance cannot produce a duplicate alert when the
 * lease is reclaimed and the item is retried.
 *
 * Providers are configured through environment variables. A transport without
 * a configured provider fails explicitly ("not-configured") instead of
 * silently pretending to send.
 *
 * SMS:
 *   CAS_SMS_PROVIDER_URL   HTTPS endpoint of the SMS gateway submission API
 *   CAS_SMS_PROVIDER_TOKEN bearer token for the gateway (optional)
 *   CAS_SMS_FROM           sender ID / number (optional)
 *   CAS_SMS_RECIPIENTS     comma-separated recipient numbers (required)
 *
 * XMPP:
 *   CAS_XMPP_PROVIDER_URL   HTTPS endpoint of the XMPP submission gateway
 *   CAS_XMPP_PROVIDER_TOKEN bearer token for the gateway (optional)
 *   CAS_XMPP_FROM_JID       sender JID (optional)
 *   CAS_XMPP_RECIPIENTS     comma-separated recipient JIDs (required)
 *
 * EMAIL — two mutually exclusive configuration paths (setting both aborts
 * boot rather than silently picking one):
 *   Direct SMTP through a real mailbox (recommended for personal scale; a
 *   dedicated account with an app password). TLS is mandatory — implicit on
 *   port 465, STARTTLS otherwise; a server that cannot encrypt fails loudly:
 *     CAS_EMAIL_SMTP_HOST      submission host; presence selects this path
 *     CAS_EMAIL_SMTP_PORT      default 465; 587 uses STARTTLS
 *     CAS_EMAIL_SMTP_USER / CAS_EMAIL_SMTP_PASSWORD   mailbox login + app password
 *     CAS_EMAIL_SMTP_CA_FILE   optional PEM bundle for relays on internal CAs
 *   HTTPS mail-submission API (Resend-style):
 *     CAS_EMAIL_PROVIDER_URL   HTTPS endpoint of the mail submission API
 *     CAS_EMAIL_PROVIDER_TOKEN bearer token for the provider (optional)
 *   Shared:
 *     CAS_EMAIL_FROM           sender address (SMTP default: the login user)
 *     CAS_EMAIL_RECIPIENTS     comma-separated recipient addresses
 *   SMTP has no idempotency contract (like the WhatsApp Cloud API), so
 *   duplicate suppression is durable on our side via the
 *   cas_provider_deliveries ledger: every accepted (recipient, outbox item)
 *   pair is recorded and a retried send skips it. The RFC Message-ID
 *   carries the stable key hash so the mailbox side can be traced.
 *
 * WHATSAPP (server-side only — the handset never opens the WhatsApp UI):
 *   CAS_WHATSAPP_PROVIDER_URL   full HTTPS URL of the WhatsApp Business
 *                               Cloud API messages resource, including the
 *                               sender phone-number ID in the path:
 *                               https://graph.facebook.com/vXX.X/<phone-number-id>/messages
 *   CAS_WHATSAPP_PROVIDER_TOKEN bearer token for the Cloud API (optional)
 *   CAS_WHATSAPP_RECIPIENTS     comma-separated recipient numbers (required)
 *   The Cloud API has no idempotency contract: it ignores unknown headers
 *   and rejects unknown body fields. Duplicate suppression is therefore
 *   durable on our side — every accepted (recipient, outbox item) pair is
 *   recorded in the cas_provider_deliveries ledger, and a retried send
 *   skips recipients whose acceptance is already recorded. The
 *   Idempotency-Key header is still sent because a gateway sitting in front
 *   of Meta (and the dev provider sink) can honor the replay contract.
 *
 * Provider URL policy: endpoints must be HTTPS because submissions carry
 * bearer credentials and alert content. Plain HTTP is accepted only for
 * loopback hosts (localhost / 127.0.0.1 / ::1) so tests can run a local stub.
 *
 * Gateway idempotency contract (duplicate suppression depends on this):
 * the gateway MUST treat the Idempotency-Key header as a dedup key. When it
 * receives a key it has already accepted, it MUST respond 409 with the header
 * `X-Idempotency-Replayed: true`. Only that specific response counts as a
 * delivered replay; any other 409 is an ordinary conflict and fails the
 * delivery as "rejected" so the alert is never silently marked sent.
 *
 * Redirects are never followed. A 301/302 can silently drop the POST body,
 * and a 307/308 can forward alert content and credentials to a different
 * (possibly cleartext) origin, so any 3xx fails the delivery as "rejected"
 * and the provider URL must be updated in configuration instead.
 */

// CasProviderError and ProviderErrorClassification live in
// cas-provider-error.ts (extracted so the SMTP client shares one definition
// without an import cycle) and are re-exported above.

// A Retry-After hint beyond this bound is clamped to the cap rather than
// dropped: a throttling provider asking for an extreme wait still means
// "back off", so falling back to a near-immediate retry would keep
// hammering it. Clamping cools the transport down for a bounded time.
export const MAX_RETRY_AFTER_HINT_MS = 10 * 60_000;

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into a delay in
 * milliseconds. Oversized hints are clamped to MAX_RETRY_AFTER_HINT_MS;
 * absent, malformed, or non-positive hints return undefined so callers fall
 * back to exponential backoff.
 */
export function parseRetryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  let delayMs: number;
  if (/^\d+$/.test(trimmed)) {
    delayMs = Number(trimmed) * 1_000;
  } else {
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    delayMs = date - now;
  }
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return undefined;
  }
  return Math.min(delayMs, MAX_RETRY_AFTER_HINT_MS);
}

export function formatProviderError(error: unknown): string {
  if (error instanceof CasProviderError) {
    const mode = error.retryable ? "retryable" : "permanent";
    return `${error.classification} (${mode}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export type CasAlertMessage = {
  incidentId: string;
  transport: string;
  priority: string;
  body: string;
};

/** The incident's stored position fix, as the handset reported it. */
export type CasIncidentLocation = {
  latitude: number;
  longitude: number;
  accuracyM: number;
  capturedAt: Date;
};

/**
 * Location clause shared with the handset's offline SMS wording
 * (DeviceSmsSender.alertBody) — keep the two in sync. The fix's accuracy
 * radius and age always travel with the coordinates so a stale or coarse
 * fix is never read as current truth; with no fix the message says so
 * instead of promising one.
 */
export function buildLocationClause(location: CasIncidentLocation | null, now: Date = new Date()): string {
  if (!location) {
    return "Location: no fix captured for this alert.";
  }
  const ageSeconds = Math.max(0, Math.round((now.getTime() - location.capturedAt.getTime()) / 1000));
  const age = ageSeconds < 90
    ? `${ageSeconds}s`
    : `${Math.round(ageSeconds / 60)}min`;
  const lat = location.latitude.toFixed(5);
  const lng = location.longitude.toFixed(5);
  return `Location: https://maps.google.com/?q=${lat},${lng} (±${Math.round(location.accuracyM)}m, fix ${age} old).`;
}

/**
 * Builds the alert message for an outbox item by rendering the channel's
 * template (console-editable; DEFAULT_TEMPLATE_BODY is exactly the pre-2026
 * hardcoded wording, so an untouched deployment sends identical text).
 */
export function buildCasAlertMessage(
  item: CasOutbox,
  location: CasIncidentLocation | null = null,
  templateBody: string = DEFAULT_TEMPLATE_BODY,
): CasAlertMessage {
  const timestamp = item.createdAt.toISOString().replace("T", " ").slice(0, 16);
  return {
    incidentId: item.incidentId,
    transport: item.transport,
    priority: item.priority,
    body: renderTemplate(templateBody, {
      incident_id: item.incidentId,
      priority: item.priority,
      time: `${timestamp}Z`,
      location: buildLocationClause(location),
    }),
  };
}

export type ProviderConfig = {
  url: string;
  token?: string;
  from?: string;
  recipients: string[];
};

/**
 * Header a gateway must send (value "true") alongside a 409 to prove it is
 * reporting a replay of a previously accepted idempotency key. See the module
 * contract above.
 */
export const IDEMPOTENCY_REPLAYED_HEADER = "x-idempotency-replayed";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function providerUrlError(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `provider URL "${url}" is not a valid URL`;
  }
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return undefined;
  }
  return `provider URL "${url}" must use HTTPS; plain HTTP is only allowed for loopback test endpoints because submissions carry credentials and alert content`;
}

/**
 * deliveredTo value recorded when the accepting endpoint is the built-in dev
 * provider sink (it proves itself with DEV_PROVIDER_SINK_HEADER on every
 * acceptance, including replays). The console labels these deliveries as
 * simulated — a sink acceptance means no real provider was contacted.
 */
export const DEV_SINK_DELIVERED_TO = "dev-sink";

/**
 * Where a successful send was actually accepted. Persisted on the outbox
 * record at the SENT transition so the console and journal can distinguish
 * real provider delivery from the built-in test inbox.
 */
export type ProviderDeliveryReceipt = {
  deliveredTo: string;
};

/** The provider's display identity: the dev sink marker, or the endpoint host. */
function deliveredToForEndpoint(url: string, sinkAccepted: boolean): string {
  if (sinkAccepted) return DEV_SINK_DELIVERED_TO;
  try {
    return new URL(url).host;
  } catch {
    // providerUrlError already rejected unparseable URLs before any send;
    // this fallback is unreachable in practice but never throws mid-incident.
    return url;
  }
}

export type ProviderAdapter = {
  transport: "SMS" | "XMPP" | "EMAIL" | "WHATSAPP";
  /**
   * Sends to the given recipients, or to the adapter's configured (env)
   * recipients when `recipientsOverride` is omitted. The console-managed
   * responder circle is passed as the override by the delivery sender; an
   * explicitly empty override is a loud "deliver to nobody" failure, never a
   * silent success. Resolves with a receipt naming where the alert was
   * accepted (the dev sink or the real provider).
   */
  send: (
    message: CasAlertMessage,
    idempotencyKey: string,
    recipientsOverride?: string[],
  ) => Promise<ProviderDeliveryReceipt>;
};

const PROVIDER_TIMEOUT_MS = 10_000;

function classifyStatus(
  transport: string,
  status: number,
  detail: string,
  isIdempotentReplay: boolean,
  redirectLocation: string | null,
  retryAfterMs?: number,
): CasProviderError | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) {
    return new CasProviderError(
      "rejected",
      `${transport} provider attempted to redirect the submission (HTTP ${status}${redirectLocation ? ` to ${redirectLocation}` : ""}); redirects are never followed because they can drop the alert or forward it to an untrusted endpoint — update the configured provider URL instead`,
      { retryable: false, status },
    );
  }
  if (status === 409) {
    // Only a 409 carrying the documented replay header proves the gateway
    // previously accepted this exact idempotency key; the replay is the
    // duplicate a retry would have created, so it counts as delivered. Any
    // other 409 is an ordinary conflict and must not mark the alert sent.
    if (isIdempotentReplay) return null;
    return new CasProviderError(
      "rejected",
      `${transport} provider reported a conflict that is not a recognized idempotent replay (HTTP 409): ${detail}`,
      { retryable: false, status },
    );
  }
  if (status === 401 || status === 403) {
    return new CasProviderError(
      "authentication",
      `${transport} provider rejected the credentials (HTTP ${status}): ${detail}`,
      { retryable: false, status },
    );
  }
  if (status === 408) {
    return new CasProviderError(
      "socket-timeout",
      `${transport} provider timed out the submission (HTTP 408): ${detail}`,
      { retryable: true, status },
    );
  }
  if (status === 429) {
    return new CasProviderError(
      "rate-limited",
      `${transport} provider rate-limited the submission (HTTP 429): ${detail}`,
      { retryable: true, status, retryAfterMs },
    );
  }
  if (status >= 500) {
    return new CasProviderError(
      "server-outage",
      `${transport} provider is failing (HTTP ${status}): ${detail}`,
      { retryable: true, status, retryAfterMs },
    );
  }
  return new CasProviderError(
    "rejected",
    `${transport} provider rejected the submission (HTTP ${status}): ${detail}`,
    { retryable: false, status },
  );
}

function classifyFetchFailure(
  transport: string,
  error: unknown,
): CasProviderError {
  if (error instanceof CasProviderError) return error;
  const name =
    error instanceof Error
      ? error.name
      : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new CasProviderError(
      "socket-timeout",
      `${transport} provider submission timed out after ${PROVIDER_TIMEOUT_MS}ms`,
      { retryable: true, cause: error },
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new CasProviderError(
    "network",
    `${transport} provider could not be reached: ${detail}`,
    { retryable: true, cause: error },
  );
}

type SubmissionPayload = Record<string, unknown>;

function requireRecipients(
  adapter: ProviderAdapter["transport"],
  recipients: string[],
): string[] {
  if (recipients.length === 0) {
    throw new CasProviderError(
      "not-configured",
      `${adapter} delivery has no recipients: no enabled responder is on this channel and no env fallback list is set. Add a responder in the console (or restore the env list) and re-queue.`,
      { retryable: false },
    );
  }
  return recipients;
}

async function submitToProvider(
  adapter: ProviderAdapter["transport"],
  config: ProviderConfig,
  payloadFor: (recipient: string, key: string) => SubmissionPayload,
  message: CasAlertMessage,
  idempotencyKey: string,
  recipientsOverride?: string[],
): Promise<ProviderDeliveryReceipt> {
  const urlError = providerUrlError(config.url);
  if (urlError) {
    throw new CasProviderError("not-configured", `${adapter} ${urlError}`, {
      retryable: false,
    });
  }
  const recipients = requireRecipients(adapter, recipientsOverride ?? config.recipients);
  // Set when any acceptance (initial or replay) carried the dev sink's
  // marker header — the alert went to the built-in test inbox, not a real
  // provider, and must be labeled simulated downstream.
  let sinkAccepted = false;
  // One provider request per recipient, each carrying a stable key derived
  // from the durable outbox ID. When a retry replays a recipient the provider
  // has already accepted, its idempotency handling (or a 409) suppresses the
  // duplicate.
  for (const recipient of recipients) {
    const key = `${idempotencyKey}:${recipient}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;

    let response: Response;
    try {
      response = await fetch(config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payloadFor(recipient, key)),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        // Never follow redirects: 301/302 can drop the POST body (faking
        // delivery) and 307/308 can forward alert content and credentials to
        // a different, possibly cleartext, origin.
        redirect: "manual",
      });
    } catch (error) {
      throw classifyFetchFailure(adapter, error);
    }

    if (response.headers.get(DEV_PROVIDER_SINK_HEADER) === "true") {
      sinkAccepted = true;
    }
    if (response.status >= 200 && response.status < 300) continue;
    const detail = await response.text().catch(() => "");
    const classified = classifyStatus(
      adapter,
      response.status,
      detail.slice(0, 200) || response.statusText,
      response.headers.get(IDEMPOTENCY_REPLAYED_HEADER) === "true",
      response.headers.get("location"),
      parseRetryAfterMs(response.headers.get("retry-after")),
    );
    if (classified) throw classified;
  }
  return { deliveredTo: deliveredToForEndpoint(config.url, sinkAccepted) };
}

/**
 * Durable duplicate suppression for providers with no idempotency contract
 * (WhatsApp Cloud API, direct SMTP). Every accepted (recipient, outbox
 * item) pair is recorded; a retried send skips recipients whose acceptance
 * is already recorded. If the process dies between provider acceptance and
 * this insert, one duplicate is possible on retry — the ledger makes the
 * common retry paths duplicate-free; only a crash inside that narrow window
 * can still double-send.
 */
/**
 * The recorded acceptance for a key, or undefined when the provider never
 * accepted it. Returns the provenance (deliveredTo) too: a retry that skips
 * every recipient makes no HTTP request, so the ledger is the only place the
 * sink-vs-real distinction survives a crash between acceptance and the SENT
 * mark.
 */
async function deliveryAcceptance(
  keyHash: string,
): Promise<{ deliveredTo: string | null } | undefined> {
  const [recorded] = await db
    .select({ deliveredTo: casProviderDeliveries.deliveredTo })
    .from(casProviderDeliveries)
    .where(eq(casProviderDeliveries.keyHash, keyHash));
  return recorded;
}

async function recordDeliveryAcceptance(
  transport: "EMAIL" | "WHATSAPP",
  incidentId: string,
  keyHash: string,
  recipient: string,
  deliveredTo: string,
): Promise<void> {
  await db
    .insert(casProviderDeliveries)
    .values({
      keyHash,
      transport,
      incidentId,
      recipientMasked: maskRecipient(recipient),
      deliveredTo,
    })
    .onConflictDoNothing();
}

export function createSmsProvider(config: ProviderConfig): ProviderAdapter {
  return {
    transport: "SMS",
    send: (message, idempotencyKey, recipientsOverride) =>
      submitToProvider(
        "SMS",
        config,
        (recipient, key) => ({
          to: recipient,
          from: config.from,
          body: message.body,
          idempotencyKey: key,
        }),
        message,
        idempotencyKey,
        recipientsOverride,
      ),
  };
}

export function createXmppProvider(config: ProviderConfig): ProviderAdapter {
  return {
    transport: "XMPP",
    send: (message, idempotencyKey, recipientsOverride) =>
      submitToProvider(
        "XMPP",
        config,
        (recipient, key) => ({
          to: recipient,
          from: config.from,
          type: "chat",
          // The stanza ID is the XMPP-side dedup handle (XEP-0184 receipts and
          // XEP-0198 resumption both reference stanza IDs).
          stanzaId: key,
          idempotencyKey: key,
          body: message.body,
        }),
        message,
        idempotencyKey,
        recipientsOverride,
      ),
  };
}

export function createEmailProvider(config: ProviderConfig): ProviderAdapter {
  return {
    transport: "EMAIL",
    send: (message, idempotencyKey, recipientsOverride) =>
      submitToProvider(
        "EMAIL",
        config,
        (recipient, key) => ({
          to: recipient,
          from: config.from,
          subject: `CAS ${message.priority} alert ${message.incidentId}`,
          body: message.body,
          idempotencyKey: key,
        }),
        message,
        idempotencyKey,
        recipientsOverride,
      ),
  };
}

/**
 * Direct-SMTP email adapter. Selected when CAS_EMAIL_SMTP_HOST is set (the
 * HTTPS provider path above stays untouched when CAS_EMAIL_PROVIDER_URL is
 * set instead). Duplicate suppression is ledger-based like WhatsApp's —
 * SMTP acceptance has no replay contract — and every failure is a
 * classified CasProviderError from cas-smtp.ts, so a misconfigured mailbox
 * fails loudly in the journal, never silently.
 */
export type SmtpProviderConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from?: string;
  caFile?: string;
  recipients: string[];
};

export function createSmtpEmailProvider(config: SmtpProviderConfig): ProviderAdapter {
  // The sender address defaults to the mailbox login (many providers,
  // Gmail included, refuse any other From). Read the optional CA bundle
  // eagerly so a bad CAS_EMAIL_SMTP_CA_FILE path fails at boot, not
  // mid-incident.
  const from = config.from ?? config.user ?? "";
  const caPem = readSmtpCaPem(config.caFile);
  return {
    transport: "EMAIL",
    send: async (message, idempotencyKey, recipientsOverride) => {
      const recipients = requireRecipients("EMAIL", recipientsOverride ?? config.recipients);
      for (const recipient of recipients) {
        const key = `${idempotencyKey}:${recipient}`;
        const keyHash = createHash("sha256").update(key).digest("hex");
        if (await deliveryAcceptance(keyHash)) continue;
        try {
          await sendSmtpMessage(
            {
              host: config.host,
              port: config.port,
              secure: config.secure,
              user: config.user,
              password: config.password,
              from,
              caPem,
            },
            {
              to: recipient,
              subject: `CAS ${message.priority} alert ${message.incidentId}`,
              bodyText: message.body,
              messageId: keyHash,
            },
          );
        } catch (error) {
          // The journaled error names the masked recipient so responders can
          // tell whose delivery failed without the journal storing addresses.
          if (error instanceof CasProviderError) {
            throw new CasProviderError(
              error.classification,
              `${error.message} (recipient ${maskRecipient(recipient)})`,
              { retryable: error.retryable, cause: error },
            );
          }
          throw error;
        }
        await recordDeliveryAcceptance("EMAIL", message.incidentId, keyHash, recipient, `smtp:${config.host}`);
      }
      return { deliveredTo: `smtp:${config.host}` };
    },
  };
}

/**
 * Console-managed email adapter: the Email delivery page's account rows are
 * resolved per send (console edits apply without a restart), the optional
 * fallback account gets one attempt per recipient when the primary fails,
 * and with no console primary the env-configured path (direct SMTP or the
 * HTTPS provider) behaves exactly as before. Duplicate suppression is the
 * same ledger as the env SMTP adapter — keyed by (outbox item, recipient) —
 * so a fallback re-send can never duplicate a primary acceptance.
 */
export function createConsoleEmailProvider(
  env: NodeJS.ProcessEnv,
  envAdapter: ProviderAdapter | undefined,
): ProviderAdapter {
  // The optional internal-CA bundle applies to console accounts too (same
  // CAS_EMAIL_SMTP_CA_FILE); read eagerly so a bad path fails at boot.
  const caPem = readSmtpCaPem(env.CAS_EMAIL_SMTP_CA_FILE);
  return {
    transport: "EMAIL",
    send: async (message, idempotencyKey, recipientsOverride) => {
      const primary = await getEmailAccount("primary");
      if (!primary) {
        if (!envAdapter) {
          throw new CasProviderError(
            "not-configured",
            "No EMAIL delivery is configured — add an account on the console's Email delivery page or set CAS_EMAIL_SMTP_* / CAS_EMAIL_PROVIDER_URL.",
            { retryable: false },
          );
        }
        return envAdapter.send(message, idempotencyKey, recipientsOverride);
      }
      const fallback = await getEmailAccount("fallback");
      const recipients = requireRecipients("EMAIL", recipientsOverride ?? readProviderRecipients(env, "EMAIL"));
      // The account that actually accepted each recipient — the fallback
      // accepts when the primary fails, so the receipt names real hosts, not
      // just the primary's.
      const acceptedIdentities = new Set<string>();
      for (const recipient of recipients) {
        const keyHash = createHash("sha256").update(`${idempotencyKey}:${recipient}`).digest("hex");
        const prior = await deliveryAcceptance(keyHash);
        if (prior) {
          // Skipped on retry: the ledger's provenance is the only record of
          // who accepted this recipient.
          if (prior.deliveredTo) acceptedIdentities.add(prior.deliveredTo);
          continue;
        }
        const payload = {
          to: recipient,
          subject: `CAS ${message.priority} alert ${message.incidentId}`,
          bodyText: message.body,
          messageId: keyHash,
        };
        let acceptedBy = `smtp:${primary.host}`;
        try {
          await sendSmtpMessage({ ...accountToSmtpConfig(primary), caPem }, payload);
        } catch (primaryError) {
          if (!(primaryError instanceof CasProviderError)) throw primaryError;
          if (!fallback) {
            // The journaled error names the masked recipient, never the address.
            throw new CasProviderError(
              primaryError.classification,
              `${primaryError.message} (recipient ${maskRecipient(recipient)})`,
              { retryable: primaryError.retryable, cause: primaryError },
            );
          }
          try {
            await sendSmtpMessage({ ...accountToSmtpConfig(fallback), caPem }, payload);
            acceptedBy = `smtp:${fallback.host}`;
          } catch (fallbackError) {
            const fb =
              fallbackError instanceof CasProviderError
                ? fallbackError
                : new CasProviderError("network", "unknown fallback failure", { retryable: true });
            // Both accounts refused this recipient: report the primary's
            // classification with the fallback's outcome appended; retryable
            // when either leg was transient, since a retry could catch a
            // recovered account.
            throw new CasProviderError(
              primaryError.classification,
              `${primaryError.message} (recipient ${maskRecipient(recipient)}); fallback account also failed — ${fb.classification}: ${fb.message}`,
              { retryable: primaryError.retryable || fb.retryable, cause: primaryError },
            );
          }
        }
        await recordDeliveryAcceptance("EMAIL", message.incidentId, keyHash, recipient, acceptedBy);
        acceptedIdentities.add(acceptedBy);
      }
      return {
        deliveredTo: [...acceptedIdentities].sort().join(", ") || `smtp:${primary.host}`,
      };
    },
  };
}

export function createWhatsAppProvider(config: ProviderConfig): ProviderAdapter {
  return {
    transport: "WHATSAPP",
    send: async (message, idempotencyKey, recipientsOverride) => {
      const urlError = providerUrlError(config.url);
      if (urlError) {
        throw new CasProviderError("not-configured", `WHATSAPP ${urlError}`, {
          retryable: false,
        });
      }
      const recipients = requireRecipients("WHATSAPP", recipientsOverride ?? config.recipients);
      // The WhatsApp Business Cloud API has no idempotency contract: unknown
      // body fields are rejected and the Idempotency-Key header is ignored.
      // Duplicate suppression is therefore durable on our side via the
      // cas_provider_deliveries ledger — a retried send (worker crash after
      // partial acceptance, claim expiry) skips recipients whose acceptance
      // is already recorded instead of messaging them twice.
      // Tracks the dev sink's marker header like the other adapters.
      let sinkAccepted = false;
      for (const recipient of recipients) {
        const key = `${idempotencyKey}:${recipient}`;
        const keyHash = createHash("sha256").update(key).digest("hex");
        const prior = await deliveryAcceptance(keyHash);
        if (prior) {
          // A retry that skips every recipient makes no HTTP request, so the
          // ledger's provenance is the only record of where the acceptance
          // happened — trust it, or a sink delivery would be mislabeled real.
          if (prior.deliveredTo === DEV_SINK_DELIVERED_TO) sinkAccepted = true;
          continue;
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          // Still sent: a gateway in front of Meta (or the dev provider
          // sink) can honor the replay contract even though Meta cannot.
          "Idempotency-Key": key,
        };
        if (config.token) headers.Authorization = `Bearer ${config.token}`;

        let response: Response;
        try {
          response = await fetch(config.url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              // Strict WhatsApp Business Cloud API message shape — only
              // fields the API defines. The sender phone-number ID is part
              // of the configured endpoint path, not the body.
              messaging_product: "whatsapp",
              to: recipient,
              type: "text",
              text: { body: message.body },
            }),
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
            redirect: "manual",
          });
        } catch (error) {
          throw classifyFetchFailure("WHATSAPP", error);
        }

        const acceptedBySink =
          response.headers.get(DEV_PROVIDER_SINK_HEADER) === "true";
        if (acceptedBySink) sinkAccepted = true;
        const provenance = acceptedBySink
          ? DEV_SINK_DELIVERED_TO
          : deliveredToForEndpoint(config.url, false);
        if (response.status >= 200 && response.status < 300) {
          await recordDeliveryAcceptance("WHATSAPP", message.incidentId, keyHash, recipient, provenance);
          continue;
        }
        const detail = await response.text().catch(() => "");
        const classified = classifyStatus(
          "WHATSAPP",
          response.status,
          detail.slice(0, 200) || response.statusText,
          response.headers.get(IDEMPOTENCY_REPLAYED_HEADER) === "true",
          response.headers.get("location"),
          parseRetryAfterMs(response.headers.get("retry-after")),
        );
        if (classified) throw classified;
        // A documented replay (409 + replay header) means an earlier attempt
        // was accepted; that acceptance may predate the ledger insert (the
        // crash window the ledger exists for), so record its provenance now.
        await recordDeliveryAcceptance("WHATSAPP", message.incidentId, keyHash, recipient, provenance);
      }
      return { deliveredTo: deliveredToForEndpoint(config.url, sinkAccepted) };
    },
  };
}

function readConfig(
  env: NodeJS.ProcessEnv,
  transport: GatewayTransport,
): ProviderConfig | undefined {
  const endpoint = readProviderEndpoint(env, transport);
  if (!endpoint) return undefined;
  return { ...endpoint, recipients: readProviderRecipients(env, transport) };
}

export type CasProviderAdapters = {
  sms?: ProviderAdapter;
  xmpp?: ProviderAdapter;
  email?: ProviderAdapter;
  whatsapp?: ProviderAdapter;
};

/**
 * Builds adapters for every transport with a provider endpoint configured.
 * Recipients are no longer part of "configured": they are resolved per send
 * (console-managed responders, falling back to the env list), so an operator
 * can move the whole recipient circle into the console without keeping a
 * redundant env copy.
 */
export function loadConfiguredProviders(
  env: NodeJS.ProcessEnv = process.env,
): CasProviderAdapters {
  // Both email paths set at once is contradictory; abort loudly (this runs
  // at boot via the outbox worker wiring) instead of silently picking one.
  assertUnambiguousEmailConfig(env);
  const sms = readConfig(env, "SMS");
  const xmpp = readConfig(env, "XMPP");
  const email = readConfig(env, "EMAIL");
  const emailSmtp = readEmailSmtpConfig(env);
  const whatsapp = readConfig(env, "WHATSAPP");
  return {
    sms: sms ? createSmsProvider(sms) : undefined,
    xmpp: xmpp ? createXmppProvider(xmpp) : undefined,
    // Always present: console account rows (Email delivery page) are
    // resolved per send, with the env-configured adapter as the fallback
    // path when no console primary exists.
    email: createConsoleEmailProvider(
      env,
      emailSmtp
        ? createSmtpEmailProvider({
            ...emailSmtp,
            recipients: readProviderRecipients(env, "EMAIL"),
          })
        : email
          ? createEmailProvider(email)
          : undefined,
    ),
    whatsapp: whatsapp ? createWhatsAppProvider(whatsapp) : undefined,
  };
}

/**
 * Legacy fan-out rule: gateway transports with a complete provider
 * configuration (URL plus at least one env-listed recipient). Retained for
 * the pre-console fallback path and its tests; live fan-out uses
 * deliverableGatewayTransports (cas-delivery-config), which reads the
 * console-managed responder circle.
 */
export function configuredProviderTransports(
  env: NodeJS.ProcessEnv = process.env,
): Array<"SMS" | "XMPP" | "EMAIL" | "WHATSAPP"> {
  return GATEWAY_TRANSPORTS.filter((transport) => {
    const configured =
      transport === "EMAIL"
        ? emailChannelConfigured(env)
        : readProviderEndpoint(env, transport) !== undefined;
    return configured && readProviderRecipients(env, transport).length > 0;
  });
}

/**
 * Builds the delivery sender the outbox worker uses by default. It dispatches
 * on the outbox item's transport and fails explicitly when no provider is
 * configured for that transport, so a misconfigured deployment surfaces as a
 * classified, retryable-visible outbox failure instead of a silent no-op.
 */
export function createCasDeliverySender(
  adapters: CasProviderAdapters,
): CasDeliverySender {
  return async (item, idempotencyKey) => {
    const adapter =
      item.transport === "SMS"
        ? adapters.sms
        : item.transport === "XMPP"
          ? adapters.xmpp
          : item.transport === "EMAIL"
            ? adapters.email
            : item.transport === "WHATSAPP"
              ? adapters.whatsapp
              : undefined;
    if (!adapter) {
      throw new CasProviderError(
        "not-configured",
        `No ${item.transport} delivery provider is configured; queued alert cannot reach responders.`,
        { retryable: false },
      );
    }
    // The alert text carries the incident's position fix (accuracy radius and
    // fix age included) so responders get a trustworthy where, not a bare
    // "location follows". Read at send time: a repeat trigger may have stored
    // a fresher fix after the outbox item was queued.
    const location = await loadIncidentLocation(item.incidentId);
    // Wording comes from the channel's console-editable template (default
    // when never edited), and recipients from the console-managed responder
    // circle. A null recipient resolution means the responders table is
    // empty, so the adapter's env-configured list stays the fallback.
    const templateBody = isCasTemplateChannel(item.transport)
      ? await resolveTemplateBody(item.transport)
      : DEFAULT_TEMPLATE_BODY;
    const dbRecipients = isCasTemplateChannel(item.transport)
      ? await resolveDbRecipients(item.transport)
      : null;
    // The receipt names where the alert was accepted so the outbox record
    // (and the console) can tell a real provider from the dev test inbox.
    return adapter.send(
      buildCasAlertMessage(item, location, templateBody),
      idempotencyKey,
      dbRecipients ?? undefined,
    );
  };
}

/** The incident row's stored fix, or null when the alert went out with none. */
async function loadIncidentLocation(incidentId: string): Promise<CasIncidentLocation | null> {
  const rows = await db
    .select({
      latitude: casIncidents.locationLatitude,
      longitude: casIncidents.locationLongitude,
      accuracyM: casIncidents.locationAccuracyM,
      capturedAt: casIncidents.locationCapturedAt,
    })
    .from(casIncidents)
    .where(eq(casIncidents.id, incidentId))
    .limit(1);
  const row = rows[0];
  if (!row || row.latitude == null || row.longitude == null || row.accuracyM == null || row.capturedAt == null) {
    return null;
  }
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    accuracyM: row.accuracyM,
    capturedAt: row.capturedAt,
  };
}
