import { z } from 'zod';
import { casResponseShapeError } from '@/lib/cas-state-schema';
import type { Responder, TemplateInfo, TemplatePreviewResult } from '@/lib/cas-config-api';

/**
 * Console-side mirror of the API's delivery-configuration response
 * contracts (artifacts/api-server/src/routes/cas-config.ts —
 * shapeResponder/shapeTemplate and the preview endpoint). cas-config-api
 * used to blind-cast every body, so a drifted server (stale deployment,
 * mixed environments) silently rendered wrong responder/channel or
 * template configuration. Each client function now parses through these
 * schemas; a drift throws CasStateShapeError, which the pages surface as a
 * visible per-panel load/action error instead of rendering garbage.
 *
 * The compile-time assertions at the bottom pin the inferred payload types
 * to the client's Responder/TemplateInfo/TemplatePreviewResult
 * declarations in both directions, so editing one side without the other
 * is a typecheck failure.
 */

const responderSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  channels: z.object({
    sms: z.string().nullable(),
    whatsapp: z.string().nullable(),
    email: z.string().nullable(),
    xmpp: z.string().nullable(),
  }).strict(),
  seeded: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const templateInfoSchema = z.object({
  channel: z.enum(['SMS', 'XMPP', 'EMAIL', 'WHATSAPP']),
  body: z.string(),
  source: z.enum(['default', 'custom']),
  placeholders: z.array(z.string()),
  preview: z.string(),
  warnings: z.array(z.string()),
}).strict();

const templatePreviewResultSchema = z.union([
  z.object({ ok: z.literal(true), preview: z.string(), warnings: z.array(z.string()) }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);

export function parseCasRespondersResponse(body: unknown): { seeded: boolean; responders: Responder[] } {
  const result = z.object({ seeded: z.boolean(), responders: z.array(responderSchema) }).strict().safeParse(body);
  if (!result.success) throw casResponseShapeError('responders', result.error);
  return result.data;
}

export function parseCasTemplatesResponse(body: unknown): { templates: TemplateInfo[] } {
  const result = z.object({ templates: z.array(templateInfoSchema) }).strict().safeParse(body);
  if (!result.success) throw casResponseShapeError('templates', result.error);
  return result.data;
}

/** Validates the single-template body returned by save/reset. */
export function parseCasTemplateInfo(body: unknown): TemplateInfo {
  const result = templateInfoSchema.safeParse(body);
  if (!result.success) throw casResponseShapeError('template', result.error);
  return result.data;
}

export function parseCasTemplatePreviewResult(body: unknown): TemplatePreviewResult {
  const result = templatePreviewResultSchema.safeParse(body);
  if (!result.success) throw casResponseShapeError('template preview', result.error);
  return result.data;
}

// Compile-time lockstep with the client's configuration types: assigning
// in both directions fails typecheck the moment a mirror schema and the
// corresponding cas-config-api declaration disagree.
const _responderMatchesClient: Responder = null as unknown as z.infer<typeof responderSchema>;
const _schemaMatchesResponder: z.infer<typeof responderSchema> = null as unknown as Responder;
const _templateMatchesClient: TemplateInfo = null as unknown as z.infer<typeof templateInfoSchema>;
const _schemaMatchesTemplate: z.infer<typeof templateInfoSchema> = null as unknown as TemplateInfo;
const _previewMatchesClient: TemplatePreviewResult = null as unknown as z.infer<typeof templatePreviewResultSchema>;
const _schemaMatchesPreview: z.infer<typeof templatePreviewResultSchema> = null as unknown as TemplatePreviewResult;
void _responderMatchesClient;
void _schemaMatchesResponder;
void _templateMatchesClient;
void _schemaMatchesTemplate;
void _previewMatchesClient;
void _schemaMatchesPreview;
