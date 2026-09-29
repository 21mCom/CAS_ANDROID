/**
 * The error taxonomy every CAS delivery adapter classifies into, extracted
 * so both the HTTPS provider adapters (delivery-providers.ts) and the SMTP
 * client (cas-smtp.ts) share one definition without an import cycle. The
 * outbox worker keys its retry/dead-letter behavior off `retryable`, and
 * `classification` is what the incident journal and the console's outbox
 * status surface name.
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
