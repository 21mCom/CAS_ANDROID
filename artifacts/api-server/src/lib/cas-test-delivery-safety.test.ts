import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEV_SINK_DELIVERED_TO,
  createDevSinkProviderAdapters,
  testHarnessDeliveryForced,
} from "./delivery-providers";
import { CasProviderError } from "./cas-provider-error";
import { assertDisposableTestDatabase } from "./cas-test-db-guard";

// Pure unit coverage for the test-harness safety rails (no database touched):
// the disposable-DB boot guard and the forced dev-sink delivery adapters.
// The end-to-end proof (burst against a spawned server with live-looking
// secrets) lives in routes/cas.test.ts.

test("delivery forcing is on for NODE_ENV=test and for the disposable-DB harness marker, off otherwise", () => {
  assert.equal(testHarnessDeliveryForced({ NODE_ENV: "test" } as NodeJS.ProcessEnv), true);
  assert.equal(testHarnessDeliveryForced({ CAS_TEST_DISPOSABLE_DB: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(testHarnessDeliveryForced({ NODE_ENV: "development" } as NodeJS.ProcessEnv), false);
  assert.equal(testHarnessDeliveryForced({ NODE_ENV: "production" } as NodeJS.ProcessEnv), false);
  assert.equal(testHarnessDeliveryForced({} as NodeJS.ProcessEnv), false);
});

test("disposable-database guard accepts the contract runner's markers", () => {
  assert.doesNotThrow(() =>
    assertDisposableTestDatabase({
      CAS_TEST_DISPOSABLE_DB: "1",
      DATABASE_URL: "postgresql://cas_contract_runner@127.0.0.1:55432/cas_contract_test",
      CAS_TEST_EXPECTED_DATABASE_NAME: "cas_contract_test",
      CAS_TEST_FORBIDDEN_DATABASE_URL: "postgresql://dev.example.internal/cas",
    } as NodeJS.ProcessEnv),
  );
});

test("disposable-database guard fails closed when the harness flag is set but the runner's markers are absent and DATABASE_URL is the dev database", () => {
  // The fail-open shape the completion review caught: CAS_TEST_DISPOSABLE_DB=1
  // is trivially settable by hand, so it must never be sufficient on its own.
  const devUrl = "postgresql://dev.example.internal/cas";
  assert.throws(
    () =>
      assertDisposableTestDatabase({
        CAS_TEST_DISPOSABLE_DB: "1",
        DATABASE_URL: devUrl,
      } as NodeJS.ProcessEnv),
    /refused to boot[\s\S]*CAS_TEST_EXPECTED_DATABASE_NAME[\s\S]*CAS_TEST_FORBIDDEN_DATABASE_URL/,
  );
});

test("disposable-database guard fails loudly without the harness marker", () => {
  assert.throws(
    () =>
      assertDisposableTestDatabase({
        DATABASE_URL: "postgresql://cas_contract_runner@127.0.0.1:55432/cas_contract_test",
        CAS_TEST_EXPECTED_DATABASE_NAME: "cas_contract_test",
      } as NodeJS.ProcessEnv),
    /refused to boot.*CAS_TEST_DISPOSABLE_DB/s,
  );
});

test("disposable-database guard fails loudly when DATABASE_URL is still the dev database", () => {
  const devUrl = "postgresql://dev.example.internal/cas";
  assert.throws(
    () =>
      assertDisposableTestDatabase({
        CAS_TEST_DISPOSABLE_DB: "1",
        DATABASE_URL: devUrl,
        CAS_TEST_EXPECTED_DATABASE_NAME: "cas_contract_test",
        CAS_TEST_FORBIDDEN_DATABASE_URL: devUrl,
      } as NodeJS.ProcessEnv),
    /refused to boot/s,
  );
});

test("disposable-database guard fails loudly on the wrong database name", () => {
  assert.throws(
    () =>
      assertDisposableTestDatabase({
        CAS_TEST_DISPOSABLE_DB: "1",
        DATABASE_URL: "postgresql://cas_contract_runner@127.0.0.1:55432/cas_dev",
        CAS_TEST_EXPECTED_DATABASE_NAME: "cas_contract_test",
      } as NodeJS.ProcessEnv),
    /expected the disposable "cas_contract_test"/,
  );
});

test("disposable-database guard fails loudly when DATABASE_URL is missing", () => {
  assert.throws(
    () =>
      assertDisposableTestDatabase({
        CAS_TEST_DISPOSABLE_DB: "1",
        CAS_TEST_EXPECTED_DATABASE_NAME: "cas_contract_test",
      } as NodeJS.ProcessEnv),
    /DATABASE_URL is not set/,
  );
});

test("forced sink adapters cover every gateway transport and report the dev sink", async () => {
  const adapters = createDevSinkProviderAdapters({
    CAS_SMS_RECIPIENTS: "+1555000111",
    CAS_XMPP_RECIPIENTS: "ops@example.org",
    CAS_EMAIL_RECIPIENTS: "owner@example.test",
    CAS_WHATSAPP_RECIPIENTS: "+1555000222",
    // Live-looking secrets that must be ignored entirely.
    CAS_EMAIL_SMTP_HOST: "smtp.example.test",
    CAS_EMAIL_SMTP_PASSWORD: "live-looking",
    CAS_SMS_PROVIDER_URL: "https://sms.example.test/submit",
  } as NodeJS.ProcessEnv);
  const message = {
    incidentId: "inc-test-sink",
    transport: "SMS",
    priority: "P1",
    body: "CAS P1 alert body",
  };
  for (const transport of ["sms", "xmpp", "email", "whatsapp"] as const) {
    const adapter = adapters[transport];
    assert.ok(adapter, `${transport} adapter missing`);
    const receipt = await adapter.send(
      { ...message, transport: transport.toUpperCase() },
      `unit-${transport}-${Math.random()}`,
    );
    assert.equal(receipt.deliveredTo, DEV_SINK_DELIVERED_TO);
  }
});

test("forced sink adapter keeps the explicit empty-recipients failure", async () => {
  const adapters = createDevSinkProviderAdapters({} as NodeJS.ProcessEnv);
  await assert.rejects(
    adapters.sms!.send(
      { incidentId: "inc-x", transport: "SMS", priority: "P1", body: "body" },
      "unit-empty-recipients",
      [],
    ),
    (error: unknown) =>
      error instanceof CasProviderError && error.classification === "not-configured",
  );
});

test("forced sink adapter keeps the [sink-fail] failure drill", async () => {
  const adapters = createDevSinkProviderAdapters({
    CAS_SMS_RECIPIENTS: "+1555000111",
  } as NodeJS.ProcessEnv);
  await assert.rejects(
    adapters.sms!.send(
      { incidentId: "inc-x", transport: "SMS", priority: "P1", body: "body [sink-fail]" },
      "unit-sink-fail",
    ),
    (error: unknown) =>
      error instanceof CasProviderError &&
      error.classification === "server-outage" &&
      error.retryable === true,
  );
});
