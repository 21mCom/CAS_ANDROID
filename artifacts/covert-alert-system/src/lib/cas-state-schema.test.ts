import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CasStateShapeError, parseCasStateResponse } from '@/lib/cas-state-schema';
import { applyLoadFailure } from '@/hooks/use-field-test';
import { StateResponseError } from '@/components/state-response-error';

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
  let demo = false;
  applyLoadFailure(new CasStateShapeError('drifted'), (message) => { surfaced = message; }, () => { demo = true; });
  assert.equal(surfaced, 'drifted');
  assert.equal(demo, false, 'a malformed state payload must not fall back to demo data');
});

test('load failure routing: unrelated failures keep the existing demo fallback', () => {
  let surfaced: string | null = null;
  let demo = false;
  applyLoadFailure(new Error('Unable to load durable state'), (message) => { surfaced = message; }, () => { demo = true; });
  assert.equal(surfaced, null);
  assert.equal(demo, true);
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
