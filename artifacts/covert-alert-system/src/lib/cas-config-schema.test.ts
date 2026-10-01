import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CasStateShapeError } from '@/lib/cas-state-schema';
import {
  parseCasRespondersResponse,
  parseCasTemplateInfo,
  parseCasTemplatePreviewResult,
  parseCasTemplatesResponse,
} from '@/lib/cas-config-schema';
import { fetchResponders, fetchTemplates } from '@/lib/cas-config-api';

/**
 * Runtime contracts for the console-managed delivery configuration reads
 * (GET /api/cas/config/responders, GET /api/cas/config/templates): the
 * client must reject a drifted server response loudly (CasStateShapeError →
 * the page's visible load-error panel) instead of blind-casting it and
 * rendering wrong responder or template configuration.
 */

function validResponder() {
  return {
    id: 'rsp-1',
    name: 'Alex',
    enabled: true,
    channels: { sms: '+15551234567', whatsapp: null, email: 'alex@example.org', xmpp: null },
    seeded: false,
    createdAt: '2026-09-27T14:00:00.000Z',
    updatedAt: '2026-09-27T14:00:00.000Z',
  };
}

function validTemplate() {
  return {
    channel: 'SMS',
    body: 'CAS {{priority}} alert {{incident_id}} at {{time}} — {{location}}',
    source: 'default',
    placeholders: ['incident_id', 'priority', 'time', 'location'],
    preview: 'CAS P1 alert inc-1 at 14:08 — 52.1,4.3',
    warnings: [] as string[],
  };
}

test('responses matching the contracts parse through unchanged', () => {
  const responders = { seeded: true, responders: [validResponder()] };
  assert.deepEqual(parseCasRespondersResponse(responders), responders);

  const templates = { templates: [validTemplate()] };
  assert.deepEqual(parseCasTemplatesResponse(templates), templates);

  assert.deepEqual(parseCasTemplateInfo(validTemplate()), validTemplate());
  assert.deepEqual(parseCasTemplatePreviewResult({ ok: true, preview: 'p', warnings: [] }), { ok: true, preview: 'p', warnings: [] });
  assert.deepEqual(parseCasTemplatePreviewResult({ ok: false, error: 'bad placeholder' }), { ok: false, error: 'bad placeholder' });
});

test('a responder missing its channels is rejected with the offending path named', () => {
  const body = { seeded: false, responders: [{ ...validResponder(), channels: undefined }] };
  assert.throws(
    () => parseCasRespondersResponse(body),
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /Server's responders response does not match/i);
      assert.match(error.message, /responders\.0\.channels/);
      return true;
    },
  );
});

test('a template from an unknown channel is rejected, not rendered as garbage', () => {
  const body = { templates: [{ ...validTemplate(), channel: 'PAGER' }] };
  assert.throws(
    () => parseCasTemplatesResponse(body),
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /templates\.0\.channel/);
      return true;
    },
  );
});

test('added-but-unmirrored fields are rejected (strict objects), so an older console never silently drops newer data', () => {
  const responder = { ...validResponder(), nickname: 'al' };
  assert.throws(() => parseCasRespondersResponse({ seeded: false, responders: [responder] }), CasStateShapeError);
  assert.throws(() => parseCasTemplateInfo({ ...validTemplate(), characterLimit: 160 }), CasStateShapeError);
  assert.throws(() => parseCasTemplatePreviewResult({ ok: false, error: 'x', hint: 'y' }), CasStateShapeError);
});

test('non-object bodies are rejected instead of blowing up on property access', () => {
  for (const body of [null, 42, 'garbage', []]) {
    assert.throws(() => parseCasRespondersResponse(body), CasStateShapeError);
    assert.throws(() => parseCasTemplatesResponse(body), CasStateShapeError);
    assert.throws(() => parseCasTemplateInfo(body), CasStateShapeError);
    assert.throws(() => parseCasTemplatePreviewResult(body), CasStateShapeError);
  }
});

/**
 * Runs a client call against a browser shim where the session already holds
 * an enrolled device credential and the server answers with the given body,
 * proving the full client path (fetch → parse) takes the drift error branch.
 */
async function withStubbedServer(body: unknown, run: () => Promise<unknown>): Promise<unknown> {
  const store = new Map<string, string>([['cas-device-token', 'test-device-token']]);
  const localStore = new Map<string, string>();
  const globals = globalThis as Record<string, unknown>;
  const original = { window: globals.window, sessionStorage: globals.sessionStorage, localStorage: globals.localStorage, fetch: globals.fetch };
  globals.window = { prompt: () => null, alert: () => {} };
  globals.sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  globals.localStorage = {
    getItem: (key: string) => localStore.get(key) ?? null,
    setItem: (key: string, value: string) => { localStore.set(key, value); },
    removeItem: (key: string) => { localStore.delete(key); },
  };
  globals.fetch = async () => ({ ok: true, status: 200, json: async () => body });
  try {
    return await run();
  } finally {
    globals.window = original.window;
    globals.sessionStorage = original.sessionStorage;
    globals.localStorage = original.localStorage;
    globals.fetch = original.fetch;
  }
}

test('fetchResponders rejects a drifted responders payload instead of returning it', async () => {
  const drifted = { seeded: false, responders: [{ ...validResponder(), enabled: 'yes' }] };
  await assert.rejects(
    () => withStubbedServer(drifted, () => fetchResponders()) as Promise<unknown>,
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /responders\.0\.enabled/);
      return true;
    },
  );
});

test('fetchTemplates rejects a drifted templates payload instead of returning it', async () => {
  const drifted = { templates: [{ ...validTemplate(), warnings: 'none' }] };
  await assert.rejects(
    () => withStubbedServer(drifted, () => fetchTemplates()) as Promise<unknown>,
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /templates\.0\.warnings/);
      return true;
    },
  );
});

test('fetchResponders returns validated data for a well-formed payload', async () => {
  const body = { seeded: true, responders: [validResponder()] };
  const result = await withStubbedServer(body, () => fetchResponders());
  assert.deepEqual(result, body);
});
