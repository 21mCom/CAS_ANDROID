import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CasStateShapeError } from '@/lib/cas-state-schema';
import { parseCasOutboxStatusResponse } from '@/lib/cas-outbox-status-schema';
import { outboxPollFailure, requestOutboxStatus } from '@/hooks/use-outbox-status';

/**
 * Runtime contract for GET /api/cas/outbox/status: the polling hook must
 * reject a drifted server response loudly (CasStateShapeError → a visible
 * mismatch warning on the pipeline panel/banner) instead of blind-casting
 * it and rendering wrong pipeline health.
 */

function validStatus() {
  return {
    counts: { QUEUED: 1, PROCESSING: 0, FAILED: 0, SENT: 4, DEAD_LETTER: 0 },
    oldestPendingAt: '2026-09-27T14:08:12.000Z',
    lastDeliveryError: { transport: 'SMS', state: 'FAILED', attempts: 3, message: 'provider timeout' },
    smsDeliveryMode: 'gateway',
    deviceChannels: [] as string[],
    deviceAuthConfigured: true,
    worker: {
      workerId: 'worker-1',
      intervalMs: 10_000,
      batchSize: 10,
      startedAt: '2026-09-27T14:00:00.000Z',
      lastTickAt: '2026-09-27T14:08:10.000Z',
      lastTickDurationMs: 42,
      ticksCompleted: 6,
      lastTick: { claimed: 1, sent: 1, failed: 0, deadLettered: 0 },
      lastError: null,
      stoppedAt: null,
    },
  };
}

test('a status response matching the contract parses through unchanged', () => {
  const status = validStatus();
  assert.deepEqual(parseCasOutboxStatusResponse(status), status);
  const quiet = validStatus();
  assert.deepEqual(
    parseCasOutboxStatusResponse({ ...quiet, oldestPendingAt: null, lastDeliveryError: null, worker: null }),
    { ...quiet, oldestPendingAt: null, lastDeliveryError: null, worker: null },
  );
});

test('a missing required field is rejected with the offending path named', () => {
  const status = validStatus() as Record<string, unknown>;
  delete status.counts;
  assert.throws(
    () => parseCasOutboxStatusResponse(status),
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /Server's outbox status response does not match/i);
      assert.match(error.message, /counts/);
      return true;
    },
  );
});

test('a mistyped count is rejected, not rendered as pipeline health', () => {
  const status = validStatus();
  (status.counts as Record<string, unknown>).QUEUED = '3';
  assert.throws(
    () => parseCasOutboxStatusResponse(status),
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /counts\.QUEUED/);
      return true;
    },
  );
});

test('a renamed delivery-mode value is rejected, not silently misread', () => {
  const status = validStatus() as Record<string, unknown>;
  status.smsDeliveryMode = 'carrier-pigeon';
  assert.throws(
    () => parseCasOutboxStatusResponse(status),
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /smsDeliveryMode/);
      return true;
    },
  );
});

test('an added-but-unmirrored field is rejected (strict objects), so an older console never silently drops newer data', () => {
  const status = validStatus() as Record<string, unknown>;
  status.newServerField = 'surprise';
  assert.throws(() => parseCasOutboxStatusResponse(status), CasStateShapeError);
});

test('a non-object body is rejected instead of blowing up on property access', () => {
  for (const body of [null, 42, 'garbage', []]) {
    assert.throws(() => parseCasOutboxStatusResponse(body), CasStateShapeError);
  }
});

function stubResponse({ ok, body, jsonThrows = false }: { ok: boolean; body?: unknown; jsonThrows?: boolean }): Response {
  return {
    ok,
    json: async () => {
      if (jsonThrows) throw new SyntaxError('Unexpected token');
      return body;
    },
  } as unknown as Response;
}

test('the poll request parses a well-formed body into the hook status', async () => {
  const status = validStatus();
  const fetchImpl = async () => stubResponse({ ok: true, body: status });
  assert.deepEqual(await requestOutboxStatus(fetchImpl as typeof fetch, 'token'), status);
});

test('the poll request rejects a malformed 200 body as drift, not as an outage', async () => {
  const drifted = { ...validStatus(), counts: { QUEUED: 'many' } };
  const fetchImpl = async () => stubResponse({ ok: true, body: drifted });
  await assert.rejects(
    () => requestOutboxStatus(fetchImpl as typeof fetch, 'token'),
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /outbox status response does not match/);
      return true;
    },
  );
});

test('the poll request rejects a non-JSON 200 body as drift, not as an outage', async () => {
  const fetchImpl = async () => stubResponse({ ok: true, jsonThrows: true });
  await assert.rejects(
    () => requestOutboxStatus(fetchImpl as typeof fetch, 'token'),
    (error: unknown) => {
      assert.ok(error instanceof CasStateShapeError);
      assert.match(error.message, /not valid JSON/);
      return true;
    },
  );
});

test('the poll request treats a non-OK status as an ordinary load failure', async () => {
  const fetchImpl = async () => stubResponse({ ok: false });
  await assert.rejects(
    () => requestOutboxStatus(fetchImpl as typeof fetch, 'token'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof CasStateShapeError));
      return true;
    },
  );
});

test('poll failure routing: drift flags the mismatch, an outage flags unreachable', () => {
  const drift = outboxPollFailure(new CasStateShapeError('drifted'));
  assert.equal(drift.unreachable, false);
  assert.equal(drift.mismatch, 'drifted');

  const outage = outboxPollFailure(new Error('Unable to load outbox status'));
  assert.equal(outage.unreachable, true);
  assert.equal(outage.mismatch, null);
});
