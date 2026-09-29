/**
 * Shared stub SMTP server for the email-channel test suites: real TLS
 * sockets (implicit-TLS and STARTTLS modes) against a self-signed localhost
 * fixture, recording the command transcript and whether each command arrived
 * encrypted, so tests can prove credentials never cross in cleartext.
 */
import net from "node:net";
import tls, { TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY_PATH = fileURLToPath(new URL("../../test-fixtures/smtp-tls/localhost-key.pem", import.meta.url));
const CERT_PATH = fileURLToPath(new URL("../../test-fixtures/smtp-tls/localhost-cert.pem", import.meta.url));


/** The fixture certificate, for suites that trust it via the CA-file path. */
export const SMTP_STUB_CERT_PATH = CERT_PATH;

export type StubBehavior = {
  authCode?: number;
  rcptCodeFor?: (recipient: string) => number;
  offerStarttls?: boolean;
  longGreeting?: boolean;
};

export type StubSmtpServer = {
  port: number;
  connections: () => number;
  transcript: Array<{ line: string; tls: boolean }>;
  authLogins: Array<{ decoded: string; tls: boolean }>;
  messages: Array<{ raw: string; tls: boolean }>;
  close: () => Promise<void>;
};

/**
 * Minimal stub SMTP server exercising the real client over real TLS, in two
 * modes: implicit TLS (port-465 style) and plaintext-then-STARTTLS (587
 * style). Records the command transcript and whether each command arrived
 * encrypted, so tests can prove credentials never cross the wire in
 * cleartext.
 */
export async function startStubSmtp(
  mode: "implicit-tls" | "starttls",
  behavior: StubBehavior = {},
): Promise<StubSmtpServer> {
  const key = readFileSync(KEY_PATH);
  const cert = readFileSync(CERT_PATH);
  const transcript: StubSmtpServer["transcript"] = [];
  const authLogins: StubSmtpServer["authLogins"] = [];
  const messages: StubSmtpServer["messages"] = [];
  let connections = 0;

  const handle = (initialSocket: net.Socket | TLSSocket, initiallyEncrypted: boolean) => {
    connections++;
    let socket = initialSocket;
    let encrypted = initiallyEncrypted;
    let buffer = "";
    let inData = false;
    let dataLines: string[] = [];

    const reply = (line: string) => socket.write(`${line}\r\n`);
    const ehlo = () => {
      const caps = ["250-localhost"];
      // Pad the capability list so STARTTLS appears far past the 200-char
      // mark — a client that truncated replies would miss it and wrongly
      // refuse to send.
      if (behavior.longGreeting) {
        for (let i = 0; i < 12; i++) caps.push(`250-X-FILLER-${i}-${"A".repeat(48)}`);
      }
      if (!encrypted && behavior.offerStarttls !== false) caps.push("250-STARTTLS");
      caps.push("250-AUTH PLAIN");
      caps.push("250 8BITMIME");
      caps.forEach(reply);
    };
    const onLine = (line: string) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          messages.push({ raw: dataLines.join("\r\n"), tls: encrypted });
          reply("250 2.0.0 queued as stub");
        } else {
          dataLines.push(line);
        }
        return;
      }
      const command = line.split(" ")[0]?.toUpperCase() ?? "";
      const arg = line.slice(command.length).trim();
      // Credentials are captured separately and never echoed into the
      // transcript, mirroring the no-credentials-in-logs rule.
      transcript.push({ line: command === "AUTH" ? "AUTH PLAIN <captured>" : line, tls: encrypted });
      switch (command) {
        case "EHLO":
        case "HELO":
          ehlo();
          break;
        case "STARTTLS": {
          reply("220 2.0.0 ready to start TLS");
          socket.removeAllListeners("data");
          const upgraded = new TLSSocket(socket as net.Socket, { isServer: true, key, cert });
          upgraded.on("error", () => {});
          upgraded.on("secure", () => {
            socket = upgraded;
            encrypted = true;
            attach(upgraded);
          });
          break;
        }
        case "AUTH": {
          const encoded = arg.split(" ")[1] ?? "";
          authLogins.push({ decoded: Buffer.from(encoded, "base64").toString("utf8"), tls: encrypted });
          reply(
            behavior.authCode === 535
              ? "535 5.7.8 Username and Password not accepted"
              : "235 2.7.0 accepted",
          );
          break;
        }
        case "MAIL":
          reply("250 2.1.0 sender ok");
          break;
        case "RCPT": {
          const recipient = /<([^>]+)>/.exec(arg)?.[1] ?? arg;
          const code = behavior.rcptCodeFor?.(recipient) ?? 250;
          if (code === 250) reply("250 2.1.5 recipient ok");
          else if (code === 451) reply("451 4.3.0 greylisted, try later");
          // Real servers echo the rejected address back — the client must
          // redact it before the text can reach the journal.
          else reply(`550 5.1.1 <${recipient}> no such user`);
          break;
        }
        case "DATA":
          reply("354 end with <CRLF>.<CRLF>");
          inData = true;
          dataLines = [];
          break;
        case "RSET":
          reply("250 2.0.0 reset");
          break;
        case "QUIT":
          reply("221 2.0.0 bye");
          socket.end();
          break;
        default:
          reply("502 5.5.2 command not supported");
      }
    };
    const attach = (s: net.Socket | TLSSocket) => {
      s.setEncoding("utf8");
      s.on("error", () => {});
      s.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          onLine(line);
        }
      });
    };
    attach(socket);
    reply("220 localhost ESMTP stub ready");
  };

  let server: net.Server | tls.Server;
  if (mode === "implicit-tls") {
    const tlsServer = tls.createServer({ key, cert });
    tlsServer.on("secureConnection", (socket) => handle(socket, true));
    server = tlsServer;
  } else {
    const netServer = net.createServer();
    netServer.on("connection", (socket) => handle(socket, false));
    server = netServer;
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    connections: () => connections,
    transcript,
    authLogins,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

