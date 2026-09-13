import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { runWithDisposableReviewDatabase } from "./disposable-review-database.mjs";

async function assertCleanup(label, runContractCommand, expectedFailure = false) {
  let runContext;
  let failure;
  try {
    await runWithDisposableReviewDatabase((context) => {
      runContext = context;
      return runContractCommand(context);
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(runContext, `${label}: disposable database setup did not complete`);
  assert.equal(
    existsSync(runContext.dataDirectory),
    false,
    `${label}: temporary PostgreSQL cluster directory still exists`,
  );

  let processStillRunning = false;
  try {
    process.kill(runContext.postmasterPid, 0);
    processStillRunning = true;
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  assert.equal(
    processStillRunning,
    false,
    `${label}: temporary PostgreSQL process still exists`,
  );

  if (expectedFailure) {
    assert.match(
      failure?.message ?? "",
      /exited with status 23/,
      `${label}: expected the contract command to fail`,
    );
  } else if (failure) {
    throw failure;
  }
}

await assertCleanup("successful contract setup", ({ run, databaseName, databaseRole, port }) => {
  run("psql", [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    databaseRole,
    "-d",
    databaseName,
    "-c",
    "SELECT 1;",
  ], { stdio: "ignore" });
});

await assertCleanup(
  "failing contract command",
  ({ run }) => run(process.execPath, ["-e", "process.exit(23)"], { stdio: "ignore" }),
  true,
);

console.log("Review-database cleanup smoke check passed for success and failure runs.");