import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmailProbeHealthLine } from '@/pages/email';
import type { EmailChannelHealth } from '@/hooks/use-outbox-status';

const NOW = new Date('2026-09-15T12:00:00.000Z').getTime();

function health(overrides: Partial<EmailChannelHealth>): EmailChannelHealth {
  return {
    probeIntervalMs: 7 * 24 * 60 * 60 * 1000,
    startedAt: new Date(NOW - 86_400_000).toISOString(),
    state: 'ok',
    target: 'console',
    lastProbeAt: new Date(NOW - 3_600_000).toISOString(),
    lastOkAt: new Date(NOW - 3_600_000).toISOString(),
    lastFailure: null,
    note: null,
    stoppedAt: null,
    ...overrides,
  };
}

function render(overrides: Partial<EmailChannelHealth>): string {
  return renderToStaticMarkup(createElement(EmailProbeHealthLine, { health: health(overrides), nowMs: NOW }));
}

test('a healthy console probe shows the ok outcome, the age, and the re-check cadence', () => {
  const html = render({});
  assert.match(html, /data-state="ok"/);
  assert.match(html, /Last automatic login check of the mailbox saved on this page/);
  assert.match(html, /ok<\/strong>, 60 min ago/);
  assert.match(html, /Re-checks every 7d/);
});

test('a permanent probe failure shows the classification, the age, and the redacted failure message', () => {
  const html = render({
    state: 'failed',
    lastProbeAt: new Date(NOW - 120_000).toISOString(),
    lastOkAt: new Date(NOW - 86_400_000).toISOString(),
    lastFailure: {
      classification: 'authentication',
      message: 'Primary mailbox login check failed: [redacted]',
      at: new Date(NOW - 120_000).toISOString(),
    },
  });
  assert.match(html, /data-state="failed"/);
  assert.match(html, /data-permanent="true"/);
  assert.match(html, /failed \(authentication\)/);
  assert.match(html, /2 min ago/);
  assert.match(html, /Email alerts will not go out until the mailbox is fixed/);
  assert.match(html, /Primary mailbox login check failed: \[redacted\]/);
});

test('a transient probe failure stays uncertain instead of declaring an outage', () => {
  const html = render({
    state: 'failed',
    target: 'environment',
    lastFailure: {
      classification: 'dns',
      message: 'Mailbox login check failed: host unreachable',
      at: new Date(NOW - 60_000).toISOString(),
    },
  });
  assert.match(html, /data-state="failed"/);
  assert.match(html, /data-permanent="false"/);
  assert.match(html, /the server-secrets mailbox \(CAS_EMAIL_\*\)/);
  assert.match(html, /failed \(dns\)/);
  assert.match(html, /if this persists, email alerts may not go out/);
  assert.doesNotMatch(html, /will not go out until the mailbox is fixed/);
});

test('a permanent environment failure points at the server secrets, not the console form', () => {
  const html = render({
    state: 'failed',
    target: 'environment',
    lastFailure: {
      classification: 'authentication',
      message: 'Mailbox login check failed: [redacted]',
      at: new Date(NOW - 60_000).toISOString(),
    },
  });
  assert.match(html, /data-permanent="true"/);
  assert.match(html, /CAS_EMAIL_\* server secrets/);
});

test('a skipped probe shows the reason instead of a verdict', () => {
  const html = render({
    state: 'skipped',
    target: 'none',
    lastProbeAt: null,
    lastOkAt: null,
    note: 'No email delivery is configured, so there is no mailbox to probe.',
  });
  assert.match(html, /data-state="skipped"/);
  assert.match(html, /skipped — No email delivery is configured/);
  assert.doesNotMatch(html, /failed|ok<\/strong>/);
});

test('a pending probe says the first check has not run yet', () => {
  const html = render({ state: 'pending', lastProbeAt: null, lastOkAt: null });
  assert.match(html, /data-state="pending"/);
  assert.match(html, /the first probe has not run yet/);
});

test('an ok probe without a probe timestamp falls back to the pending wording', () => {
  const html = render({ state: 'ok', lastProbeAt: null, lastOkAt: null });
  assert.match(html, /data-state="pending"/);
});
