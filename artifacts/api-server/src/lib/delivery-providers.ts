import type { CasOutbox } from "@workspace/db/schema";
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

export function buildCasAlertMessage(item: CasOutbox): CasAlertMessage {
  const timestamp = item.createdAt.toISOString().replace("T", " ").slice(0, 16);
  return {
    incidentId: item.incidentId,
    transport: item.transport,
    priority: item.priority,
    body:
      `CAS ${item.priority} alert ${item.incidentId} at ${timestamp}Z. ` +
      "Begin response protocol. Do not call handset. Location follows.",
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
  transport: "SMS" | "XMPP" | "EMAIL";
  send: (message: CasAlertMessage, idempotencyKey: string) => Promise<void>;
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

async function submitToProvider(
  adapter: ProviderAdapter["transport"],
  config: ProviderConfig,
  payloadFor: (recipient: string, key: string) => SubmissionPayload,
  message: CasAlertMessage,
  idempotencyKey: string,
): Promise<void> {
  const urlError = providerUrlError(config.url);
  if (urlError) {
    throw new CasProviderError("not-configured", `${adapter} ${urlError}`, {
      retryable: false,
    });
  }
  // One provider request per recipient, each carrying a stable key derived
  // from the durable outbox ID. When a retry replays a recipient the provider
  // has already accepted, its idempotency handling (or a 409) suppresses the
  // duplicate.
  for (const recipient of config.recipients) {
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
    send: (message, idempotencyKey) =>
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
      ),
  };
}

export function createXmppProvider(config: ProviderConfig): ProviderAdapter {
  return {
    transport: "XMPP",
    send: (message, idempotencyKey) =>
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
      ),
  };
}

export function createEmailProvider(config: ProviderConfig): ProviderAdapter {
  return {
    transport: "EMAIL",
    send: (message, idempotencyKey) =>
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
      ),
  };
}

function parseRecipients(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readConfig(
  env: NodeJS.ProcessEnv,
  prefix: "CAS_SMS" | "CAS_XMPP" | "CAS_EMAIL",
  fromKey: string,
): ProviderConfig | undefined {
  const url = env[`${prefix}_PROVIDER_URL`];
  if (!url) return undefined;
  const recipients = parseRecipients(env[`${prefix}_RECIPIENTS`]);
  if (recipients.length === 0) return undefined;
  return {
    url,
    token: env[`${prefix}_PROVIDER_TOKEN`] || undefined,
    from: env[fromKey] || undefined,
    recipients,
  };
}

export type CasProviderAdapters = {
  sms?: ProviderAdapter;
  xmpp?: ProviderAdapter;
  email?: ProviderAdapter;
};

export function loadConfiguredProviders(
  env: NodeJS.ProcessEnv = process.env,
): CasProviderAdapters {
  const sms = readConfig(env, "CAS_SMS", "CAS_SMS_FROM");
  const xmpp = readConfig(env, "CAS_XMPP", "CAS_XMPP_FROM_JID");
  const email = readConfig(env, "CAS_EMAIL", "CAS_EMAIL_FROM");
  return {
    sms: sms ? createSmsProvider(sms) : undefined,
    xmpp: xmpp ? createXmppProvider(xmpp) : undefined,
    email: email ? createEmailProvider(email) : undefined,
  };
}

/**
 * Gateway transports with a complete provider configuration (URL plus at
 * least one recipient). The trigger route only queues outbox items for these
 * channels — an unconfigured channel must not create an outbox row that can
 * only ever dead-letter, because that noise trains responders to ignore the
 * dead-letter alarm.
 */
export function configuredProviderTransports(
  env: NodeJS.ProcessEnv = process.env,
): Array<"SMS" | "XMPP" | "EMAIL"> {
  const transports: Array<"SMS" | "XMPP" | "EMAIL"> = [];
  if (readConfig(env, "CAS_SMS", "CAS_SMS_FROM")) transports.push("SMS");
  if (readConfig(env, "CAS_XMPP", "CAS_XMPP_FROM_JID")) transports.push("XMPP");
  if (readConfig(env, "CAS_EMAIL", "CAS_EMAIL_FROM")) transports.push("EMAIL");
  return transports;
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
            : undefined;
    if (!adapter) {
      throw new CasProviderError(
        "not-configured",
        `No ${item.transport} delivery provider is configured; queued alert cannot reach responders.`,
        { retryable: false },
      );
    }
    await adapter.send(buildCasAlertMessage(item), idempotencyKey);
  };
}
