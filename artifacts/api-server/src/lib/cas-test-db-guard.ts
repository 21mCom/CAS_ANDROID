/**
 * Boot-time guard for DB-touching test suites: prove the suite is running
 * against the disposable review database, never the workspace dev database.
 *
 * Why this exists: in 2026-09 an automated integration suite ran with the
 * dev DATABASE_URL and wiped live incident rows mid-run (and, with live
 * SMTP secrets also in the environment, emailed real responders). The
 * contract runner (scripts/run-cas-contract-tests.mjs via
 * scripts/disposable-review-database.mjs) already provisions a throwaway
 * cluster; this guard makes the suite FAIL LOUDLY at boot unless it can
 * prove that cluster is what DATABASE_URL points at, so a direct
 * `tsx --test` run against the dev database stops at the first line instead
 * of after the damage.
 *
 * The runner sets three markers alongside the disposable DATABASE_URL, and
 * ALL of them are mandatory — a missing marker fails closed, never open:
 *   CAS_TEST_DISPOSABLE_DB=1                      harness marker
 *   CAS_TEST_EXPECTED_DATABASE_NAME=<name>        the disposable cluster's db
 *   CAS_TEST_FORBIDDEN_DATABASE_URL=<url>         the dev URL it replaced
 *   (empty string when the base environment had no DATABASE_URL at all)
 * A suite asserts all three agree before running a single test.
 */
export function assertDisposableTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const problems: string[] = [];

  if (env.CAS_TEST_DISPOSABLE_DB !== "1") {
    problems.push(
      "CAS_TEST_DISPOSABLE_DB is not '1' — this suite only runs under the disposable-database contract runner.",
    );
  }

  // The harness flag alone proves nothing: anyone can set it. The suite must
  // also see the runner's description of the disposable target and validate
  // DATABASE_URL against it, so a hand-assembled environment with the flag
  // set but the dev DATABASE_URL still in place cannot boot.
  const expectedName = env.CAS_TEST_EXPECTED_DATABASE_NAME;
  if (!expectedName) {
    problems.push(
      "CAS_TEST_EXPECTED_DATABASE_NAME is not set — the contract runner always names the disposable database; without it the suite cannot prove what DATABASE_URL should point at.",
    );
  }
  const forbidden = env.CAS_TEST_FORBIDDEN_DATABASE_URL;
  if (forbidden === undefined) {
    problems.push(
      "CAS_TEST_FORBIDDEN_DATABASE_URL is not set — the contract runner always records the dev URL it replaced (empty string when there was none); without it the suite cannot prove the dev URL was replaced.",
    );
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    problems.push("DATABASE_URL is not set.");
  } else {
    let actualName: string | undefined;
    try {
      actualName = new URL(databaseUrl).pathname.replace(/^\//, "");
    } catch {
      problems.push("DATABASE_URL is not a parseable URL.");
    }
    if (
      expectedName &&
      actualName !== undefined &&
      actualName !== expectedName
    ) {
      problems.push(
        `DATABASE_URL database is "${actualName}", expected the disposable "${expectedName}".`,
      );
    }
    if (forbidden !== undefined && forbidden !== "" && databaseUrl === forbidden) {
      problems.push(
        "DATABASE_URL still equals the workspace dev database URL the runner was supposed to replace.",
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      "CAS test suite refused to boot: it writes to whatever DATABASE_URL " +
        "points at, so it must run against the disposable review database, " +
        "never the dev database.\n  - " +
        problems.join("\n  - ") +
        "\nRun the suites through the contract runner instead: " +
        "`pnpm --filter @workspace/api-server run test`.",
    );
  }
}
