import { logger } from "./logger";
import { probeSmtpAccount, readSmtpCaPem, type SmtpSendConfig } from "./cas-smtp";
import { CasProviderError } from "./delivery-providers";
import { readEmailSmtpConfig } from "./cas-provider-env";
import {
  accountToSmtpConfig,
  getEmailAccount,
  type EmailAccountRow,
  type EmailAccountSlot,
} from "./cas-email-accounts";
import {
  markCasEmailProbeStopped,
  recordCasEmailProbeFailure,
  recordCasEmailProbeOk,
  recordCasEmailProbeSkipped,
  registerCasEmailChannelHealth,
} from "./cas-email-health";

/**
 * Weekly AUTH-only probe of the mailbox behind the email alert channel.
 *
 * The mailbox app password can silently rot — the owner revokes it, the
 * provider expires the account for inactivity, a password reset invalidates
 * it — and without this worker nobody finds out until a real alert
 * dead-letters mid-incident. The probe mirrors the outbox worker's
 * supervision pattern but runs probeSmtpAccount: connect + TLS + AUTH, then
 * QUIT. No email is ever sent and no credential leaves the existing
 * secrets/database rows.
 *
 * The probe target is re-resolved every tick, so console edits to the Email
 * delivery page apply without a restart, matching how the delivery adapter
 * resolves accounts per send:
 * - console primary account (plus the fallback, when one is stored — a
 *   silently dead fallback is the same rot one slot over),
 * - otherwise the CAS_EMAIL_SMTP_* environment configuration,
 * - otherwise probing does not apply (HTTPS provider, or email off) and the
 *   registry records a skipped tick with the reason, never a false alarm.
 *
 * The first probe runs CAS_EMAIL_PROBE_DELAY_MS after boot (default 15s) so
 * a credential revoked while the server was down is caught at the next
 * deploy/restart, not a week later.
 */

export const DEFAULT_CAS_EMAIL_PROBE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_CAS_EMAIL_PROBE_DELAY_MS = 15_000;

type CasEmailProbeLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

type SmtpProbeConfig = Omit<SmtpSendConfig, "from"> & { from?: string };

export interface CasEmailHealthWorkerOptions {
  /** Milliseconds between probes. Defaults to CAS_EMAIL_PROBE_INTERVAL_MS or 7 days. */
  intervalMs?: number;
  /** Delay before the first probe. Defaults to CAS_EMAIL_PROBE_DELAY_MS or 15s. */
  initialDelayMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: CasEmailProbeLogger;
  /** Overridable probe, for tests. Defaults to probeSmtpAccount. */
  probe?: (config: SmtpProbeConfig) => Promise<void>;
  /** Overridable account lookup, for tests. Defaults to the database rows. */
  getAccount?: (slot: EmailAccountSlot) => Promise<EmailAccountRow | undefined>;
}

export interface CasEmailHealthWorkerHandle {
  /** Clears the timers and waits for any in-flight probe to settle. */
  stop: () => Promise<void>;
}

function readPositiveIntEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} value: "${raw}" (expected a positive integer)`);
  }
  return value;
}

/**
 * Resolves which mailbox(es) the probe must authenticate against this tick,
 * following the same precedence as the delivery path: a stored console
 * primary row owns the channel; the environment is the fallback.
 */
async function resolveProbeTargets(
  env: NodeJS.ProcessEnv,
  getAccount: (slot: EmailAccountSlot) => Promise<EmailAccountRow | undefined>,
): Promise<
  | { kind: "smtp"; target: "console" | "environment"; accounts: Array<{ label: string; config: SmtpProbeConfig }> }
  | { kind: "skip"; note: string }
> {
  const primary = await getAccount("primary");
  if (primary) {
    // The optional internal-CA bundle applies to console accounts too, the
    // same as the delivery adapter (createConsoleEmailProvider) — a probe
    // that trusted fewer CAs than the sender would cry wolf.
    const caPem = readSmtpCaPem(env.CAS_EMAIL_SMTP_CA_FILE?.trim() || undefined);
    const accounts = [{ label: "primary", config: { ...accountToSmtpConfig(primary), caPem } }];
    const fallback = await getAccount("fallback");
    if (fallback) accounts.push({ label: "fallback", config: { ...accountToSmtpConfig(fallback), caPem } });
    return { kind: "smtp", target: "console", accounts };
  }
  const envSmtp = readEmailSmtpConfig(env);
  if (envSmtp) {
    return {
      kind: "smtp",
      target: "environment",
      accounts: [
        {
          label: "mailbox",
          config: {
            host: envSmtp.host,
            port: envSmtp.port,
            secure: envSmtp.secure,
            user: envSmtp.user,
            password: envSmtp.password,
            from: envSmtp.from,
            caPem: readSmtpCaPem(envSmtp.caFile),
          },
        },
      ],
    };
  }
  if (env.CAS_EMAIL_PROVIDER_URL?.trim()) {
    return {
      kind: "skip",
      note: "Email alerts go through the HTTPS submission provider (CAS_EMAIL_PROVIDER_URL); the mailbox AUTH probe does not apply.",
    };
  }
  return {
    kind: "skip",
    note: "No email delivery is configured, so there is no mailbox to probe.",
  };
}

export function startCasEmailHealthWorker(
  options: CasEmailHealthWorkerOptions = {},
): CasEmailHealthWorkerHandle {
  const env = options.env ?? process.env;
  const intervalMs =
    options.intervalMs ??
    readPositiveIntEnv(env, "CAS_EMAIL_PROBE_INTERVAL_MS") ??
    DEFAULT_CAS_EMAIL_PROBE_INTERVAL_MS;
  const initialDelayMs =
    options.initialDelayMs ??
    readPositiveIntEnv(env, "CAS_EMAIL_PROBE_DELAY_MS") ??
    DEFAULT_CAS_EMAIL_PROBE_DELAY_MS;
  const log = options.log ?? logger;
  const probe = options.probe ?? probeSmtpAccount;
  const getAccount = options.getAccount ?? getEmailAccount;

  let stopped = false;
  let inFlight: Promise<void> | null = null;

  registerCasEmailChannelHealth({ probeIntervalMs: intervalMs });

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const resolved = await resolveProbeTargets(env, getAccount);
      if (resolved.kind === "skip") {
        recordCasEmailProbeSkipped(resolved.note);
        return;
      }
      // Every account that would be used to send must authenticate. A dead
      // fallback is reported too — it is the same silent rot one slot over.
      const failures: Array<{ label: string; classification: string; message: string }> = [];
      for (const account of resolved.accounts) {
        try {
          await probe(account.config);
        } catch (error) {
          failures.push({
            label: account.label,
            classification:
              error instanceof CasProviderError ? error.classification : "probe-error",
            message:
              error instanceof CasProviderError
                ? error.message
                : `Mailbox probe crashed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (failures.length === 0) {
        recordCasEmailProbeOk(resolved.target);
        log.info({ target: resolved.target }, "CAS email mailbox probe passed");
        return;
      }
      const first = failures[0];
      recordCasEmailProbeFailure(resolved.target, {
        classification: first.classification,
        message:
          failures.length === 1
            ? `${first.label === "mailbox" ? "Mailbox" : `${first.label} mailbox`} login check failed: ${first.message}`
            : failures
                .map((failure) => `${failure.label} mailbox: ${failure.message}`)
                .join("; "),
      });
      log.warn(
        { target: resolved.target, classification: first.classification },
        "CAS email mailbox probe failed",
      );
    } catch (error) {
      // A resolution failure (e.g. a DB hiccup reading the account rows)
      // must never kill the loop — but it is recorded, because a probe that
      // cannot run leaves the mailbox unwatched.
      recordCasEmailProbeFailure("environment", {
        classification: "probe-error",
        message: `Mailbox probe could not run: ${error instanceof Error ? error.message : String(error)}`,
      });
      log.error({ err: error }, "CAS email mailbox probe tick failed");
    }
  };

  const timer = setInterval(() => {
    if (!inFlight) {
      inFlight = tick().finally(() => {
        inFlight = null;
      });
    }
  }, intervalMs);
  // First probe shortly after boot: a credential revoked while the server
  // was down is caught at restart, not one interval (a week) later.
  const initialTimer = setTimeout(() => {
    if (!inFlight) {
      inFlight = tick().finally(() => {
        inFlight = null;
      });
    }
  }, initialDelayMs);
  // The worker must never keep the process alive on its own.
  timer.unref();
  initialTimer.unref();

  log.info(
    { intervalMs, initialDelayMs },
    "CAS email mailbox probe worker started",
  );

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(initialTimer);
      if (inFlight) {
        await inFlight.catch(() => {
          /* tick errors are already recorded inside tick() */
        });
      }
      markCasEmailProbeStopped();
      log.info({}, "CAS email mailbox probe worker stopped");
    },
  };
}
