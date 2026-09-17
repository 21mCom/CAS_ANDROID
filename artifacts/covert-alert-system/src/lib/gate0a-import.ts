// Single source for the Gate 0A import size gate. Must stay aligned with the
// API's 512kb JSON body limit (artifacts/api-server/src/app.ts): the documented
// Pixel 11 hardware run produces a ~250 KB report (219 events), so the bound
// must admit it while staying finite.
export const MAX_GATE0A_REPORT_BYTES = 512 * 1024;

export function assertGate0aReportSize(sizeBytes: number): void {
  if (sizeBytes > MAX_GATE0A_REPORT_BYTES) {
    throw new Error('The report is too large to import safely (over 512 KB).');
  }
}
