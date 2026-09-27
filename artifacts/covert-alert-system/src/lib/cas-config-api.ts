import { casAuthedFetch } from '@/hooks/use-field-test';
import {
  parseCasRespondersResponse,
  parseCasTemplateInfo,
  parseCasTemplatePreviewResult,
  parseCasTemplatesResponse,
} from '@/lib/cas-config-schema';

/**
 * Client for the console-managed delivery configuration (responders and
 * alert message templates). Every call is credential-gated server-side, so
 * these go through casAuthedFetch — the first action in a session asks for
 * the alert credential, exactly like the incident actions.
 */

export type ResponderChannels = {
  sms: string | null;
  whatsapp: string | null;
  email: string | null;
  xmpp: string | null;
};

export type Responder = {
  id: string;
  name: string;
  enabled: boolean;
  channels: ResponderChannels;
  /** True for rows copied from the CAS_*_RECIPIENTS environment seed. */
  seeded: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ResponderPayload = {
  name?: string;
  enabled?: boolean;
  smsNumber?: string | null;
  whatsappNumber?: string | null;
  emailAddress?: string | null;
  xmppAddress?: string | null;
};

export type TemplateInfo = {
  channel: 'SMS' | 'XMPP' | 'EMAIL' | 'WHATSAPP';
  body: string;
  source: 'default' | 'custom';
  placeholders: string[];
  preview: string;
  warnings: string[];
};

export type TemplatePreviewResult =
  | { ok: true; preview: string; warnings: string[] }
  | { ok: false; error: string };

async function expectOk(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  const body = (await response.json().catch(() => ({}))) as { error?: string; issues?: { message?: string }[] };
  const issue = body.issues?.find((entry) => entry.message)?.message;
  throw new Error(body.error ?? issue ?? `${fallback} (${response.status}).`);
}

export async function fetchResponders(): Promise<{ seeded: boolean; responders: Responder[] }> {
  const response = await casAuthedFetch('/api/cas/config/responders');
  await expectOk(response, 'Unable to load responders');
  // Validated against the console's mirror of the server contract: a
  // drifted server throws CasStateShapeError instead of letting the page
  // render wrong responder/channel configuration.
  return parseCasRespondersResponse(await response.json());
}

export async function createResponder(payload: ResponderPayload): Promise<void> {
  const response = await casAuthedFetch('/api/cas/config/responders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await expectOk(response, 'Unable to add the responder');
}

export async function updateResponder(id: string, payload: ResponderPayload): Promise<void> {
  const response = await casAuthedFetch(`/api/cas/config/responders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await expectOk(response, 'Unable to update the responder');
}

export async function fetchTemplates(): Promise<TemplateInfo[]> {
  const response = await casAuthedFetch('/api/cas/config/templates');
  await expectOk(response, 'Unable to load message templates');
  // Same drift guard as the responders read: a mismatched server build
  // throws instead of rendering wrong template configuration.
  return parseCasTemplatesResponse(await response.json()).templates;
}

export async function saveTemplate(channel: string, body: string): Promise<TemplateInfo> {
  const response = await casAuthedFetch(`/api/cas/config/templates/${channel}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  await expectOk(response, 'Unable to save the template');
  return parseCasTemplateInfo(await response.json());
}

export async function resetTemplate(channel: string): Promise<TemplateInfo> {
  const response = await casAuthedFetch(`/api/cas/config/templates/${channel}`, { method: 'DELETE' });
  await expectOk(response, 'Unable to reset the template');
  return parseCasTemplateInfo(await response.json());
}

export async function previewTemplate(channel: string, body: string): Promise<TemplatePreviewResult> {
  const response = await casAuthedFetch('/api/cas/config/templates/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, body }),
  });
  await expectOk(response, 'Unable to render the preview');
  return parseCasTemplatePreviewResult(await response.json());
}
