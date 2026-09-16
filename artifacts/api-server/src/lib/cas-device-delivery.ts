/**
 * Device-direct SMS delivery mode.
 *
 * The CAS outbox supports two ways for an SMS alert to leave the system:
 *
 * - "gateway" (default): the server-side outbox worker claims SMS items and
 *   submits them to the provider configured via CAS_SMS_PROVIDER_URL (see
 *   lib/delivery-providers.ts).
 * - "device": the alerting handset is the delivery agent. It sends the SMS
 *   itself over its own SIM and reports the outcome back through
 *   POST /api/cas/incidents/:id/sms-receipt. The worker must never claim SMS
 *   items in this mode — there is no server-side provider to deliver through,
 *   and claiming them would fail every delivery as "not-configured".
 *
 * Device mode exists because it needs no third-party gateway account and
 * still works when the handset has SMS-capable cellular signal but no data
 * connection (the receipt simply arrives late, or not at all — in which case
 * the item stays QUEUED and the console's stuck-pipeline warning stays
 * honest). Its tradeoffs vs. a gateway: no server-side delivery record until
 * the handset reports back, and the responder list lives on the handset.
 */
export type SmsDeliveryMode = "gateway" | "device";

export function smsDeliveryMode(
  env: NodeJS.ProcessEnv = process.env,
): SmsDeliveryMode {
  const raw = env.CAS_SMS_DELIVERY_MODE;
  if (raw === undefined || raw.trim() === "") return "gateway";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "gateway" || normalized === "device") return normalized;
  // Fail explicitly: an unknown mode must not silently pick either behavior,
  // because guessing wrong either strands alerts (device) or double-sends.
  throw new Error(
    `Invalid CAS_SMS_DELIVERY_MODE value: "${raw}" (expected "gateway" or "device")`,
  );
}

/**
 * Channels the alerting handset delivers itself in device mode, from
 * CAS_DEVICE_CHANNELS (comma-separated, default "SMS"). The worker must
 * never claim these transports: the handset sends them and reports back
 * through the device receipt endpoint, so a server-side claim could only
 * fail "not-configured" and would race the handset's receipt.
 *
 * WHATSAPP is tap-to-send on the handset (the free WhatsApp app has no
 * unattended-send API); the receipt then means "handed to WhatsApp", not
 * carrier-confirmed delivery.
 */
export type DeviceChannel = "SMS" | "WHATSAPP";

export function deviceChannels(
  env: NodeJS.ProcessEnv = process.env,
): DeviceChannel[] {
  if (smsDeliveryMode(env) !== "device") return [];
  const raw = env.CAS_DEVICE_CHANNELS;
  if (raw === undefined || raw.trim() === "") return ["SMS"];
  const channels = raw
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  for (const channel of channels) {
    if (channel !== "SMS" && channel !== "WHATSAPP") {
      // Fail explicitly, same rule as the mode itself: an unknown channel
      // must not silently drop alerts or strand outbox items.
      throw new Error(
        `Invalid CAS_DEVICE_CHANNELS entry: "${channel}" (supported: SMS, WHATSAPP)`,
      );
    }
  }
  return [...new Set(channels)] as DeviceChannel[];
}

/**
 * Shared secret the alerting handset presents (X-CAS-Device-Token header) to
 * enumerate pending deliveries and post receipts. Mandatory in device mode:
 * without it those endpoints stay closed (503) — they can mark an unsent
 * alert SENT, so they must never answer an arbitrary network client.
 */
export function deviceAccessToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.CAS_DEVICE_TOKEN;
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

/**
 * Masks a responder number for the incident journal and outbox lastError,
 * both of which are broadly visible to responders. Only the last two digits
 * survive — enough to tell two responders apart when debugging, not enough
 * to reconstruct a phone number from a leaked journal.
 */
export function maskRecipient(recipient: string): string {
  const digits = recipient.replace(/\D/g, "");
  return digits.length >= 2 ? `\u2022\u2022\u2022${digits.slice(-2)}` : "\u2022\u2022\u2022";
}
