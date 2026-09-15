/**
 * Validates a Gate 0A report.json with the exact rules the web app applies on
 * import (POST /api/cas/gate0a/import -> validateGate0aImport).
 *
 * Usage: tsx scripts/validate-gate0a-report.ts <path-to-report.json>
 * Exits 0 when the app would accept the report, 1 otherwise.
 *
 * CI runs this against the measure-gate0a.sh --report-self-test output so a
 * harness/app schema drift fails before a field operator hits it on import.
 */
import { readFile } from "node:fs/promises";
import { validateGate0aImport } from "../src/lib/gate0a-report";

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("Usage: tsx scripts/validate-gate0a-report.ts <path-to-report.json>");
  process.exit(2);
}

const text = await readFile(reportPath, "utf-8").catch((error: unknown) => {
  console.error(`Cannot read report: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});

let report: unknown;
try {
  report = JSON.parse(text);
} catch {
  console.error(`REJECTED: ${reportPath} is not valid JSON.`);
  process.exit(1);
}

const result = validateGate0aImport(report);
if (!result.ok) {
  console.error(`REJECTED: ${result.error}`);
  console.error("The CovertAlertSystem web app would refuse to import this Gate 0A report.");
  process.exit(1);
}

console.log(
  `ACCEPTED: ${result.report.schema} (evidenceClass=${result.report.evidenceClass}, ` +
  `status=${result.report.status}, preflight=${result.report.preflight.status}, ` +
  `events=${result.report.events.length}) passes the app's import validation.`,
);
