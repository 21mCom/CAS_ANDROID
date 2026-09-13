import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(workspaceRoot, "peer-review");
const archiveName = "CovertAlertSystem-peer-review-source.zip";
const archivePath = join(outputRoot, archiveName);
const stagingParent = mkdtempSync(join("/tmp", "cas-peer-review-"));
const packageRootName = "CovertAlertSystem-peer-review";
const stagingRoot = join(stagingParent, packageRootName);
const manifestPath = join(stagingRoot, "manifest.json");

const forbiddenPathPatterns = [
  /(^|\/)(?:node_modules|dist|build|\.gradle|\.git|\.local|\.cache|\.config)(?:\/|$)/,
  /(^|\/)(?:coverage|tmp|runtime|data|database|db-dump)(?:\/|$)/i,
  /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|sqlite|db|dump|log))(?:\/|$)/i,
  /(?:tsbuildinfo|package-lock\.json|yarn\.lock)$/i,
  /(^|\/)(?:\.replit-artifact)(?:\/|$)/,
];

const requiredSources = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".npmrc",
  "replit.md",
  "tsconfig.base.json",
  "tsconfig.json",
  "scripts/build-peer-review.mjs",
  "scripts/run-cas-contract-tests.mjs",
  "attached_assets/CovertAlertSystem_Pixel_MVP_Agentic_Handoff_1787405922227.md",
  "artifacts/api-server",
  "artifacts/covert-alert-system",
  "lib/api-spec",
  "lib/api-client-react",
  "lib/api-zod",
  "lib/db",
];

const requiredFiles = [
  "artifacts/covert-alert-system/public/gate0a-run-guide.pdf",
  "artifacts/covert-alert-system/scripts/generate-gate0a-guide-readable.mjs",
  "artifacts/covert-alert-system/android-test-package/README.md",
  "artifacts/covert-alert-system/android-test-package/scripts/measure-gate0a.sh",
  "artifacts/api-server/src/routes/cas.ts",
  "lib/api-spec/openapi.yaml",
  "lib/db/src/schema/cas.ts",
];

const apiSourcePreflightFiles = [
  "artifacts/api-server/src/routes/cas.ts",
  "artifacts/api-server/src/routes/cas.test.ts",
];

function archivePathFor(relativePath) {
  return relativePath.split(sep).join("/");
}

function isForbidden(relativePath) {
  return forbiddenPathPatterns.some((pattern) => pattern.test(archivePathFor(relativePath)));
}

function assertInsideWorkspace(sourcePath) {
  const resolved = resolve(sourcePath);
  const relativePath = relative(workspaceRoot, resolved);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error(`Refusing to package path outside workspace: ${sourcePath}`);
  }
}

function collectFiles(sourcePath, relativePrefix = relative(workspaceRoot, sourcePath)) {
  assertInsideWorkspace(sourcePath);
  const info = lstatSync(sourcePath);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to package symbolic link: ${relativePrefix}`);
  }
  if (info.isFile()) {
    if (!isForbidden(relativePrefix)) return [relativePrefix];
    return [];
  }
  if (!info.isDirectory()) {
    throw new Error(`Unsupported filesystem entry: ${relativePrefix}`);
  }

  const files = [];
  for (const entry of readdirSync(sourcePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const entryRelativePath = join(relativePrefix, entry.name);
    if (isForbidden(entryRelativePath)) continue;
    files.push(...collectFiles(join(sourcePath, entry.name), entryRelativePath));
  }
  return files;
}

function copyRelative(sourceRelativePath, destinationRelativePath = sourceRelativePath) {
  const sourcePath = join(workspaceRoot, sourceRelativePath);
  assertInsideWorkspace(sourcePath);
  if (!existsSync(sourcePath)) throw new Error(`Required source is missing: ${sourceRelativePath}`);
  const files = collectFiles(sourcePath, sourceRelativePath);
  for (const file of files) {
    const destinationPath = join(stagingRoot, destinationRelativePath, relative(sourceRelativePath, file));
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(join(workspaceRoot, file), destinationPath);
  }
  return files.length;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function runApiSourcePreflight() {
  for (const sourceFile of apiSourcePreflightFiles) {
    if (!existsSync(join(workspaceRoot, sourceFile))) {
      throw new Error(`API source preflight cannot read required source: ${sourceFile}`);
    }
  }

  const result = run("pnpm", [
    "exec",
    "tsc",
    "--noEmit",
    "--pretty",
    "false",
    "--incremental",
    "false",
    "--project",
    "artifacts/api-server/tsconfig.json",
  ]);
  if (result.status !== 0) {
    throw new Error(
      [
        "API source preflight failed: TypeScript syntax/type check",
        `Sources checked: ${apiSourcePreflightFiles.join(", ")}`,
        `Command: ${result.command}`,
        result.output || "(no diagnostics reported)",
      ].join("\n"),
    );
  }

  return {
    check: "TypeScript syntax/type check",
    command: result.command,
    outcome: "passed",
    files: apiSourcePreflightFiles,
  };
}

function assertRequiredFilesPresent(files) {
  const fileSet = new Set(files);
  for (const requiredFile of requiredFiles) {
    if (!fileSet.has(requiredFile)) {
      throw new Error(`Required Gate 0A/review file was excluded: ${requiredFile}`);
    }
  }
}

function writeReviewerReadme() {
  writeFileSync(
    join(stagingRoot, "README.md"),
    `# CovertAlertSystem peer-review source snapshot

This archive is a source snapshot for peer review of the CovertAlertSystem
web console, API, durable CAS contracts, and disposable Android Gate 0A
proxy-launch harness. It is **not** a production release, deployment bundle,
or proof of Gate 0A hardware validation.

## Product scope

CovertAlertSystem records readiness and feasibility evidence for a managed
Pixel deployment. The current review surface includes a React web console,
an Express/PostgreSQL API with durable incident and outbox records, generated
API contracts, and a local-only Android experiment that measures the
proxy-to-cover-app transition.

The native Gate 0A package deliberately has no SMS, network, location,
camera, microphone, evidence capture, recipient, or production covert
behavior. Imported reports remain **INCONCLUSIVE** until a person reviews the
physical observations.

## Source map

| Archive path | Review focus |
| --- | --- |
| \`source/package.json\`, \`source/pnpm-*.yaml\` | Workspace manifests and reproducible dependency graph |
| \`source/artifacts/api-server/\` | Express routes, Gate 0A import validation, durable CAS state, outbox worker, and tests |
| \`source/artifacts/covert-alert-system/\` | React/Vite console, gates/import UI, generated guide, and guide generator |
| \`source/lib/api-spec/\` | OpenAPI source of truth, including the CAS Gate 0A report contract |
| \`source/lib/api-client-react/\` | Generated React API client and types |
| \`source/lib/api-zod/\` | Generated Zod schemas and types |
| \`source/lib/db/\` | Drizzle/PostgreSQL schema and database package |
| \`source/artifacts/covert-alert-system/android-test-package/\` | Disposable Android harness, run notes, and ADB measurement script |
| \`source/attached_assets/\` | MVP handoff and product constraints |

## Quick start

Prerequisites:

- Node.js 24 and pnpm compatible with the lockfile.
- PostgreSQL with \`initdb\`, \`pg_ctl\`, and \`createdb\` on PATH. No
  credentials, database contents, or pre-existing database are needed for the
  contract checks.
- A normal web review can use the console and API in separate processes.

From the extracted archive root, enter the preserved workspace tree:

\`\`\`sh
cd source
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server run test
\`\`\`

To run the services in the workspace environment:

\`\`\`sh
PORT=5000 pnpm --filter @workspace/api-server run dev
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/covert-alert-system run dev
\`\`\`

The API serves under \`/api\`; the web console expects the API at the same
origin through the configured preview/proxy. The API contract command above
is isolated: it reserves a local port, creates a temporary PostgreSQL cluster
under the operating system temporary directory, creates the
\`cas_contract_test\` database, applies the Drizzle schema, and runs the Gate
0A import plus incident/outbox/concurrency checks with a local
\`DATABASE_URL\`. It does not read or mutate an inherited database URL.
The cluster is stopped and its temporary directory is removed in a
\`finally\` cleanup boundary after the test process exits. If PostgreSQL is
not installed, the command stops before running tests and reports the
prerequisite.

To regenerate the printable guide, use:

\`\`\`sh
pnpm --filter @workspace/covert-alert-system run generate:gate0a
\`\`\`

The generator uses headless Chromium. The checked-in PDF is the review
deliverable and should remain available if Chromium is not installed.

## Gate 0A hardware boundary

The native package is disposable and targets a pinned Google Pixel 8a,
stock Android, API 35. A physical run requires an approved hardware
workstation with JDK 17, Android SDK/API 35, Gradle, ADB, and an authorized
managed Pixel. An emulator, source inspection, or a screenshot cannot replace
the required launch, lock-screen, reboot, task, Recents, Back, and observer
evidence. Do not create synthetic reports or timing samples when the device
or SDK is unavailable.

Read \`artifacts/covert-alert-system/android-test-package/README.md\` and
\`attached_assets/CovertAlertSystem_Pixel_MVP_Agentic_Handoff_1787405922227.md\`
before any physical run. The printable checklist is
\`artifacts/covert-alert-system/public/gate0a-run-guide.pdf\`.

## Focused review checklist

1. Trace the Gate 0A report from the native JSON generator through
   \`source/lib/api-spec/openapi.yaml\`, API validation, and the console import
   path. Confirm malformed and unsafe reports are rejected and accepted
   reports remain inconclusive.
2. Review incident trigger idempotency, append-only event recording, and
   independent SMS/XMPP outbox rows in
   \`source/artifacts/api-server/src/routes/cas.ts\`.
3. Inspect the Drizzle schema for durable incident, event, outbox, setup, and
   gate evidence records in \`source/lib/db/src/schema/cas.ts\` without
   expecting database contents in this archive.
4. Review the native harness safety boundary and verify it does not claim
   production covert behavior or automatic pass results.
5. Confirm the web UI distinguishes sample data from measured physical
   evidence and prevents imported Gate 0A evidence from creating a GO result.
6. Run typecheck/build and the isolated API contract command with the required
   dependencies; record any environment-blocked result separately.

## Explicit exclusions

This source snapshot excludes dependency trees, build output, caches, VCS
metadata, local task/agent state, Replit artifact metadata, environment
files, keys/certificates, database files/dumps, logs, runtime data, and the
unrelated mockup Canvas artifact. It contains no credentials, API keys,
session values, or database contents.
`,
  );
}

function redactValidationOutput(output) {
  return output
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s'"]+/gi, "postgresql://[redacted]")
    .replace(/DATABASE_URL\s*=\s*[^\s'"]+/gi, "DATABASE_URL=[redacted]");
}

function runValidation() {
  return [
    run("pnpm", ["run", "typecheck"]),
    run("pnpm", ["run", "build"]),
    run("pnpm", ["--filter", "@workspace/api-server", "run", "test"]),
  ].map((result) => ({
    command: result.command,
    exitCode: result.status,
    outcome: result.status === 0 ? "passed" : "blocked",
    outputTail: redactValidationOutput(result.output).split("\n").slice(-24).join("\n"),
  }));
}

function writeValidationRecord(commands, sourcePreflight) {
  const validation = {
    note: "These are package-time commands run against the source workspace; no database contents or credentials are included.",
    sourcePreflight,
    commands,
    archiveChecks: "passed by this packaging command: stable listing, forbidden-path scan, extraction, and manifest checksum comparison",
    physicalValidation: "Not run. Gate 0A requires the approved Pixel 8a hardware workstation and authorized ADB device.",
  };
  writeFileSync(join(stagingRoot, "validation.json"), `${JSON.stringify(validation, null, 2)}\n`);
}

function buildManifest(files) {
  const entries = files
    .map((sourceRelativePath) => {
      const packageRelativePath = sourceRelativePath;
      const packagePath = join(stagingRoot, packageRelativePath);
      return {
        path: archivePathFor(packageRelativePath),
        bytes: statSync(packagePath).size,
        sha256: sha256(packagePath),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    snapshot: "CovertAlertSystem-peer-review-source",
    archive: archiveName,
    root: packageRootName,
    generatedAt: process.env.SOURCE_DATE_EPOCH
      ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
      : null,
    includedCategories: [
      "workspace metadata",
      "API server",
      "web console",
      "OpenAPI and generated API contracts",
      "Drizzle database schema",
      "native Android Gate 0A harness",
      "MVP handoff documentation",
      "review README and validation record",
    ],
    excludedCategories: [
      "node_modules and dependency directories",
      "dist, build, coverage, caches, and generated runtime output",
      ".git, .local, .agents, and Replit artifact metadata",
      "environment files, credentials, keys, certificates, logs, and database contents",
      "unrelated Canvas/mockup preview artifact",
    ],
    checksumScope: "Every packaged file except manifest.json; manifest.json is the inventory that describes this scope.",
    files: entries,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function createArchive() {
  mkdirSync(outputRoot, { recursive: true });
  rmSync(archivePath, { force: true });
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolutePath);
      else files.push(relative(stagingParent, absolutePath));
    }
  }
  walk(stagingRoot);
  files.sort((a, b) => archivePathFor(a).localeCompare(archivePathFor(b)));
  const result = spawnSync("zip", ["-X", "-q", archivePath, "-@"], {
    cwd: stagingParent,
    input: `${files.join("\n")}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr || result.stdout}`);
  }
}

function validateArchive(manifestFiles) {
  const list = spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
  if (list.status !== 0) throw new Error(`Unable to list archive: ${list.stderr}`);
  const archiveEntries = list.stdout.trim().split("\n").filter(Boolean);
  const forbiddenArchiveEntry = archiveEntries.find((entry) =>
    entry.includes("..") || isForbidden(entry) || entry.startsWith("/") || entry.includes("\\"),
  );
  if (forbiddenArchiveEntry) throw new Error(`Forbidden archive path: ${forbiddenArchiveEntry}`);
  const expectedPrefix = `${packageRootName}/`;
  if (!archiveEntries.every((entry) => entry.startsWith(expectedPrefix))) {
    throw new Error("Archive contains an entry outside the expected top-level package directory");
  }
  const expectedEntries = new Set([
    ...manifestFiles.map((file) => `${packageRootName}/${archivePathFor(file)}`),
    `${packageRootName}/manifest.json`,
  ]);
  const actualEntries = new Set(archiveEntries);
  for (const expected of expectedEntries) {
    if (!actualEntries.has(expected)) throw new Error(`Archive is missing ${expected}`);
  }
  if (actualEntries.size !== expectedEntries.size) {
    throw new Error("Archive contains an unexpected file not described by the manifest");
  }

  const extractParent = mkdtempSync(join("/tmp", "cas-peer-review-extract-"));
  const extract = spawnSync("unzip", ["-q", archivePath, "-d", extractParent], { encoding: "utf8" });
  if (extract.status !== 0) throw new Error(`Unable to extract archive: ${extract.stderr}`);
  try {
    for (const file of manifestFiles) {
      const extractedPath = join(extractParent, packageRootName, file);
      if (sha256(extractedPath) !== sha256(join(stagingRoot, file))) {
        throw new Error(`Checksum mismatch after extraction: ${file}`);
      }
    }
  } finally {
    rmSync(extractParent, { recursive: true, force: true });
  }
}

function writeHandoffNote(fileCount) {
  writeFileSync(
    join(outputRoot, "HANDOFF.md"),
    `# CovertAlertSystem peer-review handoff

Archive: \`${archiveName}\`

This is a source snapshot for peer review only. It is not a production release,
deployment artifact, database backup, or Gate 0A hardware-validation result.

The archive contains ${fileCount} files: the preserved source workspace, review
README, manifest, and validation record. It intentionally excludes
dependencies, build output, caches, local task state, VCS metadata, secrets,
database contents, and the unrelated Canvas artifact.

Gate 0A remains a physical Pixel 8a / stock Android / API 35 experiment. The
included PDF and native harness document the run; they do not claim that the
experiment was performed in a normal workspace.
`,
  );
}

function main() {
  try {
    rmSync(stagingRoot, { recursive: true, force: true });
    mkdirSync(stagingRoot, { recursive: true });
    const copiedFiles = [];
    for (const source of requiredSources) {
      copiedFiles.push(...collectFiles(join(workspaceRoot, source), source));
    }
    assertRequiredFilesPresent(copiedFiles);

    const mappedSources = new Map([
      ["package.json", "source/package.json"],
      ["pnpm-workspace.yaml", "source/pnpm-workspace.yaml"],
      ["pnpm-lock.yaml", "source/pnpm-lock.yaml"],
      [".npmrc", "source/.npmrc"],
      ["replit.md", "source/replit.md"],
      ["tsconfig.base.json", "source/tsconfig.base.json"],
      ["tsconfig.json", "source/tsconfig.json"],
      ["scripts/build-peer-review.mjs", "source/scripts/build-peer-review.mjs"],
      ["scripts/run-cas-contract-tests.mjs", "source/scripts/run-cas-contract-tests.mjs"],
      ["attached_assets/CovertAlertSystem_Pixel_MVP_Agentic_Handoff_1787405922227.md", "source/attached_assets/CovertAlertSystem_Pixel_MVP_Agentic_Handoff_1787405922227.md"],
      ["artifacts/api-server", "source/artifacts/api-server"],
      ["artifacts/covert-alert-system", "source/artifacts/covert-alert-system"],
      ["lib/api-spec", "source/lib/api-spec"],
      ["lib/api-client-react", "source/lib/api-client-react"],
      ["lib/api-zod", "source/lib/api-zod"],
      ["lib/db", "source/lib/db"],
    ]);
    const packageFiles = [];
    for (const [source, destination] of mappedSources) {
      const files = collectFiles(join(workspaceRoot, source), source);
      for (const file of files) {
        const destinationFile = join(destination, relative(source, file));
        mkdirSync(dirname(join(stagingRoot, destinationFile)), { recursive: true });
        cpSync(join(workspaceRoot, file), join(stagingRoot, destinationFile));
        packageFiles.push(destinationFile);
      }
    }
    assertRequiredFilesPresent(copiedFiles);
    if (!packageFiles.some((file) => file === "source/artifacts/covert-alert-system/public/gate0a-run-guide.pdf")) {
      throw new Error("Gate 0A PDF deliverable is unavailable; refusing incomplete package");
    }
    const sourcePreflight = runApiSourcePreflight();
    writeReviewerReadme();
    const validation = runValidation();
    writeValidationRecord(validation, sourcePreflight);
    packageFiles.push("README.md", "validation.json");
    buildManifest(packageFiles);
    createArchive();
    validateArchive(packageFiles);
    writeHandoffNote(packageFiles.length + 1);
    console.log(`Created ${archivePath}`);
    console.log(`Packaged ${packageFiles.length + 1} files; archive validation passed.`);
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

main();