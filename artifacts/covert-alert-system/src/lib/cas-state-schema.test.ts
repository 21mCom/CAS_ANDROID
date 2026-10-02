import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CasStateShapeError, parseCasIncidentDetailResponse, parseCasStateResponse } from '@/lib/cas-state-schema';
import { applyActionFailure, applyLoadFailure, casAuthedFetch, CasCredentialError, lockOnCredentialFailure } from '@/hooks/use-field-test';
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
        deliveredTo: null,
        terminal: false,
      }],
      evidence: [{
        id: 'evi-1',
        kind: 'audio',
        contentType: 'audio/mp4',
        sizeBytes: 1024,
        sequence: 1,
        camera: null,
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

// --- GET /api/cas/incidents/:id/evidence (past-alert evidence browser) ----

function validIncidentDetail() {
  return {
    incident: { id: 'inc-1', status: 'RESOLVED', priority: 'P1', triggerCount: 2, createdAt: '2026-09-27T14:08:12.000Z' },
    evidence: [{
      id: 'evi-1',
      kind: 'photo',
      contentType: 'image/jpeg',
      sizeBytes: 2048,
      sequence: 1,
      camera: 'front',
      capturedAt: '2026-09-27T14:08:10.000Z',
      uploadedAt: '2026-09-27T14:09:00.000Z',
      requestId: null,
    }],
    events: [{ id: 'ev-1', type: 'EVIDENCE_DELETED', priority: 'P2', time: '2026-09-27T14:10:00.000Z', detail: 'detail' }],
  };
}

test('incident evidence detail: a response matching the contract parses through unchanged', () => {
  const detail = validIncidentDetail();
  assert.deepEqual(parseCasIncidentDetailResponse(detail), detail);
});

test('incident evidence detail: a payload smuggling clip bytes into the listing is rejected (strict objects)', () => {
  const detail = validIncidentDetail();
  (detail.evidence[0] as unknown as Record<string, unknown>).data = 'c2V1c2Q=';
  assert.throws(() => parseCasIncidentDetailResponse(detail), CasStateShapeError);
});

test('incident evidence detail: drifted or non-object bodies are rejected with the offending path named', () => {
  for (const body of [null, 42, 'garbage', []]) {
    assert.throws(() => parseCasIncidentDetailResponse(body), CasStateShapeError);
  }
  const detail = validIncidentDetail() as Record<string, unknown>;
  delete detail.events;
  assert.throws(
    () => parseCasIncidentDetailResponse(detail),
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /incident evidence/);
      assert.match(error.message, /events/);
      return true;
    },
  );
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

test('action failure routing: a mid-session credential failure locks the console instead of only alerting', () => {
  // An action's reload rejected with CasCredentialError (the credential was
  // revoked mid-session, e.g. the lost-phone revoke flow) must switch the
  // console to the locked surface — the last-loaded state is now stale and
  // must not stay on screen as if live behind only a transient alert.
  let surfaced: string | null = null;
  let locked: string | null = null;
  const reported: unknown[] = [];
  applyActionFailure(
    new CasCredentialError('The device credential was rejected by the server (revoked or unknown). The next action will ask for the enrollment credential again.'),
    (message) => { surfaced = message; },
    (message) => { locked = message; },
    (error) => { reported.push(error); },
  );
  assert.equal(surfaced, null, 'a credential failure is not a response-shape mismatch');
  assert.match(locked ?? '', /credential was rejected/);
  assert.equal(reported.length, 0, 'the lock replaces the alert; it does not add one');
});

test('action failure routing: other action errors keep the existing reporting behavior', () => {
  let surfaced: string | null = null;
  let locked: string | null = null;
  const reported: unknown[] = [];
  const other = new Error('Re-queue was rejected (409).');
  applyActionFailure(other, (message) => { surfaced = message; }, (message) => { locked = message; }, (error) => { reported.push(error); });
  assert.equal(surfaced, null);
  assert.equal(locked, null, 'a non-credential action error must not lock the console');
  assert.deepEqual(reported, [other]);
});

test('action failure routing: a drifted reload raises the mismatch surface like the initial load', () => {
  let surfaced: string | null = null;
  let locked: string | null = null;
  const reported: unknown[] = [];
  applyActionFailure(new CasStateShapeError('drifted'), (message) => { surfaced = message; }, (message) => { locked = message; }, (error) => { reported.push(error); });
  assert.equal(surfaced, 'drifted');
  assert.equal(locked, null);
  assert.equal(reported.length, 0);
});

// Promise-returning actions (outbox requeue, capture request, Gate 0A
// report import) hand their rejections to the calling page for inline
// display, so a mid-session credential loss on one of them would leave the
// stale incident view on screen unless the provider locks the console
// itself, no matter what the caller does with the error.

test('promise-returning actions lock the console when the action fetch discovers the credential is revoked', async () => {
  let locked: string | null = null;
  const credentialError = new CasCredentialError('The device credential was rejected by the server (revoked or unknown). The next action will ask for the enrollment credential again.');
  const action = (async (): Promise<void> => { throw credentialError; })();
  await lockOnCredentialFailure(action, (message) => { locked = message; }).then(
    () => assert.fail('the action rejection must still reach the caller'),
    (error: unknown) => assert.equal(error, credentialError, 'the error is rethrown so the caller\u2019s local reporting still runs'),
  );
  assert.match(locked ?? '', /credential was rejected/);
});

test('promise-returning actions lock the console when the post-action reload discovers the revocation', async () => {
  // The action's own request can succeed while the credential is revoked
  // before its state reload returns: the lock must fire for that rejection
  // too, since the caller sees only one rejected promise either way.
  let locked: string | null = null;
  const credentialError = new CasCredentialError('The device credential was rejected by the server (revoked or unknown). The next action will ask for the enrollment credential again.');
  const action = (async (): Promise<void> => {
    await Promise.resolve(); // the action request succeeds
    throw credentialError; // the reload then hits the revoked credential
  })();
  await lockOnCredentialFailure(action, (message) => { locked = message; }).then(
    () => assert.fail('the reload rejection must still reach the caller'),
    (error: unknown) => assert.equal(error, credentialError),
  );
  assert.match(locked ?? '', /credential was rejected/);
});

test('promise-returning actions never lock on operational rejections, which reach the caller untouched', async () => {
  let locked: string | null = null;
  const rejection = new Error('Capture request was rejected (409).');
  const action = (async (): Promise<void> => { throw rejection; })();
  await lockOnCredentialFailure(action, (message) => { locked = message; }).then(
    () => assert.fail('the operational rejection must reach the caller for inline display'),
    (error: unknown) => assert.equal(error, rejection),
  );
  assert.equal(locked, null, 'a non-credential rejection must not lock the console');
});

test('promise-returning actions return their value and never lock on success', async () => {
  let locked: string | null = null;
  const result = await lockOnCredentialFailure(Promise.resolve('ok'), (message) => { locked = message; });
  assert.equal(result, 'ok');
  assert.equal(locked, null);
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
  assert.match(html, /doesn&#x27;t recognize/);
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
  assert.match(html, /Nothing is shown while the console is locked/);
  assert.match(html, /data-testid="button-unlock-console"/);
  assert.doesNotMatch(html, /SAMPLE EVIDENCE/, 'the locked surface must not render sample incidents');
});

test('the offline fallback labels itself as demo data and offers a retry', () => {
  const html = renderToStaticMarkup(createElement(OfflineDemoBanner, { onRetry: () => {} }));
  assert.match(html, /data-testid="banner-offline-demo"/);
  assert.match(html, /server can&#x27;t be reached/);
  assert.match(html, /demo data/);
  assert.match(html, /isn&#x27;t live incident state|is not live incident state|Nothing on this screen is live incident state/);
  assert.match(html, /data-testid="button-retry-offline-load"/);
});
