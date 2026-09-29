import { casAuthedFetch } from '@/hooks/use-field-test';
import {
  parseCasEmailAccountInfo,
  parseCasEmailAccountsResponse,
  parseCasEmailAccountTestResult,
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

// ---- Email delivery accounts (SMTP) -----------------------------------------
// The console-managed mailbox settings for the email channel. Passwords are
// write-only: the server never returns one, so the form stays blank after
// save and "Test connection" can fall back to the stored password.

export type EmailAccountSlot = 'primary' | 'fallback';

export type EmailAccountInfo = {
  slot: EmailAccountSlot;
  host: string;
  port: number;
  user: string;
  fromAddress: string | null;
  updatedAt: string;
};

export type EmailAccountsResponse = {
  /** Which configuration owns the channel: console rows, server env, or nothing. */
  source: 'console' | 'environment' | 'none';
  environment: { smtpConfigured: boolean; providerConfigured: boolean };
  accounts: EmailAccountInfo[];
};

export type EmailAccountPayload = {
  host: string;
  port?: number;
  user: string;
  /** Omit on update to keep the stored password. */
  password?: string;
  fromAddress?: string | null;
};

export type EmailAccountTestResult =
  | { ok: true }
  | { ok: false; classification: string; message: string };

export async function fetchEmailAccounts(): Promise<EmailAccountsResponse> {
  const response = await casAuthedFetch('/api/cas/config/email-accounts');
  await expectOk(response, 'Unable to load email delivery settings');
  return parseCasEmailAccountsResponse(await response.json());
}

export async function saveEmailAccount(slot: EmailAccountSlot, payload: EmailAccountPayload): Promise<EmailAccountInfo> {
  const response = await casAuthedFetch(`/api/cas/config/email-accounts/${slot}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await expectOk(response, 'Unable to save the email account');
  return parseCasEmailAccountInfo(await response.json());
}

export async function deleteEmailAccount(slot: EmailAccountSlot): Promise<void> {
  const response = await casAuthedFetch(`/api/cas/config/email-accounts/${slot}`, { method: 'DELETE' });
  await expectOk(response, 'Unable to remove the email account');
}

export async function testEmailAccount(slot: EmailAccountSlot, payload: Partial<EmailAccountPayload> = {}): Promise<EmailAccountTestResult> {
  const response = await casAuthedFetch(`/api/cas/config/email-accounts/${slot}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await expectOk(response, 'Unable to test the connection');
  return parseCasEmailAccountTestResult(await response.json());
}
