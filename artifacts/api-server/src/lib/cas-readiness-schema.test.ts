/**
 * Console/API readiness-payload parity test.
 *
 * The first-time-setup bootstrap bug existed because nothing tied the
 * console's Gate/SetupItem payload types and its initialGates/initialSetup
 * seed fixtures (artifacts/covert-alert-system/src/hooks/use-field-test.tsx)
 * to the API route schemas, so the two sides drifted silently for weeks.
 *
 * This test parses the console hook with the TypeScript compiler and fails
 * CI when either side changes without the other:
 *  - the Gate/SetupItem type fields must exactly match the schema keys
 *    (including keys the route would silently strip),
 *  - the status/mode union members must match the schema enums,
 *  - the actual initialGates/initialSetup fixtures must validate,
 *  - the console's PATCH /cas/setup/:id and PATCH /cas/gates/:id payload
 *    keys must match the shared patch schemas.
 *
 * This test needs no database; it only reads the console source file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  bootstrapGateSchema,
  bootstrapSchema,
  bootstrapSetupSchema,
  gatePatchSchema,
  setupPatchSchema,
} from "./cas-readiness-schema";

const consoleHookPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../covert-alert-system/src/hooks/use-field-test.tsx",
);
const consoleSource = readFileSync(consoleHookPath, "utf8");
const sourceFile = ts.createSourceFile(
  consoleHookPath,
  consoleSource,
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.TSX,
);

function fail(message: string): never {
  assert.fail(`${message} (console source: ${consoleHookPath})`);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** Field names declared on an exported `type X = { ... }` literal. */
function typeFieldNames(typeName: string): string[] {
  const alias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  );
  if (!alias) fail(`exported type ${typeName} not found`);
  if (!ts.isTypeLiteralNode(alias.type)) {
    fail(`type ${typeName} is no longer an object literal type`);
  }
  return alias.type.members.map((member) => {
    if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name)) {
      fail(`type ${typeName} has a member this test cannot read`);
    }
    if (member.questionToken) {
      fail(`type ${typeName} field ${member.name.text} became optional; the bootstrap schema has no optional fields to mirror it`);
    }
    return member.name.text;
  });
}

/** String literals of a `'a' | 'b'` union type node. */
function unionLiterals(node: ts.TypeNode, context: string): string[] {
  if (!ts.isUnionTypeNode(node)) fail(`${context} is no longer a union of string literals`);
  return node.types.map((member) => {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      fail(`${context} contains a non-literal member`);
    }
    return member.literal.text;
  });
}

/** Evaluate a `const x = [...]` literal from the console source. */
function evaluateLiteral(variableName: string): Record<string, unknown>[] {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!initializer) fail(`const ${variableName} not found`);
  // Transpile first so harmless TS-only syntax (e.g. `satisfies`) cannot
  // break evaluation; the fixtures themselves are plain data.
  const js = ts
    .transpileModule(initializer.getText(sourceFile), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    })
    .outputText.trim()
    .replace(/;$/, "");
  const value: unknown = new Function(`return (${js});`)();
  if (!Array.isArray(value) || value.length === 0) {
    fail(`const ${variableName} is no longer a non-empty array literal`);
  }
  return value as Record<string, unknown>[];
}

/**
 * Keys of the object literal the console passes to JSON.stringify in the
 * casAuthedFetch call whose URL contains `urlFragment` (e.g. "/cas/setup/").
 */
function fetchPayloadKeys(urlFragment: string): string[] {
  let keys: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sourceFile) === "casAuthedFetch" &&
      node.arguments.length >= 1 &&
      node.arguments[0].getText(sourceFile).includes(urlFragment)
    ) {
      const init = node.arguments[1];
      if (!init || !ts.isObjectLiteralExpression(init)) {
        fail(`the ${urlFragment} fetch no longer takes an options object`);
      }
      const body = init.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === "body",
      );
      if (
        !body ||
        !ts.isCallExpression(body.initializer) ||
        body.initializer.expression.getText(sourceFile) !== "JSON.stringify" ||
        body.initializer.arguments.length !== 1 ||
        !ts.isObjectLiteralExpression(body.initializer.arguments[0])
      ) {
        fail(`the ${urlFragment} fetch no longer sends a JSON.stringify object literal`);
      }
      keys = body.initializer.arguments[0].properties.map((property) => {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
          fail(`the ${urlFragment} payload has a member this test cannot read`);
        }
        return property.name.getText(sourceFile);
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!keys) fail(`no casAuthedFetch call to ${urlFragment} found`);
  return keys;
}

test("console Gate type fields match the bootstrap gate schema keys exactly", () => {
  assert.deepEqual(
    sorted(typeFieldNames("Gate")),
    sorted(Object.keys(bootstrapGateSchema.shape)),
    "console Gate type and bootstrapGateSchema disagree; change both sides together (lib/cas-readiness-schema.ts and use-field-test.tsx)",
  );
});

test("console SetupItem type fields match the bootstrap setup schema keys exactly", () => {
  assert.deepEqual(
    sorted(typeFieldNames("SetupItem")),
    sorted(Object.keys(bootstrapSetupSchema.shape)),
    "console SetupItem type and bootstrapSetupSchema disagree; change both sides together",
  );
});

test("console GateStatus union matches the schema status enums", () => {
  const alias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "GateStatus",
  );
  if (!alias) fail("exported type GateStatus not found");
  const expected = sorted(bootstrapGateSchema.shape.status.options);
  assert.deepEqual(
    sorted(unionLiterals(alias.type, "GateStatus")),
    expected,
    "console GateStatus and the bootstrap gate status enum disagree",
  );
  assert.deepEqual(
    sorted(gatePatchSchema.shape.status.options),
    expected,
    "the gate PATCH status enum and the bootstrap gate status enum disagree",
  );
});

test("console SetupItem mode union matches the bootstrap setup mode enum", () => {
  const alias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "SetupItem",
  );
  if (!alias || !ts.isTypeLiteralNode(alias.type)) fail("SetupItem type not readable");
  const mode = alias.type.members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && member.name.getText(sourceFile) === "mode",
  );
  if (!mode || !mode.type) fail("SetupItem.mode not found");
  assert.deepEqual(
    sorted(unionLiterals(mode.type, "SetupItem.mode")),
    sorted(bootstrapSetupSchema.shape.mode.options),
    "console SetupItem mode and the bootstrap setup mode enum disagree",
  );
});

test("console initialGates fixtures validate against the bootstrap gate schema with exact key parity", () => {
  const schemaKeys = sorted(Object.keys(bootstrapGateSchema.shape));
  for (const gate of evaluateLiteral("initialGates")) {
    const parsed = bootstrapGateSchema.safeParse(gate);
    assert.ok(
      parsed.success,
      `initialGates entry ${JSON.stringify(gate.id)} fails bootstrapGateSchema: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`,
    );
    // Zod strips unknown keys, so a field the console added but the schema
    // does not know would otherwise be dropped silently at seed time.
    assert.deepEqual(
      sorted(Object.keys(gate)),
      schemaKeys,
      `initialGates entry ${JSON.stringify(gate.id)} has keys the bootstrap gate schema would not accept verbatim`,
    );
  }
});

test("console initialSetup fixtures validate against the bootstrap setup schema with exact key parity", () => {
  const schemaKeys = sorted(Object.keys(bootstrapSetupSchema.shape));
  for (const item of evaluateLiteral("initialSetup")) {
    const parsed = bootstrapSetupSchema.safeParse(item);
    assert.ok(
      parsed.success,
      `initialSetup entry ${JSON.stringify(item.id)} fails bootstrapSetupSchema: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`,
    );
    assert.deepEqual(
      sorted(Object.keys(item)),
      schemaKeys,
      `initialSetup entry ${JSON.stringify(item.id)} has keys the bootstrap setup schema would not accept verbatim`,
    );
  }
});

test("console bootstrap POST payload keys match the bootstrap schema", () => {
  assert.deepEqual(
    sorted(fetchPayloadKeys("/cas/bootstrap")),
    sorted(Object.keys(bootstrapSchema.shape)),
    "console bootstrap POST body and bootstrapSchema disagree",
  );
});

test("console PATCH /cas/setup/:id payload keys match the shared setup patch schema", () => {
  assert.deepEqual(
    sorted(fetchPayloadKeys("/cas/setup/")),
    sorted(Object.keys(setupPatchSchema.shape)),
    "console toggleSetupItem payload and setupPatchSchema disagree",
  );
});

test("console PATCH /cas/gates/:id payload keys match the shared gate patch schema", () => {
  assert.deepEqual(
    sorted(fetchPayloadKeys("/cas/gates/")),
    sorted(Object.keys(gatePatchSchema.shape)),
    "console updateGateStatus payload and gatePatchSchema disagree",
  );
});
