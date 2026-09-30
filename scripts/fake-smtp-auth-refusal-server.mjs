// Standalone fake SMTP submission server for the email-probe browser proof
// (spawned by scripts/run-console-browser-proof.mjs). It greets, advertises
// STARTTLS (the api-server's SMTP client refuses to AUTH on cleartext),
// upgrades with a throwaway cert, then answers every AUTH with a 535 — a
// mailbox whose app password was revoked. It implements no MAIL/RCPT/DATA,
// so nothing can ever be sent through it even if a proof mis-fires.
//
// It runs as its own process because the harness drives the proof with
// synchronous spawns, which would freeze an in-process server's event loop
// for the whole Playwright run.
//
// Usage: node scripts/fake-smtp-auth-refusal-server.mjs <key.pem> <cert.pem>
// Prints "FAKE_SMTP_PORT=<port>" on stdout once listening.

import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { TLSSocket, createSecureContext } from "node:tls";

const [keyFile, certFile] = process.argv.slice(2);
if (!keyFile || !certFile) {
  console.error("usage: node fake-smtp-auth-refusal-server.mjs <key.pem> <cert.pem>");
  process.exit(2);
}

const secureContext = createSecureContext({
  key: readFileSync(keyFile, "utf8"),
  cert: readFileSync(certFile, "utf8"),
});

const server = createServer((plain) => {
  plain.setEncoding("utf8");
  let socket = plain;
  let secured = false;
  let buffer = "";

  const send = (line) => socket.write(`${line}\r\n`);
  const handleLine = (line) => {
    const verb = (line.split(" ")[0] ?? "").toUpperCase();
    if (verb === "EHLO" || verb === "HELO") {
      send("250-fake-smtp greets you");
      send(secured ? "250 AUTH PLAIN" : "250 STARTTLS");
    } else if (verb === "STARTTLS" && !secured) {
      send("220 Ready to start TLS");
      // The probe strips its own listeners before upgrading; mirror that
      // here so the TLS layer, not this handler, parses the handshake.
      plain.removeAllListeners("data");
      const tlsSocket = new TLSSocket(plain, { isServer: true, secureContext });
      tlsSocket.once("secure", () => {
        secured = true;
        socket = tlsSocket;
        buffer = "";
        tlsSocket.setEncoding("utf8");
        tlsSocket.on("data", onData);
      });
      tlsSocket.on("error", () => {});
    } else if (verb === "AUTH") {
      send("535 5.7.8 authentication failed: the app password was refused");
    } else if (verb === "QUIT") {
      send("221 Bye");
      socket.end();
    } else if (verb === "NOOP" || verb === "RSET") {
      send("250 OK");
    } else {
      send("502 Command not implemented");
    }
  };
  const onData = (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleLine(line);
    }
  };

  plain.on("data", onData);
  plain.on("error", () => {});
  send("220 fake-smtp ESMTP ready");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    console.error("Fake SMTP server did not bind a port");
    process.exit(1);
  }
  console.log(`FAKE_SMTP_PORT=${address.port}`);
});
