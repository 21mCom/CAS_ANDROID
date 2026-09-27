import app from "./app";
import { startCasOutboxWorker } from "./lib/cas-outbox-worker";
import { deviceAccessToken, deviceChannels, smsDeliveryMode } from "./lib/cas-device-delivery";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Drain the CAS outbox on a bounded interval so queued P1 alerts actually
// reach the configured SMS/XMPP/email providers. The loop survives adapter
// errors and is stopped cleanly during shutdown below. Validating the SMS
// delivery mode and device channels here makes a typo'd
// CAS_SMS_DELIVERY_MODE / CAS_DEVICE_CHANNELS fail at boot instead of
// silently picking a delivery behavior.
logger.info(
  {
    smsDeliveryMode: smsDeliveryMode(),
    deviceChannels: deviceChannels(),
    deviceAuthConfigured: deviceAccessToken() !== undefined,
  },
  "CAS SMS delivery mode",
);
if (deviceChannels().length > 0 && deviceAccessToken() === undefined) {
  logger.warn(
    "CAS_DEVICE_TOKEN is not set: the handset pickup/receipt endpoints stay closed (503) until it is configured.",
  );
}
// The alert credential fails closed in the middleware too, but say so at
// boot: an operator who never set CAS_ALERT_TOKEN otherwise discovers it as
// the phone's first trigger returning 401 during a real alert.
if (process.env.CAS_ALERT_TOKEN === undefined) {
  logger.warn(
    "CAS_ALERT_TOKEN is not set: the trigger and incident mutation endpoints reject every request (401) until it is configured.",
  );
}
const outboxWorker = startCasOutboxWorker();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  await outboxWorker.stop();
  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error closing server");
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
