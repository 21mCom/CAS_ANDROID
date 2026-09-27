import assert from "node:assert/strict";
import { test } from "node:test";
import { assertGate0aReportSize, MAX_GATE0A_REPORT_BYTES } from "./gate0a-import";

test("UI size gate accepts a real hardware-run report over 200,000 bytes", () => {
  // The documented 2026-09-14 Pixel 11 handoff report is ~250 KB (219 events,
  // 200 repeats); the UI must accept it or field operators cannot import real
  // evidence.
  assert.ok(
    MAX_GATE0A_REPORT_BYTES > 200_000,
    "the UI gate must admit real hardware reports above 200,000 bytes",
  );
  assert.doesNotThrow(() => assertGate0aReportSize(250 * 1024));
});

test("UI size gate rejects an intentionally oversized report", () => {
  assert.throws(() => assertGate0aReportSize(MAX_GATE0A_REPORT_BYTES + 1), /too large/);
});
