import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { casIncidents, casProviderDeliveries } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { CasOutbox } from "@workspace/db/schema";
import { maskRecipient } from "./cas-device-delivery";
import {
  GATEWAY_TRANSPORTS,
  readProviderEndpoint,
  readProviderRecipients,
  type GatewayTransport,
} from "./cas-provider-env";
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
 * EMAIL:
 *   CAS_EMAIL_PROVIDER_URL   HTTPS endpoint of the mail submission API
 *   CAS_EMAIL_PROVIDER_TOKEN bearer token for the provider (optional)
 *   CAS_EMAIL_FROM           sender address (optional)
 *   CAS_EMAIL_RECIPIENTS     comma-separated recipient addresses (required)
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

export type ProviderErrorClassification =
  | "not-configured"
  | "network"
  | "socket-timeout"
  | "rate-limited"
  | "server-outage"
  | "authentication"
  | "rejected";

export class CasProviderError extends Error {
  readonly classification: ProviderErrorClassification;
  readonly retryable: boolean;
  readonly status?: number;
  /**
   * Minimum delay the provider asked for before the next attempt (from its
   * Retry-After header), when the hint was present and sane. The outbox
   * worker treats this as a lower bound on top of its own backoff.
   */
  readonly retryAfterMs?: number;

  constructor(
    classification: ProviderErrorClassification,
    message: string,
    options: {
      retryable: boolean;
      status?: number;
      cause?: unknown;
      retryAfterMs?: number;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "CasProviderError";
    this.classification = classification;
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

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

export type ProviderAdapter = {
  transport: "SMS" | "XMPP" | "EMAIL" | "WHATSAPP";
  /**
   * Sends to the given recipients, or to the adapter's configured (env)
   * recipients when `recipientsOverride` is omitted. The console-managed
   * responder circle is passed as the override by the delivery sender; an
   * explicitly empty override is a loud "deliver to nobody" failure, never a
   * silent success.
   */
  send: (
    message: CasAlertMessage,
    idempotencyKey: string,
    recipientsOverride?: string[],
  ) => Promise<void>;
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
): Promise<void> {
  const urlError = providerUrlError(config.url);
  if (urlError) {
    throw new CasProviderError("not-configured", `${adapter} ${urlError}`, {
      retryable: false,
    });
  }
  const recipients = requireRecipients(adapter, recipientsOverride ?? config.recipients);
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
      for (const recipient of recipients) {
        const key = `${idempotencyKey}:${recipient}`;
        const keyHash = createHash("sha256").update(key).digest("hex");
        const [recorded] = await db
          .select({ keyHash: casProviderDeliveries.keyHash })
          .from(casProviderDeliveries)
          .where(eq(casProviderDeliveries.keyHash, keyHash));
        if (recorded) continue;

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

        if (response.status >= 200 && response.status < 300) {
          // Record acceptance before moving on. If the process dies between
          // the provider's 2xx and this insert, one duplicate is possible on
          // retry — the ledger makes the common retry paths duplicate-free;
          // only a crash inside this narrow window can still double-send.
          await db
            .insert(casProviderDeliveries)
            .values({
              keyHash,
              transport: "WHATSAPP",
              incidentId: message.incidentId,
              recipientMasked: maskRecipient(recipient),
            })
            .onConflictDoNothing();
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
      }
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
  const sms = readConfig(env, "SMS");
  const xmpp = readConfig(env, "XMPP");
  const email = readConfig(env, "EMAIL");
  const whatsapp = readConfig(env, "WHATSAPP");
  return {
    sms: sms ? createSmsProvider(sms) : undefined,
    xmpp: xmpp ? createXmppProvider(xmpp) : undefined,
    email: email ? createEmailProvider(email) : undefined,
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
  return GATEWAY_TRANSPORTS.filter(
    (transport) =>
      readProviderEndpoint(env, transport) !== undefined &&
      readProviderRecipients(env, transport).length > 0,
  );
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
    await adapter.send(
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
