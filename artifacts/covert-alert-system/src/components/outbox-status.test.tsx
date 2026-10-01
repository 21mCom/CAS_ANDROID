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
    counts: { QUEUED: 0, PROCESSING: 0, FAILED: 0, SENT: 4, DEAD_LETTER: 0, WITHDRAWN: 0 },
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
    email: null,
    ...overrides,
  };
}

function emailHealth(overrides: Partial<NonNullable<OutboxStatus['email']>>): NonNullable<OutboxStatus['email']> {
  return {
    probeIntervalMs: 7 * 24 * 60 * 60 * 1000,
    startedAt: new Date(NOW - 86_400_000).toISOString(),
    state: 'ok',
    target: 'environment',
    lastProbeAt: new Date(NOW - 3_600_000).toISOString(),
    lastOkAt: new Date(NOW - 3_600_000).toISOString(),
    lastFailure: null,
    note: null,
    stoppedAt: null,
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
    counts: { QUEUED: 0, PROCESSING: 0, FAILED: 0, SENT: 4, DEAD_LETTER: 1, WITHDRAWN: 0 },
    lastDeliveryError: {
      transport: 'SMS',
      state: 'DEAD_LETTER',
      attempts: 8,
      message: 'provider permanently rejects recipient',
    },
  }));

  // The red banner a responder must never miss.
  assert.match(html, /data-testid="outbox-status-warning-danger"/);
  assert.match(html, /1 alert could not be delivered and has been given up on/);
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
    counts: { QUEUED: 0, PROCESSING: 0, FAILED: 0, SENT: 4, DEAD_LETTER: 3, WITHDRAWN: 0 },
    lastDeliveryError: {
      transport: 'XMPP',
      state: 'DEAD_LETTER',
      attempts: 8,
      message: 'recipient unknown',
    },
  }));

  assert.match(html, /3 alerts could not be delivered and have been given up on/);
  assert.match(html, /Last error \(XMPP\): recipient unknown/);
});

test('a draining pipeline with no dead letters shows the healthy state instead', () => {
  const html = renderPanel(statusWith({}));

  assert.match(html, /data-testid="outbox-status-healthy"/);
  assert.doesNotMatch(html, /outbox-status-warning-danger/);
  assert.doesNotMatch(html, /given up on/);
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
  assert.match(html, /delivery status is in a format this console doesn’t recognize/);
  // No counts, no healthy chip, no stale heartbeat: nothing from a contract
  // this console does not understand may be mistaken for pipeline health.
  assert.doesNotMatch(html, /outbox-status-counts/);
  assert.doesNotMatch(html, /outbox-status-healthy/);
  assert.doesNotMatch(html, /reported any delivery activity/);
});

test('a drifted status response outranks every other pipeline signal', () => {
  const warnings = deriveOutboxWarnings({
    status: statusWith({ counts: { QUEUED: 0, PROCESSING: 0, FAILED: 0, SENT: 4, DEAD_LETTER: 2, WITHDRAWN: 0 } }),
    unreachable: true,
    mismatch: 'drifted',
    nowMs: NOW,
  });
  assert.deepEqual(warnings, [{ severity: 'danger', message: 'drifted' }]);
});

test('a mailbox that refused its app password raises the red email warning before any real alert', () => {
  const html = renderPanel(statusWith({
    email: emailHealth({
      state: 'failed',
      lastOkAt: new Date(NOW - 8 * 86_400_000).toISOString(),
      lastProbeAt: new Date(NOW - 3_600_000).toISOString(),
      lastFailure: {
        classification: 'authentication',
        message: 'SMTP auth rejected (535) — the mailbox refused these credentials',
        at: new Date(NOW - 3_600_000).toISOString(),
      },
    }),
  }));

  // The red alarm a responder must never miss: the mailbox is dead NOW,
  // discovered by the probe rather than by a dead-lettered real alert.
  assert.match(html, /data-testid="outbox-status-warning-danger"/);
  assert.match(html, /email alert mailbox failed its scheduled login check/);
  assert.match(html, /the mailbox refused these credentials/);
  assert.match(html, /Email alerts will not go out/);
  // The panel's probe line says when the check ran.
  assert.match(html, /data-testid="outbox-email-health"/);
  assert.match(html, /Email mailbox login check failed/);
  assert.doesNotMatch(html, /outbox-status-healthy/);
});

test('a transient probe failure raises only a caution, not the red alarm', () => {
  const html = renderPanel(statusWith({
    email: emailHealth({
      state: 'failed',
      lastFailure: {
        classification: 'socket-timeout',
        message: 'SMTP server did not answer within 10000ms',
        at: new Date(NOW - 3_600_000).toISOString(),
      },
    }),
  }));

  assert.match(html, /data-testid="outbox-status-warning-caution"/);
  assert.match(html, /could not be reached for its scheduled login check/);
  assert.doesNotMatch(html, /outbox-status-warning-danger/);
});

test('a healthy mailbox probe stays quiet and the panel shows the check cadence', () => {
  const html = renderPanel(statusWith({ email: emailHealth({}) }));

  assert.match(html, /data-testid="outbox-status-healthy"/);
  assert.match(html, /data-testid="outbox-email-health"/);
  assert.match(html, /Email mailbox login checked .* — healthy/);
  assert.doesNotMatch(html, /mailbox failed its scheduled login check/);
});

test('a stopped probe worker warns that mailbox rot would go unnoticed', () => {
  const warnings = deriveOutboxWarnings({
    status: statusWith({
      email: emailHealth({ stoppedAt: new Date(NOW - 30_000).toISOString() }),
    }),
    unreachable: false,
    mismatch: null,
    nowMs: NOW,
  });
  assert.ok(warnings.some((warning) =>
    warning.severity === 'caution' && /automatic mailbox check stopped/.test(warning.message),
  ));
});
