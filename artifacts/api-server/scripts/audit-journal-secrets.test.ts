import assert from "node:assert/strict";
import { test } from "node:test";
import { scanDetailsForSecrets } from "../src/lib/note-secrets";

const createdAt = new Date("2026-09-01T00:00:00Z");

function entry(id: string, detail: string) {
  return { id, incidentId: `incident-for-${id}`, createdAt, detail };
}

test("audit scan flags each known secret shape with its label", () => {
  const leakedDetails: Array<[string, string, RegExp]> = [
    ["evt-stripe", "Responder note: Rotated key to sk_live_EXAMPLEPLACEHOLDER", /provider API key/],
    ["evt-openai", "Responder note: New key is sk-9f8e7d6c5b4a3210fedc9876", /provider API key/],
    ["evt-bearer", "Responder note: Set header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dbsj9s8df", /bearer token/],
    ["evt-kv", "Responder note: Updated provider password=Sup3rSecret!2026 in the console", /key=value/],
    ["evt-slack", "Responder note: New bot token xoxb-123456789012-abcdefghijkl", /Slack token/],
    ["evt-aws", "Responder note: AWS key AKIAEXAMPLEPLACEHOLDER still valid", /AWS access key/],
    ["evt-pem", "Responder note: -----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkq", /private key block/],
  ];
  const hits = scanDetailsForSecrets(leakedDetails.map(([id, detail]) => entry(id, detail)));
  assert.equal(hits.length, leakedDetails.length);
  for (const [id, , labelPattern] of leakedDetails) {
    const hit = hits.find((h) => h.eventId === id);
    assert.ok(hit, `expected a hit for ${id}`);
    assert.match(hit.patternLabel, labelPattern);
    assert.equal(hit.incidentId, `incident-for-${id}`);
    assert.equal(hit.createdAt, createdAt);
  }
});

test("audit scan reports only event id and label, never the detail text", () => {
  const secret = "sk_live_EXAMPLEPLACEHOLDER";
  const hits = scanDetailsForSecrets([entry("evt-1", `Responder note: rotated to ${secret}`)]);
  assert.equal(hits.length, 1);
  assert.deepEqual(Object.keys(hits[0]).sort(), ["createdAt", "eventId", "incidentId", "patternLabel"]);
  // Serializing a hit (for logs or CI output) must not leak the secret value.
  assert.ok(!JSON.stringify(hits).includes(secret));
});

test("audit scan returns one hit per pattern when an entry carries several secret shapes", () => {
  const hits = scanDetailsForSecrets([
    entry("evt-multi", "Responder note: sk_live_EXAMPLEPLACEHOLDER and AKIAEXAMPLEPLACEHOLDER"),
  ]);
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((h) => h.patternLabel).sort(),
    ["a provider API key", "an AWS access key"],
  );
});

test("audit scan leaves legitimate fix descriptions alone", () => {
  const clean = [
    "Responder note: Rotated the SMS provider credentials and verified auth in the provider console.",
    "Responder note: Checked the api_key rotation runbook and the password policy page.",
    "Responder note: Reissued the provider token; old one revoked.",
    "Responder re-queued the abandoned sms delivery after fixing the provider problem (previously abandoned after 8 attempts; last error: provider rejects stale credentials). The delivery worker will attempt it again.",
  ];
  assert.deepEqual(scanDetailsForSecrets(clean.map((detail, i) => entry(`evt-clean-${i}`, detail))), []);
});
