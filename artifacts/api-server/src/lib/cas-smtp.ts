import { Socket } from "node:net";
import { connect as connectTls, TLSSocket, type ConnectionOptions } from "node:tls";
import { readFileSync } from "node:fs";
import { CasProviderError } from "./delivery-providers";
import { maskRecipient } from "./cas-device-delivery";

/**
 * Minimal SMTP submission client for the CAS email channel.
 *
 * The other alert transports POST to an HTTPS gateway; email additionally
 * supports submitting directly through a real mailbox's SMTP service (e.g. a
 * dedicated Gmail account with an app password) so a personal-scale
 * deployment needs nothing more than a mailbox to activate email alerts.
 *
 * Hard rules, matching the provider-gateway contract of the other channels:
 * - TLS is mandatory. Port 465 uses implicit TLS; any other port requires
 *   the server to advertise STARTTLS, and AUTH is never sent before the
 *   connection is encrypted. A server without TLS fails the delivery
 *   permanently and loudly instead of falling back to cleartext.
 * - Certificate verification is never disabled: a wrong-host or intercepted
 *   certificate fails the delivery before credentials or alert content are
 *   sent. Self-hosted relays behind an internal CA use CAS_EMAIL_SMTP_CA_FILE.
 * - Credentials come only from server secrets (CAS_EMAIL_SMTP_USER /
 *   CAS_EMAIL_SMTP_PASSWORD) and are never logged.
 * - Failures classify into the same CasProviderError taxonomy the outbox
 *   worker already understands, so a misconfigured mailbox surfaces as a
 *   classified, journaled failure — never a silent drop.
 */

export const SMTP_TIMEOUT_MS = 10_000;

/**
 * Bound on retained reply text. EHLO capability lists must survive intact —
 * truncating one could hide a late STARTTLS advertisement and get a capable
 * server misclassified as cleartext-only — so this stays far above any
 * realistic reply. Only the copies embedded in error messages are trimmed
 * further, after redaction (see redactEchoedAddresses).
 */
const SMTP_MAX_REPLY_TEXT = 4_000;

export type SmtpSendConfig = {
  host: string;
  port: number;
  /** Implicit TLS from connect (port 465). Otherwise STARTTLS is required. */
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  /** Extra CA bundle (PEM) to trust, e.g. an internal CA on a self-hosted relay. */
  caPem?: string;
};

export type SmtpMessage = {
  to: string;
  subject: string;
  bodyText: string;
  /** Stable per-(outbox item, recipient) id, used for the Message-ID header. */
  messageId: string;
};

/** A complete reply the server sent that was not the success code. */
export class SmtpReplyError extends Error {
  readonly code: number;
  readonly stage: string;
  constructor(stage: string, code: number, text: string) {
    super(`SMTP ${stage} rejected (${code}): ${text}`);
    this.name = "SmtpReplyError";
    this.code = code;
    this.stage = stage;
  }
}

type SmtpReply = { code: number; text: string };

/**
 * Line-oriented SMTP protocol engine. Owns the current socket (plaintext
 * first, TLS after connect/STARTTLS), reads replies with "250-"
 * continuation handling, and routes socket errors/timeouts to whichever
 * read is in flight so a dead server can never hang the outbox worker.
 */
class SmtpSession {
  private socket: Socket | TLSSocket;
  private buffer = "";
  private lines: string[] = [];
  private waiter: (() => void) | null = null;
  private failure: Error | null = null;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.bind(socket);
  }

  private bind(socket: Socket | TLSSocket) {
    socket.setEncoding("utf8");
    socket.setTimeout(SMTP_TIMEOUT_MS);
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\r\n")) >= 0) {
        this.lines.push(this.buffer.slice(0, idx));
        this.buffer = this.buffer.slice(idx + 2);
      }
      this.wake();
    });
    socket.on("timeout", () => {
      const error = new Error(`SMTP server did not answer within ${SMTP_TIMEOUT_MS}ms`);
      error.name = "TimeoutError";
      this.fail(error);
      socket.destroy();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      if (!this.failure) {
        this.fail(new Error("SMTP server closed the connection unexpectedly"));
      }
    });
  }

  /** Hands the session a freshly upgraded TLS socket after STARTTLS. */
  upgrade(socket: TLSSocket) {
    this.socket.removeAllListeners();
    this.socket = socket;
    this.bind(socket);
  }

  destroy() {
    this.socket.destroy();
  }

  private wake() {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  private fail(error: Error) {
    if (!this.failure) this.failure = error;
    this.wake();
  }

  private nextLine(): Promise<string> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      this.waiter = () => {
        if (this.lines.length > 0) resolve(this.lines.shift()!);
        else reject(this.failure ?? new Error("SMTP connection ended"));
      };
    });
  }

  /** Reads one (possibly multiline) reply: lines "250-..." until "250 ...". */
  private async readReply(): Promise<SmtpReply> {
    const collected: string[] = [];
    let code = -1;
    for (;;) {
      const line = await this.nextLine();
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) {
        throw new Error(`SMTP server sent a malformed reply line: ${line.slice(0, 120)}`);
      }
      const lineCode = Number(match[1]);
      if (code === -1) code = lineCode;
      collected.push(match[3]);
      if (match[2] === " ") {
        return { code, text: collected.join(" | ").slice(0, SMTP_MAX_REPLY_TEXT) };
      }
    }
  }

  async command(stage: string, line: string, expect: number[]): Promise<SmtpReply> {
    this.socket.write(`${line}\r\n`);
    return this.expect(stage, expect);
  }

  async expect(stage: string, expect: number[]): Promise<SmtpReply> {
    const reply = await this.readReply();
    if (!expect.includes(reply.code)) {
      throw new SmtpReplyError(stage, reply.code, reply.text);
    }
    return reply;
  }

  /** Writes the DATA block and waits for the final acceptance reply. */
  async sendData(dataBlock: string): Promise<void> {
    this.socket.write(dataBlock);
    await this.expect("message", [250]);
  }
}

/** Resolves once the socket signals the given connection event, or rejects. */
function openSocket<T extends Socket>(create: () => T, readyEvent: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = create();
    socket.setTimeout(SMTP_TIMEOUT_MS);
    const onReady = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      const error = new Error(`SMTP connection to the server timed out after ${SMTP_TIMEOUT_MS}ms`);
      error.name = "TimeoutError";
      reject(error);
    };
    const cleanup = () => {
      socket.off(readyEvent, onReady);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    socket.once(readyEvent, onReady);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

/**
 * Connects and negotiates encryption: implicit TLS when config.secure,
 * otherwise EHLO → mandatory STARTTLS → re-EHLO (RFC 3207) on the upgraded
 * socket. The returned session is encrypted and ready for AUTH.
 */
async function connectSmtp(config: SmtpSendConfig): Promise<SmtpSession> {
  const tlsOptions: ConnectionOptions = {
    servername: config.host,
    rejectUnauthorized: true,
    ...(config.caPem ? { ca: config.caPem } : {}),
  };

  if (config.secure) {
    const socket = await openSocket(
      () => connectTls({ ...tlsOptions, host: config.host, port: config.port }),
      "secureConnect",
    );
    const session = new SmtpSession(socket);
    await session.expect("greeting", [220]);
    await session.command("ehlo", "EHLO cas-alert", [250]);
    return session;
  }

  const socket = await openSocket(
    () => new Socket().connect({ host: config.host, port: config.port }),
    "connect",
  );
  const session = new SmtpSession(socket);
  await session.expect("greeting", [220]);
  const ehlo = await session.command("ehlo", "EHLO cas-alert", [250]);
  if (!/\bSTARTTLS\b/i.test(ehlo.text)) {
    session.destroy();
    throw new CasProviderError(
      "not-configured",
      `SMTP server ${config.host}:${config.port} does not advertise STARTTLS; TLS is required because alert content and mailbox credentials cross this connection. Use a TLS-capable submission port (465 or 587).`,
      { retryable: false },
    );
  }
  await session.command("starttls", "STARTTLS", [220]);
  // The session's listeners must come off the plaintext socket BEFORE the
  // TLS layer attaches to it, or the session would parse raw TLS records.
  socket.removeAllListeners();
  const upgraded = await openSocket(
    () => connectTls({ ...tlsOptions, socket }),
    "secureConnect",
  );
  session.upgrade(upgraded);
  await session.command("ehlo", "EHLO cas-alert", [250]);
  return session;
}

const CRLF = "\r\n";

/**
 * Sends one alert email to one recipient over its own short-lived
 * connection, and maps every failure onto the CasProviderError taxonomy the
 * outbox worker retries/journals on.
 */
export async function sendSmtpMessage(config: SmtpSendConfig, message: SmtpMessage): Promise<void> {
  try {
    const to = assertNoHeaderInjection("recipient", message.to);
    const from = assertNoHeaderInjection("sender", config.from);
    const subject = assertNoHeaderInjection("subject", message.subject);
    if (!config.user || !config.password) {
      throw new CasProviderError(
        "not-configured",
        "SMTP host is configured but CAS_EMAIL_SMTP_USER / CAS_EMAIL_SMTP_PASSWORD are missing; mailbox submission refuses to connect without credentials.",
        { retryable: false },
      );
    }
    const fromDomain = from.split("@")[1] ?? "cas-alert.local";
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${message.messageId}@${fromDomain}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ];
    // Base64 body: alert text with any characters survives 7-bit relays
    // without encoding surprises, and base64 never emits a leading dot.
    // Dot-stuff defensively anyway so message content can never fake the
    // DATA terminator.
    const bodyBase64 = Buffer.from(message.bodyText, "utf8")
      .toString("base64")
      .replace(/.{1,76}/g, (line) => `${line}${CRLF}`);
    const dataBlock = `${headers.join(CRLF)}${CRLF}${CRLF}${bodyBase64}`
      .split(CRLF)
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join(CRLF)
      .concat(`${CRLF}.${CRLF}`);

    const session = await connectSmtp(config);
    try {
      const credential = Buffer.from(`\0${config.user}\0${config.password}`, "utf8").toString("base64");
      await session.command("auth", `AUTH PLAIN ${credential}`, [235]);
      await session.command("mail", `MAIL FROM:<${from}>`, [250]);
      await session.command("rcpt", `RCPT TO:<${to}>`, [250, 251]);
      await session.command("data", "DATA", [354]);
      await session.sendData(dataBlock);
      // Best-effort polite close; a server that already hung up must not
      // turn a delivered message into a failure.
      await session.command("quit", "QUIT", [221]).catch(() => {});
    } finally {
      session.destroy();
    }
  } catch (error) {
    throw classifySmtpError(error, [message.to, config.from, config.user]);
  }
}

/**
 * Connect-and-authenticate probe for the console's "Test connection" action:
 * proves TLS negotiation and mailbox credentials without sending anything.
 * Failures carry the same classified, address-redacted CasProviderError as a
 * real send.
 */
export async function probeSmtpAccount(
  config: Omit<SmtpSendConfig, "from"> & { from?: string },
): Promise<void> {
  try {
    if (!config.user || !config.password) {
      throw new CasProviderError(
        "not-configured",
        "SMTP host is set but the username or app password is missing; the probe refuses to connect without credentials.",
        { retryable: false },
      );
    }
    const session = await connectSmtp({ ...config, from: config.from ?? config.user });
    try {
      // AUTH PLAIN payload: base64(NUL + user + NUL + password); the NUL
      // separator is built without a literal escape to keep this source file
      // plain text.
      const credential = Buffer.from(
        ["", config.user, config.password].join(String.fromCharCode(0)),
        "utf8",
      ).toString("base64");
      await session.command("auth", `AUTH PLAIN ${credential}`, [235]);
      await session.command("quit", "QUIT", [221]).catch(() => {});
    } finally {
      session.destroy();
    }
  } catch (error) {
    throw classifySmtpError(error, [config.user, config.from]);
  }
}

function assertNoHeaderInjection(field: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new CasProviderError(
      "rejected",
      `SMTP ${field} contains a line break and was refused; header injection is never sent.`,
      { retryable: false },
    );
  }
  return value.trim();
}

const MASKED_ADDRESS = maskRecipient("address@redacted.invalid");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remote servers echo addresses back in rejection text ("550 5.1.1
 * <someone@example.org> no such user"). Error messages are persisted in the
 * outbox status and the append-only incident journal, where recipients may
 * only ever appear masked — so strip every echoed address before remote
 * text leaves this module. The length trim happens here (never in
 * readReply) so protocol decisions like STARTTLS detection always see the
 * complete capability list.
 */
function redactEchoedAddresses(text: string, addresses: Array<string | undefined>): string {
  let out = text;
  for (const address of addresses) {
    if (!address) continue;
    out = out.replace(new RegExp(escapeRegExp(address), "gi"), maskRecipient(address));
  }
  // Sweep for any other address-shaped token the remote invented.
  return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, MASKED_ADDRESS).slice(0, 500);
}

/**
 * Maps SMTP replies and socket failures onto the shared taxonomy. SMTP
 * semantics: 4xx codes are transient (the worker retries), 5xx are
 * permanent — except during AUTH, where a 5xx means the credentials
 * themselves were refused (a fresh app password fixes it, not a retry).
 */
function classifySmtpError(error: unknown, redactAddresses: Array<string | undefined> = []): CasProviderError {
  if (error instanceof CasProviderError) return error;
  if (error instanceof SmtpReplyError) {
    const { code, stage } = error;
    const message = redactEchoedAddresses(error.message, redactAddresses);
    if (stage === "auth") {
      if (code >= 400 && code < 500) {
        return new CasProviderError("server-outage", message, { retryable: true, cause: error });
      }
      return new CasProviderError(
        "authentication",
        `${message} — the mailbox refused these credentials; check CAS_EMAIL_SMTP_USER and generate a fresh app password for CAS_EMAIL_SMTP_PASSWORD`,
        { retryable: false, cause: error },
      );
    }
    if (stage === "greeting" || stage === "ehlo" || stage === "starttls") {
      if (code >= 400 && code < 500) {
        return new CasProviderError("server-outage", message, { retryable: true, cause: error });
      }
      return new CasProviderError("rejected", message, { retryable: false, cause: error });
    }
    // mail / rcpt / data / message stages
    if (code === 452) {
      return new CasProviderError("rate-limited", message, { retryable: true, cause: error });
    }
    if (code >= 400 && code < 500) {
      return new CasProviderError("server-outage", message, { retryable: true, cause: error });
    }
    return new CasProviderError("rejected", message, { retryable: false, cause: error });
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") {
    return new CasProviderError(
      "socket-timeout",
      redactEchoedAddresses(
        error instanceof Error ? error.message : "SMTP operation timed out",
        redactAddresses,
      ),
      { retryable: true, cause: error },
    );
  }
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  if (/^(ERR_TLS|UNABLE_TO_|DEPTH_ZERO|CERT_|SELF_SIGNED)/.test(code)) {
    return new CasProviderError(
      "rejected",
      `SMTP TLS certificate verification failed for the configured host (${code}); the connection was dropped before credentials or alert content were sent. Check CAS_EMAIL_SMTP_HOST/PORT, or point CAS_EMAIL_SMTP_CA_FILE at the CA your relay uses.`,
      { retryable: false, cause: error },
    );
  }
  const detail = redactEchoedAddresses(
    error instanceof Error ? error.message : String(error),
    redactAddresses,
  );
  return new CasProviderError("network", `SMTP server could not be reached: ${detail}`, {
    retryable: true,
    cause: error,
  });
}

/** Reads the optional extra CA bundle for self-hosted relays behind an internal CA. */
export function readSmtpCaPem(caFile: string | undefined): string | undefined {
  if (!caFile) return undefined;
  return readFileSync(caFile, "utf8");
}
