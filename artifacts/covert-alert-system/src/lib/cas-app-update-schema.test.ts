import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CasStateShapeError } from '@/lib/cas-state-schema';
import { parseCasAppUpdateManifest } from '@/lib/cas-app-update-schema';

const VALID_MANIFEST = {
  packageName: 'com.covertalert.kit',
  versionCode: 8,
  versionName: '0.8.1',
  sha256: '2da61935d74f0000000000000000000000000000000000000000000000000abc'.slice(0, 64),
  sizeBytes: 4_213_069,
  publishedAt: '2026-10-02T06:12:00.000Z',
  downloadPath: '/api/cas/app-updates/latest.apk',
};

test('a well-formed manifest parses', () => {
  const parsed = parseCasAppUpdateManifest(VALID_MANIFEST);
  assert.equal(parsed.versionCode, 8);
  assert.equal(parsed.versionName, '0.8.1');
  assert.equal(parsed.sha256, VALID_MANIFEST.sha256);
});

test('an unexpected key is rejected (strict mirror — drift must not pass silently)', () => {
  assert.throws(
    () => parseCasAppUpdateManifest({ ...VALID_MANIFEST, debugHint: 'oops' }),
    CasStateShapeError,
  );
});

test('a missing field is rejected', () => {
  const { versionCode, ...missing } = VALID_MANIFEST;
  assert.throws(() => parseCasAppUpdateManifest(missing), CasStateShapeError);
});

test('a non-hex or short SHA-256 pin is rejected', () => {
  assert.throws(
    () => parseCasAppUpdateManifest({ ...VALID_MANIFEST, sha256: 'not-a-hash' }),
    CasStateShapeError,
  );
});

test('a fractional versionCode is rejected', () => {
  assert.throws(
    () => parseCasAppUpdateManifest({ ...VALID_MANIFEST, versionCode: 8.5 }),
    CasStateShapeError,
  );
});
