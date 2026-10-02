import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppUpdateView } from '@/components/app-update-status';
import { requestAppUpdateManifest } from '@/hooks/use-app-update';
import { CasStateShapeError } from '@/lib/cas-state-schema';
import type { AppUpdateManifest, AppUpdateStatus } from '@/hooks/use-app-update';

const NOW = new Date('2026-10-02T12:00:00.000Z').getTime();

const MANIFEST: AppUpdateManifest = {
  packageName: 'com.covertalert.kit',
  versionCode: 8,
  versionName: '0.8.1',
  sha256: '2da61935d74faa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff223344',
  sizeBytes: 4_213_069,
  publishedAt: '2026-10-02T06:12:00.000Z',
  downloadPath: '/api/cas/app-updates/latest.apk',
};

function stateWith(overrides: Partial<AppUpdateStatus>): AppUpdateStatus {
  return { manifest: null, unpublished: false, unreachable: false, mismatch: null, ...overrides };
}

function renderPanel(state: AppUpdateStatus): string {
  return renderToStaticMarkup(createElement(AppUpdateView, { state, nowMs: NOW }));
}

test('a published build shows version, build number, size, pin, and publish age', () => {
  const html = renderPanel(stateWith({ manifest: MANIFEST }));
  assert.match(html, /0\.8\.1/);
  assert.match(html, /build 8/);
  assert.match(html, /4\.0 MB/);
  assert.match(html, /2da61935d74f…ff223344/);
  assert.match(html, /app-update-published/);
  // The full hash rides the title attribute for comparison.
  assert.match(html, /2da61935d74faa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff223344/);
});

test('a 404 answer renders the clear nothing-published state', () => {
  const html = renderPanel(stateWith({ unpublished: true }));
  assert.match(html, /No update build is published/);
  assert.match(html, /app-update-none/);
  assert.doesNotMatch(html, /app-update-published/);
});

test('a drifted contract hides the last snapshot and shows only the mismatch warning', () => {
  const html = renderPanel(stateWith({ manifest: MANIFEST, mismatch: 'shape drifted' }));
  assert.match(html, /app-update-mismatch/);
  assert.match(html, /doesn&#x27;t recognize/);
  assert.doesNotMatch(html, /app-update-published/);
  assert.doesNotMatch(html, /2da61935d74f/);
});

test('a plain outage keeps the last known build but flags that the console lost sight of it', () => {
  const html = renderPanel(stateWith({ manifest: MANIFEST, unreachable: true }));
  assert.match(html, /app-update-unreachable/);
  assert.match(html, /last known build/);
  assert.match(html, /app-update-published/);
});

test('nothing renders before the first answer (no false empty state)', () => {
  const html = renderPanel(stateWith({}));
  assert.equal(html, '');
});

test('requestAppUpdateManifest maps a 404 to null (nothing published), not an error', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ error: 'No app update has been published on this server.' }), { status: 404 })) as typeof fetch;
  const result = await requestAppUpdateManifest(fakeFetch, 'token');
  assert.equal(result, null);
});

test('requestAppUpdateManifest sends the enrolled credential and parses a 200', async () => {
  let seenAuth: string | null = null;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seenAuth = new Headers(init?.headers).get('authorization');
    return new Response(JSON.stringify(MANIFEST), { status: 200 });
  }) as typeof fetch;
  const result = await requestAppUpdateManifest(fakeFetch, 'device-token-123');
  assert.equal(seenAuth, 'Bearer device-token-123');
  assert.equal(result?.versionCode, 8);
});

test('requestAppUpdateManifest throws on a non-OK, non-404 response', async () => {
  const fakeFetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  await assert.rejects(() => requestAppUpdateManifest(fakeFetch, 'token'), /Unable to load/);
});

test('requestAppUpdateManifest treats a non-JSON 200 as contract drift', async () => {
  const fakeFetch = (async () => new Response('<html>proxy error</html>', { status: 200 })) as typeof fetch;
  await assert.rejects(() => requestAppUpdateManifest(fakeFetch, 'token'), CasStateShapeError);
});
