import { createServer } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    env: options.env,
  });

  if (result.error) {
    throw new Error(
      `Unable to run ${command}: ${result.error.message}. ` +
      "Install PostgreSQL and ensure initdb, pg_ctl, and createdb are on PATH.",
    );
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
  return result;
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve a local port for the disposable PostgreSQL server");
  }
  const port = address.port;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

export async function runWithDisposableReviewDatabase(runContractCommand, {
  baseEnvironment = process.env,
} = {}) {
  const postgresDataDirectory = mkdtempSync(join(tmpdir(), "cas-contract-pg-"));
  const postgresSocketDirectory = join(postgresDataDirectory, "socket");
  const databaseName = "cas_contract_test";
  const databaseRole = "cas_contract_runner";
  let postgresStarted = false;

  function stopPostgres() {
    if (!postgresStarted) return;
    try {
      run("pg_ctl", [
        "-D",
        postgresDataDirectory,
        "-m",
        "immediate",
        "-w",
        "stop",
      ], { stdio: "ignore" });
    } catch {
      // Cleanup must continue even if PostgreSQL already stopped.
    } finally {
      postgresStarted = false;
    }
  }

  const cleanup = () => {
    stopPostgres();
    rmSync(postgresDataDirectory, { recursive: true, force: true });
  };
  const handleSigint = () => {
    cleanup();
    process.exit(130);
  };
  const handleSigterm = () => {
    cleanup();
    process.exit(143);
  };

  process.once("exit", cleanup);
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    const port = await findAvailablePort();
    const databaseUrl = `postgresql://${databaseRole}@127.0.0.1:${port}/${databaseName}`;
    const environment = {
      ...baseEnvironment,
      DATABASE_URL: databaseUrl,
    };

    run("initdb", [
      "--no-locale",
      "--encoding=UTF8",
      "--auth=trust",
      "--username",
      databaseRole,
      "-D",
      postgresDataDirectory,
    ]);
    mkdirSync(postgresSocketDirectory);
    run("pg_ctl", [
      "-D",
      postgresDataDirectory,
      "-o",
      `-h 127.0.0.1 -k ${postgresSocketDirectory} -p ${port}`,
      "-w",
      "start",
    ]);
    postgresStarted = true;
    run("createdb", [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      databaseRole,
      databaseName,
    ]);

    const postmasterPid = Number(
      readFileSync(join(postgresDataDirectory, "postmaster.pid"), "utf8")
        .split("\n", 1)[0],
    );
    if (!Number.isInteger(postmasterPid) || postmasterPid <= 0) {
      throw new Error("Unable to identify the disposable PostgreSQL server process");
    }

    return await runContractCommand({
      databaseName,
      databaseRole,
      databaseUrl,
      dataDirectory: postgresDataDirectory,
      postmasterPid,
      port,
      socketDirectory: postgresSocketDirectory,
      environment,
      run: (command, args, options = {}) => run(command, args, {
        ...options,
        env: options.env ?? environment,
      }),
    });
  } finally {
    cleanup();
    process.removeListener("exit", cleanup);
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
  }
}