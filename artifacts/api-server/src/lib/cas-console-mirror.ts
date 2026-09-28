/**
 * Loads the console's response mirror schemas
 * (artifacts/covert-alert-system/src/lib/cas-outbox-status-schema.ts and
 * cas-config-schema.ts) into this test process.
 *
 * The parity test (cas-outbox-config-schema.test.ts) pins the field NAMES of
 * the outbox-status and config responses statically. That cannot catch a
 * same-key type or nullability change (e.g. deviceAuthConfigured turning
 * from boolean to string), so the route tests call these parsers against the
 * live JSON: the console's own zod schemas become the validator, which means
 * type drift on either side fails the same CI gate instead of an operator's
 * console.
 *
 * The console sources import each other through the Vite `@/` alias, which
 * this package cannot resolve, so the loader transpiles the schema modules
 * with the TypeScript compiler (type-only imports drop out), rewrites the
 * alias to a relative specifier, and imports the result from a scratch
 * directory inside this package's node_modules so the bare `zod` specifier
 * still resolves.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const consoleLibDir = path.resolve(libDir, "../../../covert-alert-system/src/lib");

function transpileConsoleModule(fileName: string): string {
  const source = readFileSync(path.join(consoleLibDir, fileName), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    fileName,
  }).outputText;
  const rewritten = js.replace(
    /from\s+["']@\/lib\/cas-state-schema["']/g,
    'from "./cas-state-schema.mjs"',
  );
  if (fileName !== "cas-state-schema.ts" && rewritten.includes('from "@/')) {
    throw new Error(
      `${fileName} gained a runtime "@/..." import this loader cannot resolve; extend the rewrite or keep the mirror schemas self-contained`,
    );
  }
  return rewritten;
}

export interface ConsoleMirrors {
  parseCasOutboxStatusResponse: (body: unknown) => void;
  parseCasRespondersResponse: (body: unknown) => void;
  parseCasTemplatesResponse: (body: unknown) => void;
  parseCasTemplateInfo: (body: unknown) => void;
  parseCasTemplatePreviewResult: (body: unknown) => void;
}

let cached: Promise<ConsoleMirrors> | undefined;

/** Imports the console mirror parsers once per test process. */
export function loadConsoleMirrors(): Promise<ConsoleMirrors> {
  cached ??= (async () => {
    const scratchRoot = path.resolve(libDir, "../node_modules/.tmp");
    mkdirSync(scratchRoot, { recursive: true });
    const scratchDir = mkdtempSync(path.join(scratchRoot, "cas-console-mirror-"));
    process.once("exit", () => rmSync(scratchDir, { recursive: true, force: true }));
    for (const name of ["cas-state-schema", "cas-outbox-status-schema", "cas-config-schema"]) {
      writeFileSync(path.join(scratchDir, `${name}.mjs`), transpileConsoleModule(`${name}.ts`));
    }
    const outbox: Record<string, unknown> = await import(
      pathToFileURL(path.join(scratchDir, "cas-outbox-status-schema.mjs")).href
    );
    const config: Record<string, unknown> = await import(
      pathToFileURL(path.join(scratchDir, "cas-config-schema.mjs")).href
    );
    return {
      parseCasOutboxStatusResponse: outbox.parseCasOutboxStatusResponse as ConsoleMirrors["parseCasOutboxStatusResponse"],
      parseCasRespondersResponse: config.parseCasRespondersResponse as ConsoleMirrors["parseCasRespondersResponse"],
      parseCasTemplatesResponse: config.parseCasTemplatesResponse as ConsoleMirrors["parseCasTemplatesResponse"],
      parseCasTemplateInfo: config.parseCasTemplateInfo as ConsoleMirrors["parseCasTemplateInfo"],
      parseCasTemplatePreviewResult: config.parseCasTemplatePreviewResult as ConsoleMirrors["parseCasTemplatePreviewResult"],
    };
  })();
  return cached;
}
