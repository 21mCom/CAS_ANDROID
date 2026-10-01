import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evidenceDownloadFilename,
  fallbackEvidenceFilename,
  filenameFromContentDisposition,
} from '@/lib/evidence-download';

/**
 * The console must save a downloaded evidence clip under exactly the
 * filename the server's download route put in Content-Disposition —
 * camera label included — and its header-less fallback must rebuild that
 * same scheme instead of dropping the label (the original bug).
 */

test('the Content-Disposition filename wins verbatim, camera label included', () => {
  const filename = evidenceDownloadFilename(
    'attachment; filename="cas-inc-9-photo-front-2.jpg"',
    'inc-9',
    { kind: 'photo', sequence: 2, camera: 'front' },
  );
  assert.equal(filename, 'cas-inc-9-photo-front-2.jpg');
});

test('unquoted Content-Disposition filenames are honored too', () => {
  assert.equal(
    filenameFromContentDisposition('attachment; filename=cas-inc-9-video-back-1.mp4'),
    'cas-inc-9-video-back-1.mp4',
  );
});

test('a path-bearing header is reduced to its basename', () => {
  assert.equal(
    filenameFromContentDisposition('attachment; filename="../etc/evil.jpg"'),
    'evil.jpg',
  );
  assert.equal(
    filenameFromContentDisposition('attachment; filename="..\\evil.jpg"'),
    'evil.jpg',
  );
});

test('missing or unusable headers yield no filename', () => {
  assert.equal(filenameFromContentDisposition(null), null);
  assert.equal(filenameFromContentDisposition('attachment'), null);
  assert.equal(filenameFromContentDisposition('attachment; filename=""'), null);
});

test('the fallback mirrors the server scheme: camera label for photo/video', () => {
  assert.equal(
    fallbackEvidenceFilename('inc-9', { kind: 'photo', sequence: 2, camera: 'front' }),
    'cas-inc-9-photo-front-2.jpg',
  );
  assert.equal(
    fallbackEvidenceFilename('inc-9', { kind: 'video', sequence: 1, camera: 'back' }),
    'cas-inc-9-video-back-1.mp4',
  );
});

test('the fallback omits the camera label only when the clip has none', () => {
  assert.equal(
    fallbackEvidenceFilename('inc-9', { kind: 'photo', sequence: 1, camera: null }),
    'cas-inc-9-photo-1.jpg',
  );
  assert.equal(
    fallbackEvidenceFilename('inc-9', { kind: 'audio', sequence: 3, camera: null }),
    'cas-inc-9-audio-3.m4a',
  );
});

test('without a header the console still saves the camera-labeled name', () => {
  assert.equal(
    evidenceDownloadFilename(null, 'inc-9', { kind: 'photo', sequence: 2, camera: 'front' }),
    'cas-inc-9-photo-front-2.jpg',
  );
});
