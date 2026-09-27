import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CasStateShapeError, parseCasStateResponse } from '@/lib/cas-state-schema';
import { applyLoadFailure, casAuthedFetch, CasCredentialError } from '@/hooks/use-field-test';
import { StateResponseError } from '@/components/state-response-error';
import { ConsoleLocked } from '@/components/console-locked';
import { OfflineDemoBanner } from '@/components/offline-demo-banner';

/**
 * Runtime contract for GET /api/cas/state: the console must reject a
 * drifted server response loudly (CasStateShapeError → the full-screen
 * mismatch surface) instead of blind-casting it and rendering
 * partial/garbage data, or silently falling back to the demo seed.
 */

function validState() {
  return {
    gates: [{
      id: 'proxy-launch',
      index: '01',
      name: 'Proxy Launch',
      short: 'Cover app → alert surface',
      status: 'partial',
      criterion: 'criterion',
      evidence: ['note'],
      nextAction: 'next',
      owner: 'Operator',
    }],
    setup: [{
      id: 'sim',
      label: 'Test SIM present',
      detail: 'detail',
      group: 'Connectivity',
      complete: true,
      mode: 'owner',
    }],
    incidents: [{
      id: 'inc-1',
      priority: 'P1',
      time: '14:08:12',
      title: 'Alert surface reached',
      detail: 'detail',
      state: 'Observed',
      source: 'Local test path',
      sample: true,
    }],
    activeIncident: {
      id: 'inc-active',
      status: 'ACTIVE_UNACKED',
      priority: 'P1',
      triggerCount: 1,
      createdAt: '2026-09-27T14:08:12.000Z',
      location: { latitude: 52.1, longitude: 4.3, accuracyM: 18, capturedAt: '2026-09-27T14:08:10.000Z' },
      events: [{ id: 'ev-1', type: 'TRIGGER', priority: 'P1', time: '14:08:12', detail: 'detail' }],
      outbox: [{
        id: 'out-1',
        transport: 'SMS',
        state: 'QUEUED',
        priority: 'P1',
        attempts: 0,
        lastError: null,
        terminal: false,
      }],
      evidence: [{
        id: 'evi-1',
        kind: 'audio',
        contentType: 'audio/mp4',
        sizeBytes: 1024,
        sequence: 1,
        capturedAt: null,
        uploadedAt: '2026-09-27T14:09:00.000Z',
        requestId: null,
      }],
      captureRequests: [{
        id: 'cap-1',
        kind: 'photo',
        state: 'PENDING',
        detail: null,
        createdAt: '2026-09-27T14:09:00.000Z',
        updatedAt: '2026-09-27T14:09:00.000Z',
      }],
    },
  };
}

test('a response matching the contract parses through unchanged', () => {
  const state = validState();
  assert.deepEqual(parseCasStateResponse(state), state);
  assert.deepEqual(parseCasStateResponse({ ...validState(), activeIncident: null }).activeIncident, null);
});

test('a missing required field is rejected with the offending path named', () => {
  const state = validState() as Record<string, unknown>;
  delete state.incidents;
  assert.throws(
    () => parseCasStateResponse(state),
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /Server's state response does not match/i);
      assert.match(error.message, /incidents/);
      return true;
    },
  );
});

test('a renamed enum value inside an entry is rejected, not rendered as garbage', () => {
  const state = validState();
  (state.gates[0] as { status: string }).status = 'confirmed';
  assert.throws(
    () => parseCasStateResponse(state),
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /gates\.0\.status/);
      return true;
    },
  );
});

test('an added-but-unmirrored field is rejected (strict objects), so an older console never silently drops newer data', () => {
  const state = validState();
  (state.activeIncident as Record<string, unknown>).newServerField = 'surprise';
  assert.throws(() => parseCasStateResponse(state), CasStateShapeError);
});

test('a non-object body is rejected instead of blowing up on property access', () => {
  for (const body of [null, 42, 'garbage', []]) {
    assert.throws(() => parseCasStateResponse(body), CasStateShapeError);
  }
});

test('load failure routing: a shape error raises the mismatch surface, never the demo fallback', () => {
  let surfaced: string | null = null;
  let locked: string | null = null;
  let demo = false;
  applyLoadFailure(new CasStateShapeError('drifted'), (message) => { surfaced = message; }, (message) => { locked = message; }, () => { demo = true; });
  assert.equal(surfaced, 'drifted');
  assert.equal(locked, null);
  assert.equal(demo, false, 'a malformed state payload must not fall back to demo data');
});

test('load failure routing: a credential failure locks the console, never the demo fallback', () => {
  let surfaced: string | null = null;
  let locked: string | null = null;
  let demo = false;
  applyLoadFailure(
    new CasCredentialError('The device credential was rejected by the server (revoked or unknown).'),
    (message) => { surfaced = message; },
    (message) => { locked = message; },
    () => { demo = true; },
  );
  assert.equal(surfaced, null);
  assert.equal(demo, false, 'a missing/rejected credential must not fall back to demo data');
  assert.match(locked ?? '', /credential was rejected/);
});

test('load failure routing: only a genuinely unreachable server keeps the demo fallback', () => {
  let surfaced: string | null = null;
  let locked: string | null = null;
  let demo = false;
  applyLoadFailure(new Error('Unable to load durable state'), (message) => { surfaced = message; }, (message) => { locked = message; }, () => { demo = true; });
  assert.equal(surfaced, null);
  assert.equal(locked, null);
  assert.equal(demo, true);
});

test('cancel prompt -> locked state, not sample incidents', async () => {
  // Simulate a browser where the operator cancels the enrollment prompt:
  // the load path must surface a credential lock and never reach for the
  // demo seed — and no request may go out without a credential.
  const store = new Map<string, string>();
  const globals = globalThis as Record<string, unknown>;
  const original = { window: globals.window, sessionStorage: globals.sessionStorage, fetch: globals.fetch };
  let fetchCalled = false;
  globals.window = { prompt: () => null, alert: () => {} };
  globals.sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  globals.fetch = async () => { fetchCalled = true; throw new Error('no request may be attempted without a credential'); };
  try {
    let surfaced: string | null = null;
    let locked: string | null = null;
    let demo = false;
    await casAuthedFetch('/api/cas/state').then(
      () => assert.fail('a cancelled enrollment prompt must reject the load'),
      (error: unknown) => {
        assert.ok(error instanceof CasCredentialError, 'the cancel path must be a credential error, not a generic failure');
        applyLoadFailure(error, (message) => { surfaced = message; }, (message) => { locked = message; }, () => { demo = true; });
      },
    );
    assert.equal(fetchCalled, false, 'no request may be attempted without a credential');
    assert.equal(surfaced, null);
    assert.equal(demo, false, 'a cancelled prompt must not fall back to sample incidents');
    assert.match(locked ?? '', /credential is required/);
  } finally {
    globals.window = original.window;
    globals.sessionStorage = original.sessionStorage;
    globals.fetch = original.fetch;
  }
});

test('the mismatch surface renders the reason and a retry, with no console data', () => {
  const html = renderToStaticMarkup(
    createElement(StateResponseError, { message: 'The server’s state response does not match what this console expects (gates.0.status: Invalid enum value).' , onRetry: () => {} }),
  );
  assert.match(html, /data-testid="state-response-error"/);
  assert.match(html, /Server response not understood/);
  assert.match(html, /does not match what this console expects/);
  assert.match(html, /No console data is being shown/);
  assert.match(html, /data-testid="button-retry-state-load"/);
});

test('the locked surface renders the reason and an unlock retry, with no console data', () => {
  const html = renderToStaticMarkup(
    createElement(ConsoleLocked, { message: 'An enrolled device credential is required for this action.', onUnlock: () => {} }),
  );
  assert.match(html, /data-testid="console-locked"/);
  assert.match(html, /Console locked/);
  assert.match(html, /credential is required/);
  assert.match(html, /No incident data is being shown/);
  assert.match(html, /data-testid="button-unlock-console"/);
  assert.doesNotMatch(html, /SAMPLE EVIDENCE/, 'the locked surface must not render sample incidents');
});

test('the offline fallback labels itself as demo data and offers a retry', () => {
  const html = renderToStaticMarkup(createElement(OfflineDemoBanner, { onRetry: () => {} }));
  assert.match(html, /data-testid="banner-offline-demo"/);
  assert.match(html, /Server unreachable/);
  assert.match(html, /demo data/);
  assert.match(html, /not live incident state/);
  assert.match(html, /data-testid="button-retry-offline-load"/);
});
