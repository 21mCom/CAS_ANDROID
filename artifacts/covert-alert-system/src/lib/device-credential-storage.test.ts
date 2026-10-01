import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVICE_TOKEN_KEY,
  clearStoredDeviceToken,
  readStoredDeviceToken,
  registerDeviceEnrollmentPrompt,
  requestDeviceEnrollment,
  storeDeviceToken,
} from './device-credential-storage';

/**
 * Minimal Storage shim; installed per test so the two stores can be
 * inspected independently (session vs. local is the whole point here).
 */
function stubStorages() {
  const session = new Map<string, string>();
  const local = new Map<string, string>();
  const globals = globalThis as Record<string, unknown>;
  const original = { sessionStorage: globals.sessionStorage, localStorage: globals.localStorage };
  const make = (store: Map<string, string>) => ({
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
  globals.sessionStorage = make(session);
  globals.localStorage = make(local);
  return {
    session,
    local,
    restore() {
      globals.sessionStorage = original.sessionStorage;
      globals.localStorage = original.localStorage;
    },
  };
}

test('a session-only enrollment is stored in sessionStorage and clears any local copy', () => {
  const { session, local, restore } = stubStorages();
  try {
    local.set(DEVICE_TOKEN_KEY, 'older-persisted-token');
    storeDeviceToken('session-token', false);
    assert.equal(session.get(DEVICE_TOKEN_KEY), 'session-token');
    assert.equal(local.has(DEVICE_TOKEN_KEY), false);
    assert.equal(readStoredDeviceToken(), 'session-token');
  } finally {
    restore();
  }
});

test('a keep-signed-in enrollment is stored in localStorage and clears any session copy', () => {
  const { session, local, restore } = stubStorages();
  try {
    session.set(DEVICE_TOKEN_KEY, 'older-session-token');
    storeDeviceToken('persisted-token', true);
    assert.equal(local.get(DEVICE_TOKEN_KEY), 'persisted-token');
    assert.equal(session.has(DEVICE_TOKEN_KEY), false);
    assert.equal(readStoredDeviceToken(), 'persisted-token');
  } finally {
    restore();
  }
});

test('lookup prefers the session copy when both storages hold a token', () => {
  const { session, local, restore } = stubStorages();
  try {
    session.set(DEVICE_TOKEN_KEY, 'session-token');
    local.set(DEVICE_TOKEN_KEY, 'persisted-token');
    assert.equal(readStoredDeviceToken(), 'session-token');
  } finally {
    restore();
  }
});

test('clearing the token removes it from both storages', () => {
  const { session, local, restore } = stubStorages();
  try {
    session.set(DEVICE_TOKEN_KEY, 'session-token');
    local.set(DEVICE_TOKEN_KEY, 'persisted-token');
    clearStoredDeviceToken();
    assert.equal(readStoredDeviceToken(), null);
    assert.equal(session.has(DEVICE_TOKEN_KEY), false);
    assert.equal(local.has(DEVICE_TOKEN_KEY), false);
  } finally {
    restore();
  }
});

test('no stored token reads as null (the enrollment dialog must open)', () => {
  const { restore } = stubStorages();
  try {
    assert.equal(readStoredDeviceToken(), null);
  } finally {
    restore();
  }
});

test('the enrollment prompt bridge hands the exchange to the dialog and unregisters cleanly', async () => {
  const exchange = async () => null;
  assert.equal(requestDeviceEnrollment(exchange), null, 'no dialog mounted means no silent fallback');
  const unregister = registerDeviceEnrollmentPrompt(async (received) => {
    // The dialog drives the exchange and only resolves once it closes:
    // true when the exchange enrolled a credential, false when cancelled.
    assert.equal(await received({ credential: 'enrollment-credential', keepSignedIn: true }), null);
    return true;
  });
  const enrolled = await requestDeviceEnrollment(exchange);
  assert.equal(enrolled, true);
  unregister();
  assert.equal(requestDeviceEnrollment(exchange), null, 'unmounted dialog means no prompt');
});
