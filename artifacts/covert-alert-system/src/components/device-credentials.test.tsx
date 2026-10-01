import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeviceListView, formatDeviceTimestamp } from '@/components/device-credentials';
import { listCasDevices, revokeCasDevice, type CasDevice } from '@/hooks/use-field-test';

const activeDevice: CasDevice = {
  id: 'dev-pixel11',
  label: 'Owner Pixel 11',
  createdAt: '2026-09-20T08:15:00.000Z',
  lastUsedAt: '2026-09-27T14:08:31.000Z',
  revokedAt: null,
};

const revokedDevice: CasDevice = {
  id: 'dev-oldconsole',
  label: 'Ops console browser',
  createdAt: '2026-09-18T10:00:00.000Z',
  lastUsedAt: null,
  revokedAt: '2026-09-21T09:30:00.000Z',
};

function renderList(devices: CasDevice[], confirmingId: string | null = null): string {
  return renderToStaticMarkup(createElement(DeviceListView, {
    devices,
    confirmingId,
    busy: false,
    onConfirmRevoke: () => {},
    onCancelRevoke: () => {},
    onRevoke: () => {},
  }));
}

test('the device list shows id, label, last-used, and active/revoked state', () => {
  const html = renderList([activeDevice, revokedDevice]);

  assert.match(html, /Owner Pixel 11/);
  assert.match(html, /dev-pixel11/);
  assert.match(html, /Last used 2026-09-27 14:08 UTC/);
  assert.match(html, /data-testid="device-state-dev-pixel11">Active/);
  // An active device offers a revoke action.
  assert.match(html, /data-testid="button-revoke-dev-pixel11"/);

  // A revoked device is shown as revoked with its timestamp and "never" for
  // last-used, and offers no revoke action.
  assert.match(html, /data-testid="device-state-dev-oldconsole">Revoked 2026-09-21 09:30 UTC/);
  assert.match(html, /Last used never/);
  assert.doesNotMatch(html, /data-testid="button-revoke-dev-oldconsole"/);
});

test('the confirmation step spells out the consequence before revoking', () => {
  const html = renderList([activeDevice], activeDevice.id);

  assert.match(html, /data-testid="confirm-revoke-dev-pixel11"/);
  assert.match(html, /blocked from its very next request/);
  assert.match(html, /data-testid="button-confirm-revoke-dev-pixel11"/);
  // The plain revoke button is replaced while confirming.
  assert.doesNotMatch(html, /data-testid="button-revoke-dev-pixel11"/);
});

test('an empty enrollment is called out, not rendered as a blank table', () => {
  assert.match(renderList([]), /data-testid="device-list-empty"/);
});

test('formatDeviceTimestamp renders null as never', () => {
  assert.equal(formatDeviceTimestamp(null), 'never');
  assert.equal(formatDeviceTimestamp('2026-09-27T14:08:31.123Z'), '2026-09-27 14:08 UTC');
});

// --- Helper contract: management calls carry the enrollment credential ----

type FetchCall = { input: string; init: RequestInit };

function stubFetch(impl: (call: FetchCall) => { status: number; body: unknown }): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call = { input: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body } = impl(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('listCasDevices authorizes with the enrollment credential, never a device token', async () => {
  const calls = stubFetch(() => ({ status: 200, body: { devices: [activeDevice] } }));

  const devices = await listCasDevices('enrollment-credential');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, '/api/cas/devices');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer enrollment-credential');
  assert.deepEqual(devices, [activeDevice]);
});

test('listCasDevices surfaces the server rejection on a 401', async () => {
  stubFetch(() => ({ status: 401, body: { error: 'The presented alert credential was rejected.' } }));

  await assert.rejects(() => listCasDevices('wrong'), /alert credential was rejected/);
});

test('revokeCasDevice posts with the enrollment credential and returns the revocation', async () => {
  const calls = stubFetch(() => ({ status: 200, body: { id: 'dev-pixel11', revokedAt: '2026-09-27T15:00:00.000Z' } }));

  const result = await revokeCasDevice('enrollment-credential', 'dev-pixel11');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, '/api/cas/devices/dev-pixel11/revoke');
  assert.equal(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer enrollment-credential');
  assert.equal(result.revokedAt, '2026-09-27T15:00:00.000Z');
});

test('revokeCasDevice surfaces the server rejection for an unknown device', async () => {
  stubFetch(() => ({ status: 404, body: { error: 'Device credential not found' } }));

  await assert.rejects(() => revokeCasDevice('enrollment-credential', 'dev-nope'), /not found/);
});
