import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OutboxStatusView } from '@/components/outbox-status';
import { deriveOutboxWarnings } from '@/lib/outbox-warnings';
import type { OutboxStatus } from '@/hooks/use-outbox-status';

const NOW = new Date('2026-09-15T12:00:00.000Z').getTime();

function statusWith(overrides: Partial<OutboxStatus>): OutboxStatus {
  return {
    counts: { QUEUED: 0, PROCESSING: 0, FAILED: 0, SENT: 4, DEAD_LETTER: 0 },
    oldestPendingAt: null,
    lastDeliveryError: null,
    smsDeliveryMode: 'gateway',
    deviceChannels: [],
    deviceAuthConfigured: false,
    worker: {
      workerId: 'test-worker',
      intervalMs: 10_000,
      batchSize: 10,
      startedAt: new Date(NOW - 60_000).toISOString(),
      lastTickAt: new Date(NOW - 5_000).toISOString(),
      lastTickDurationMs: 42,
      ticksCompleted: 6,
      lastTick: { claimed: 1, sent: 1, failed: 0, deadLettered: 0 },
      lastError: null,
      stoppedAt: null,
    },
    ...overrides,
  };
}

function renderPanel(status: OutboxStatus | null, unreachable = false, mismatch: string | null = null): string {
  return renderToStaticMarkup(
    createElement(OutboxStatusView, { status, unreachable, mismatch, nowMs: NOW }),
  );
}

test('a dead-lettered delivery raises the red abandoned warning with the provider error', () => {
  const html = renderPanel(statusWith({
    counts: { QUEUED: 0, PROCESSING: 0, FAILED: 0, SENT: 4, DEAD_LETTER: 1 },
    lastDeliveryError: {
      transport: 'SMS',
      state: 'DEAD_LETTER',
      attempts: 8,
      message: 'provider permanently rejects recipient',
    },
  }));

  // The red banner a responder must never miss.
  assert.match(html, /data-testid="outbox-status-warning-danger"/);
  assert.match(html, /1 delivery has been abandoned \(dead letter\)/);
  assert.match(html, /no further retries will be made/);
  // The banner names the provider's last error so the responder knows why.
  assert.match(html, /Last error \(SMS\): provider permanently rejects recipient/);
  // The dead-letter cell is called out in the counts row.
  assert.match(html, /data-testid="outbox-count-dead-letter">1</);
  // A pipeline with an abandoned delivery is never reported as healthy.
  assert.doesNotMatch(html, /outbox-status-healthy/);
});

test('plural dead-letter count reads correctly', () => {
  const html = renderPanel(statusWith({
    counts: { QUEUED: 0, PROCESSING: 0, FAILED: 0, SENT: 4, DEAD_LETTER: 3 },
    lastDeliveryError: {
      transport: 'XMPP',
      state: 'DEAD_LETTER',
      attempts: 8,
      message: 'recipient unknown',
    },
  }));

  assert.match(html, /3 deliveries have been abandoned \(dead letter\)/);
  assert.match(html, /Last error \(XMPP\): recipient unknown/);
});

test('a draining pipeline with no dead letters shows the healthy state instead', () => {
  const html = renderPanel(statusWith({}));

  assert.match(html, /data-testid="outbox-status-healthy"/);
  assert.doesNotMatch(html, /outbox-status-warning-danger/);
  assert.doesNotMatch(html, /abandoned \(dead letter\)/);
  assert.match(html, /data-testid="outbox-count-dead-letter">0</);
});

test('a drifted status response raises the red mismatch warning and withholds pipeline data', () => {
  const drift = "The server's outbox status response does not match what this console expects (counts.QUEUED: Expected number, received string). The server may be running a different version than this console; refresh once, and if it persists redeploy the matching server build.";
  // The hook drops the last snapshot on mismatch, so the panel gets no status.
  const html = renderPanel(null, false, drift);

  // The mismatch surfaces as the red alarm a responder must never miss.
  assert.match(html, /data-testid="outbox-status-warning-danger"/);
  assert.match(html, /does not match what this console expects/);
  assert.match(html, /counts\.QUEUED/);
  assert.match(html, /Delivery status response not understood by this console/);
  // No counts, no healthy chip, no stale heartbeat: nothing from a contract
  // this console does not understand may be mistaken for pipeline health.
  assert.doesNotMatch(html, /outbox-status-counts/);
  assert.doesNotMatch(html, /outbox-status-healthy/);
  assert.doesNotMatch(html, /No worker heartbeat recorded/);
});

test('a drifted status response outranks every other pipeline signal', () => {
  const warnings = deriveOutboxWarnings({
    status: statusWith({ counts: { QUEUED: 0, PROCESSING: 0, FAILED: 0, SENT: 4, DEAD_LETTER: 2 } }),
    unreachable: true,
    mismatch: 'drifted',
    nowMs: NOW,
  });
  assert.deepEqual(warnings, [{ severity: 'danger', message: 'drifted' }]);
});
