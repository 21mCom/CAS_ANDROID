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
  activeIncidentSchema,
  bootstrapGateSchema,
  bootstrapSchema,
  bootstrapSetupSchema,
  casPrioritySchema,
  casStateResponseSchema,
  gatePatchSchema,
  incidentDetailResponseSchema,
  incidentDetailSummarySchema,
  incidentLocationSchema,
  kernelEventSchema,
  kernelStatusSchema,
  outboxItemSchema,
  setupPatchSchema,
  stateGateSchema,
  stateIncidentRowSchema,
  stateSetupSchema,
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

/** The declared type node of one property on an object-literal type alias. */
function propertyTypeNode(typeName: string, fieldName: string): ts.TypeNode {
  const alias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  );
  if (!alias || !ts.isTypeLiteralNode(alias.type)) fail(`${typeName} type not readable`);
  const member = alias.type.members.find(
    (entry): entry is ts.PropertySignature =>
      ts.isPropertySignature(entry) && entry.name.getText(sourceFile) === fieldName,
  );
  if (!member || !member.type) fail(`${typeName}.${fieldName} not found`);
  return member.type;
}

/** String literals of a union-typed property on a console type. */
function propertyUnionLiterals(typeName: string, fieldName: string): string[] {
  return unionLiterals(propertyTypeNode(typeName, fieldName), `${typeName}.${fieldName}`);
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

// --- Read direction: GET /cas/state response vs. the console's types ---
//
// The console blind-casts the state response
// (`await response.json() as Omit<FieldTestState, 'fieldRun'>`), so these
// tests pin the shared response schemas (casStateResponseSchema and its
// members) to the console's type declarations. The route contract test in
// routes/cas.test.ts pins the live JSON to the same schemas; changing
// either side without the other turns a check red.

test("console FieldTestState server-fed fields match the state response schema keys", () => {
  // fieldRun is console-local state the server never returns.
  const serverFed = typeFieldNames("FieldTestState").filter((name) => name !== "fieldRun");
  assert.deepEqual(
    sorted(serverFed),
    sorted(Object.keys(casStateResponseSchema.shape)),
    "console FieldTestState and casStateResponseSchema disagree; change both sides together (lib/cas-readiness-schema.ts and use-field-test.tsx)",
  );
});

test("state gate/setup response schemas serialize exactly the bootstrap fields", () => {
  assert.deepEqual(
    sorted(Object.keys(stateGateSchema.shape)),
    sorted(Object.keys(bootstrapGateSchema.shape)),
    "the state gate response schema and the bootstrap gate schema disagree",
  );
  assert.deepEqual(
    sorted(Object.keys(stateSetupSchema.shape)),
    sorted(Object.keys(bootstrapSetupSchema.shape)),
    "the state setup response schema and the bootstrap setup schema disagree",
  );
});

test("console Incident type fields match the state incident row schema keys exactly", () => {
  assert.deepEqual(
    sorted(typeFieldNames("Incident")),
    sorted(Object.keys(stateIncidentRowSchema.shape)),
    "console Incident type and stateIncidentRowSchema disagree; change both sides together",
  );
});

test("console ActiveIncident type fields match the active incident schema keys exactly", () => {
  assert.deepEqual(
    sorted(typeFieldNames("ActiveIncident")),
    sorted(Object.keys(activeIncidentSchema.shape)),
    "console ActiveIncident type and activeIncidentSchema disagree; change both sides together",
  );
});

test("console KernelEvent type fields match the kernel event schema keys exactly", () => {
  assert.deepEqual(
    sorted(typeFieldNames("KernelEvent")),
    sorted(Object.keys(kernelEventSchema.shape)),
    "console KernelEvent type and kernelEventSchema disagree; change both sides together",
  );
});

test("console OutboxItem type fields match the outbox item schema keys exactly", () => {
  assert.deepEqual(
    sorted(typeFieldNames("OutboxItem")),
    sorted(Object.keys(outboxItemSchema.shape)),
    "console OutboxItem type and outboxItemSchema disagree; change both sides together",
  );
});

test("console IncidentLocation type fields match the incident location schema keys exactly", () => {
  assert.deepEqual(
    sorted(typeFieldNames("IncidentLocation")),
    sorted(Object.keys(incidentLocationSchema.shape)),
    "console IncidentLocation type and incidentLocationSchema disagree; change both sides together",
  );
});

test("console Priority union matches the state priority enum", () => {
  const alias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "Priority",
  );
  if (!alias) fail("exported type Priority not found");
  assert.deepEqual(
    sorted(unionLiterals(alias.type, "Priority")),
    sorted(casPrioritySchema.options),
    "console Priority and the state priority enum disagree",
  );
});

test("console KernelStatus union matches the kernel status enum", () => {
  const alias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "KernelStatus",
  );
  if (!alias) fail("exported type KernelStatus not found");
  assert.deepEqual(
    sorted(unionLiterals(alias.type, "KernelStatus")),
    sorted(kernelStatusSchema.options),
    "console KernelStatus and the kernel status enum disagree",
  );
});

test("console OutboxItem transport/state/priority unions match the outbox item schema enums", () => {
  assert.deepEqual(
    sorted(propertyUnionLiterals("OutboxItem", "transport")),
    sorted(outboxItemSchema.shape.transport.options),
    "console OutboxItem transport and the outbox item transport enum disagree",
  );
  assert.deepEqual(
    sorted(propertyUnionLiterals("OutboxItem", "state")),
    sorted(outboxItemSchema.shape.state.options),
    "console OutboxItem state and the outbox item state enum disagree",
  );
  assert.deepEqual(
    sorted(propertyUnionLiterals("OutboxItem", "priority")),
    sorted(outboxItemSchema.shape.priority.options),
    "console OutboxItem priority and the outbox item priority enum disagree",
  );
});

// --- Per-incident evidence detail: GET /cas/incidents/:id/evidence ---
//
// The console's IncidentDetail/IncidentDetailSummary types are pinned to
// the response schemas the same way as the state payload above; the route
// test in routes/cas-evidence.test.ts additionally runs the live JSON
// through the console's own parser.

test("console IncidentDetail type fields match the incident detail response schema keys exactly", () => {
  assert.deepEqual(
    sorted(typeFieldNames("IncidentDetail")),
    sorted(Object.keys(incidentDetailResponseSchema.shape)),
    "console IncidentDetail and incidentDetailResponseSchema disagree; change both sides together (lib/cas-readiness-schema.ts and use-field-test.tsx)",
  );
});

test("console IncidentDetailSummary type fields match the incident detail summary schema keys exactly", () => {
  assert.deepEqual(
    sorted(typeFieldNames("IncidentDetailSummary")),
    sorted(Object.keys(incidentDetailSummarySchema.shape)),
    "console IncidentDetailSummary and incidentDetailSummarySchema disagree; change both sides together",
  );
});
