import { detectSecretInNote } from "./note-secrets";

/**
 * Console-editable alert message templates.
 *
 * Every alert channel has a template: a fixed text with a small set of safe
 * placeholders that are substituted at send time. Templates live in the
 * cas_message_templates table; a channel without a row renders the built-in
 * DEFAULT_TEMPLATE_BODY, which is byte-for-byte the wording the system sent
 * before templates existed.
 *
 * Guardrails (enforced on save, surfaced in the console):
 * - Only the documented placeholders are accepted — a typo'd placeholder
 *   would otherwise reach responders literally.
 * - Credential-shaped content is rejected outright (same pattern list as the
 *   re-queue note gate): a template is stored long-term and sent to every
 *   responder, so a pasted secret would leak at scale.
 * - SMS length is never silently broken: the preview computes the rendered
 *   length and segment count, and templates that cannot fit a sane multi-part
 *   message are refused.
 */

export const CAS_TEMPLATE_CHANNELS = ["SMS", "XMPP", "EMAIL", "WHATSAPP"] as const;
export type CasTemplateChannel = (typeof CAS_TEMPLATE_CHANNELS)[number];

export function isCasTemplateChannel(value: string): value is CasTemplateChannel {
  return (CAS_TEMPLATE_CHANNELS as readonly string[]).includes(value);
}

/** The only substitutions a template may use. */
export const TEMPLATE_PLACEHOLDERS = [
  { token: "incident_id", description: "The incident reference, e.g. sim-1717…" },
  { token: "priority", description: "Alert priority (P1)" },
  { token: "time", description: "Alert time, UTC (YYYY-MM-DD HH:MMZ)" },
  { token: "location", description: "Maps link with accuracy and fix age, or a no-fix note" },
] as const;

export const DEFAULT_TEMPLATE_BODY =
  "CAS {{priority}} alert {{incident_id}} at {{time}}. " +
  "Begin response protocol. Do not call handset. {{location}}";

// GSM-7 limits: one segment carries 160 chars; concatenated segments carry
// 153 each (7 bytes of header per segment). The renderer assumes the GSM-7
// alphabet — templates are operator-written alert text, and the length flag
// is deliberately conservative rather than character-set aware.
export const SMS_SINGLE_SEGMENT_CHARS = 160;
export const SMS_CONCAT_SEGMENT_CHARS = 153;
// Hard ceiling: ~10 concatenated SMS segments. Beyond this an alert stops
// being an alert, so the save is refused rather than flagged.
export const MAX_TEMPLATE_CHARS = 1600;

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const KNOWN_PLACEHOLDERS: ReadonlySet<string> = new Set(TEMPLATE_PLACEHOLDERS.map((p) => p.token));

/** Placeholder tokens used in the body that the renderer does not know. */
export function findUnknownPlaceholders(body: string): string[] {
  const unknown = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    if (!KNOWN_PLACEHOLDERS.has(match[1])) unknown.add(match[1]);
  }
  return [...unknown];
}

/**
 * Substitutes known placeholders; unknown tokens pass through literally.
 * Save-time validation rejects unknown tokens, so a stored template never
 * contains them — the pass-through only matters for unsaved previews.
 */
export function renderTemplate(body: string, values: Record<string, string>): string {
  return body.replace(PLACEHOLDER_PATTERN, (match, name: string) =>
    KNOWN_PLACEHOLDERS.has(name) ? (values[name] ?? "") : match,
  );
}

export type TemplateValidation =
  | { ok: true }
  | { ok: false; error: string };

export function validateTemplateBody(body: string): TemplateValidation {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Template body must not be empty." };
  }
  if (trimmed.length > MAX_TEMPLATE_CHARS) {
    return {
      ok: false,
      error: `Template is ${trimmed.length} characters; the limit is ${MAX_TEMPLATE_CHARS} (about 10 SMS segments). Shorten the wording — an alert must stay readable.`,
    };
  }
  const unknown = findUnknownPlaceholders(trimmed);
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown placeholder(s): ${unknown.map((name) => `{{${name}}}`).join(", ")}. Available: ${TEMPLATE_PLACEHOLDERS.map((p) => `{{${p.token}}}`).join(", ")}.`,
    };
  }
  const leaked = detectSecretInNote(trimmed);
  if (leaked) {
    return {
      ok: false,
      error: `Template appears to contain ${leaked}. Never put credentials in alert text — it is stored long-term and sent to every responder. Keep secrets in the server environment.`,
    };
  }
  return { ok: true };
}

/** Number of SMS segments a rendered body of the given length occupies. */
export function smsSegmentCount(renderedLength: number): number {
  if (renderedLength <= SMS_SINGLE_SEGMENT_CHARS) return 1;
  return Math.ceil(renderedLength / SMS_CONCAT_SEGMENT_CHARS);
}

/**
 * Non-fatal warnings for a rendered template (shown in the console next to
 * the preview). The SMS flag is the important one: a multi-segment alert
 * costs more, can arrive reordered, and some handsets truncate it.
 */
export function templateWarnings(channel: CasTemplateChannel, rendered: string): string[] {
  const warnings: string[] = [];
  if (channel === "SMS") {
    const segments = smsSegmentCount(rendered.length);
    if (segments > 1) {
      warnings.push(
        `Renders to ${rendered.length} characters — about ${segments} SMS segments. Multi-part texts cost more per responder and can arrive out of order; consider shortening below ${SMS_SINGLE_SEGMENT_CHARS} characters.`,
      );
    }
  }
  return warnings;
}
