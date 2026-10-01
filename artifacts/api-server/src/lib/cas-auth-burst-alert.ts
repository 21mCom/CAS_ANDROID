import { logger } from "./logger";

/**
 * Pager hook for credential-guessing bursts on deployments that cannot scan
 * their own logs.
 *
 * The self-hosting runbook (SELF-HOSTING.md Step 10) turns the tarpit's
 * `casAuthRejectionBurst` log line into an email with a once-a-minute cron
 * watchdog reading the systemd journal. A Replit Reserved VM deployment has
 * no cron and no journal access — its logs are only visible in the Replit UI
 * — so the recipe cannot be copied. Instead the server pings the alerting
 * check itself, from inside the process that detects the burst:
 *
 * - `CAS_AUTH_BURST_ALERT_URL` holds a healthchecks.io-style check ping URL
 *   (a second, dedicated check — never the uptime monitor's).
 * - On every burst threshold crossing the server GETs `<url>/fail`, which
 *   flips the check down immediately and triggers the alert email/SMS.
 * - Every `intervalMs` (default 5 minutes) it GETs the plain URL, which
 *   keeps the check green in quiet times and flips it back up after an
 *   incident — the same recovery semantics as the cron watchdog. A success
 *   ping is suppressed for `suppressMs` (default 10 minutes, matching the
 *   tarpit's streak-decay window) after the last burst, so the check is not
 *   flipped back up mid-flood.
 *
 * Pings are delivered through a serialized queue with a bounded timeout, so
 * a success ping can never land after a /fail and clear the alert
 * mid-incident. A failed or non-2xx ping is logged and otherwise ignored —
 * an unreachable alerting service can never break request handling. With the
 * variable unset the worker does not start and bursts remain log-only.
 */

export const DEFAULT_CAS_AUTH_BURST_ALERT_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_CAS_AUTH_BURST_ALERT_SUPPRESS_MS = 10 * 60_000;
export const DEFAULT_CAS_AUTH_BURST_ALERT_INITIAL_DELAY_MS = 10_000;
const PING_TIMEOUT_MS = 10_000;

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<unknown>;

type BurstAlertLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
};

export interface CasAuthBurstAlertOptions {
  /** Ping URL. Defaults to the CAS_AUTH_BURST_ALERT_URL environment variable. */
  url?: string;
  /** Milliseconds between quiet-time success pings. Default 5 minutes. */
  intervalMs?: number;
  /** Quiet period after a burst during which success pings are suppressed. Default 10 minutes. */
  suppressMs?: number;
  /** Delay before the first success ping. Default 10 seconds. */
  initialDelayMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  log?: BurstAlertLogger;
  /** Clock override for tests. */
  now?: () => number;
}

export interface CasAuthBurstAlertHandle {
  /** Fire-and-forget: ping the check's /fail URL and start the suppression window. */
  recordBurst: () => void;
  /** Clears the timers and waits for any in-flight ping to settle. */
  stop: () => Promise<void>;
}

/**
 * Reads and validates the configured ping URL. Returns undefined when unset;
 * throws on a malformed or non-HTTP(S) value so a typo fails loudly at boot
 * instead of silently disabling the alert.
 */
export function resolveCasAuthBurstAlertUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.CAS_AUTH_BURST_ALERT_URL?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Invalid CAS_AUTH_BURST_ALERT_URL value: "${raw}" (expected an absolute http(s) ping URL)`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Invalid CAS_AUTH_BURST_ALERT_URL value: "${raw}" (only http(s) ping URLs are supported)`,
    );
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Starts the burst-alert pinger, or returns null when
 * CAS_AUTH_BURST_ALERT_URL is not configured (bursts then stay log-only).
 */
export function startCasAuthBurstAlert(
  options: CasAuthBurstAlertOptions = {},
): CasAuthBurstAlertHandle | null {
  const rawUrl = options.url ?? resolveCasAuthBurstAlertUrl(options.env ?? process.env);
  if (!rawUrl) return null;
  const url = rawUrl.replace(/\/+$/, "");

  const intervalMs = options.intervalMs ?? DEFAULT_CAS_AUTH_BURST_ALERT_INTERVAL_MS;
  const suppressMs = options.suppressMs ?? DEFAULT_CAS_AUTH_BURST_ALERT_SUPPRESS_MS;
  const initialDelayMs =
    options.initialDelayMs ?? DEFAULT_CAS_AUTH_BURST_ALERT_INITIAL_DELAY_MS;
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const log = options.log ?? logger;
  const now = options.now ?? Date.now;

  const failUrl = `${url}/fail`;

  let stopped = false;
  let lastBurstAt: number | undefined;
  // Pings are delivered through one serialized chain: a /fail ping is never
  // sent while an earlier success ping is still in flight, so a success
  // response can never arrive at the check after the /fail and clear the
  // alert mid-incident. stop() awaits the whole chain, draining every
  // pending ping — not just the latest one.
  let chain: Promise<void> = Promise.resolve();

  const deliver = async (target: string, kind: "success" | "fail"): Promise<void> => {
    try {
      const res = await fetchImpl(target, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      // A resolved promise is not a delivered alert: the ping endpoint can
      // answer 404/429/503, and those must surface as warnings exactly like
      // a network failure, or the pager fails silently.
      const status =
        res && typeof res === "object" && "status" in res
          ? Number((res as { status: unknown }).status)
          : undefined;
      const rejectedByBody =
        res && typeof res === "object" && "ok" in res
          ? (res as { ok: unknown }).ok === false
          : false;
      if (rejectedByBody || (status !== undefined && (status < 200 || status >= 300))) {
        log.warn({ kind, status }, "CAS auth burst alert ping rejected");
        return;
      }
      log.debug?.({ kind }, "CAS auth burst alert ping sent");
    } catch (error) {
      // A failed ping must never break the server — but it is logged,
      // because a pinger that cannot reach its check leaves bursts
      // unwatched.
      log.warn({ err: error, kind }, "CAS auth burst alert ping failed");
    }
  };

  const enqueue = (target: string, kind: "success" | "fail"): void => {
    chain = chain.then(() => {
      // No `stopped` check here: pings already queued when stop() begins are
      // drained, not dropped — stop() only refuses NEW work.
      // Suppression is re-checked at send time, not just at enqueue time: a
      // success ping queued before a burst must not go out after it and
      // flip the check back up mid-flood.
      if (kind === "success" && lastBurstAt !== undefined && now() - lastBurstAt < suppressMs) {
        return;
      }
      return deliver(target, kind);
    });
  };

  const tick = (): void => {
    if (stopped) return;
    // A burst inside the suppression window keeps the check down on its own;
    // a success ping now would flip it back up mid-flood.
    if (lastBurstAt !== undefined && now() - lastBurstAt < suppressMs) return;
    enqueue(url, "success");
  };

  const timer = setInterval(tick, intervalMs);
  // First success ping shortly after boot so the check goes green as soon as
  // the operator finishes wiring the URL (and a wrong URL surfaces in the
  // logs immediately, not one interval later).
  const initialTimer = setTimeout(tick, initialDelayMs);
  // The worker must never keep the process alive on its own.
  timer.unref();
  initialTimer.unref();

  log.info(
    { intervalMs, suppressMs },
    "CAS auth burst alert pinger started",
  );

  return {
    recordBurst: () => {
      if (stopped) return;
      lastBurstAt = now();
      enqueue(failUrl, "fail");
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(initialTimer);
      await chain;
      log.info({}, "CAS auth burst alert pinger stopped");
    },
  };
}
