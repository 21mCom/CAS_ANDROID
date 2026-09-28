/**
 * Console/API parity test for the GET /api/cas/outbox/status and
 * /api/cas/config/* response contracts.
 *
 * The console mirrors these payloads with zod schemas
 * (artifacts/covert-alert-system/src/lib/cas-outbox-status-schema.ts and
 * cas-config-schema.ts) so a drifted server surfaces a visible shape error
 * instead of silently rendering wrong pipeline health or responder/template
 * configuration. But the server assembles both responses inline —
 * routes/cas.ts builds the outbox-status body by hand and routes/cas-config.ts
 * shapes rows through shapeResponder/shapeTemplate — so nothing pinned the
 * mirrors to the server side: a server-side field rename would only be
 * caught at runtime by an operator's console.
 *
 * This test closes that gap the same way cas-readiness-schema.test.ts did
 * for the state response: it parses both sides with the TypeScript compiler
 * and fails CI when either changes without the other:
 *  - the outbox-status res.json keys (and the nested counts /
 *    lastDeliveryError / worker-heartbeat shapes) must exactly match the
 *    console's casOutboxStatusResponseSchema keys,
 *  - the responder/template/preview shapes must exactly match the console's
 *    cas-config schemas,
 *  - the smsDeliveryMode / deviceChannels / template-channel / template-source
 *    enums must match on both sides.
 *
 * This test needs no database; it only reads source files.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const libDir = path.dirname(fileURLToPath(import.meta.url));

interface ParsedSource {
  filePath: string;
  sourceFile: ts.SourceFile;
}

function parseSource(filePath: string): ParsedSource {
  const text = readFileSync(filePath, "utf8");
  return {
    filePath,
    sourceFile: ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    ),
  };
}

// Server side: the routes assemble their responses inline; the worker
// heartbeat, device-mode, and template-channel types they serialize live in
// lib/.
const casRoute = parseSource(path.resolve(libDir, "../routes/cas.ts"));
const casConfigRoute = parseSource(path.resolve(libDir, "../routes/cas-config.ts"));
const heartbeatLib = parseSource(path.resolve(libDir, "cas-outbox-status.ts"));
const deviceDeliveryLib = parseSource(path.resolve(libDir, "cas-device-delivery.ts"));
const templateLib = parseSource(path.resolve(libDir, "cas-message-template.ts"));

// Console side: the mirror schemas the polling/config clients parse through.
const outboxMirror = parseSource(
  path.resolve(libDir, "../../../covert-alert-system/src/lib/cas-outbox-status-schema.ts"),
);
const configMirror = parseSource(
  path.resolve(libDir, "../../../covert-alert-system/src/lib/cas-config-schema.ts"),
);

function fail(parsed: ParsedSource, message: string): never {
  assert.fail(`${message} (source: ${parsed.filePath})`);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function visitAll(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visitAll(child, callback));
}

function propertyName(parsed: ParsedSource, name: ts.PropertyName, context: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return fail(parsed, `${context} has a property name this test cannot read`);
}

/** Field names of an object literal; spread/method members are unreadable. */
function objectLiteralKeys(
  parsed: ParsedSource,
  literal: ts.ObjectLiteralExpression,
  context: string,
): string[] {
  return literal.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      fail(parsed, `${context} has a member this test cannot read (spread or method)`);
    }
    return propertyName(parsed, property.name, context);
  });
}

/** Property assignment of one field on an object literal. */
function objectProperty(
  parsed: ParsedSource,
  literal: ts.ObjectLiteralExpression,
  fieldName: string,
  context: string,
): ts.PropertyAssignment {
  const property = literal.properties.find(
    (entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) && propertyName(parsed, entry.name, context) === fieldName,
  );
  if (!property) fail(parsed, `${context}.${fieldName} not found`);
  return property;
}

/** String members of a `["a", "b"]` literal (an `as const` cast is fine). */
function stringLiteralArray(
  parsed: ParsedSource,
  expression: ts.Expression | undefined,
  context: string,
): string[] {
  const unwrapped = expression && ts.isAsExpression(expression) ? expression.expression : expression;
  if (!unwrapped || !ts.isArrayLiteralExpression(unwrapped)) {
    fail(parsed, `${context} is no longer a string array literal`);
  }
  return unwrapped.elements.map((element) => {
    if (!ts.isStringLiteral(element)) fail(parsed, `${context} contains a non-literal member`);
    return element.text;
  });
}

/** String literals anywhere inside an expression (e.g. both ternary arms). */
function stringLiteralsWithin(expression: ts.Expression): string[] {
  const literals: string[] = [];
  visitAll(expression, (node) => {
    if (ts.isStringLiteral(node)) literals.push(node.text);
  });
  return literals;
}

// --- Console mirror side: read the zod schema declarations ---

/**
 * Walks a zod method chain (`.strict()`, `.nullable()`, `.int()`, ...) down
 * to the base `z.<kind>(...)` call.
 */
function zodBaseCall(
  parsed: ParsedSource,
  expression: ts.Expression,
  context: string,
): ts.CallExpression {
  let current: ts.Expression = expression;
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isCallExpression(current.expression.expression)
  ) {
    current = current.expression.expression;
  }
  if (
    !ts.isCallExpression(current) ||
    !ts.isPropertyAccessExpression(current.expression) ||
    !ts.isIdentifier(current.expression.expression) ||
    current.expression.expression.text !== "z"
  ) {
    fail(parsed, `${context} is no longer a zod schema expression`);
  }
  return current;
}

function zodCallKind(parsed: ParsedSource, call: ts.CallExpression, context: string): string {
  if (!ts.isPropertyAccessExpression(call.expression)) {
    fail(parsed, `${context} is no longer a z.<kind>(...) call`);
  }
  return (call.expression as ts.PropertyAccessExpression).name.text;
}

/** The base zod call of `const X = z.<kind>(...)...`. */
function zodSchemaVariable(parsed: ParsedSource, variableName: string): ts.CallExpression {
  let initializer: ts.Expression | undefined;
  visitAll(parsed.sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      initializer = node.initializer;
    }
  });
  if (!initializer) fail(parsed, `const ${variableName} not found`);
  return zodBaseCall(parsed, initializer, `const ${variableName}`);
}

function zodObjectLiteral(
  parsed: ParsedSource,
  call: ts.CallExpression,
  context: string,
): ts.ObjectLiteralExpression {
  const kind = zodCallKind(parsed, call, context);
  if (kind !== "object") fail(parsed, `${context} is now z.${kind}(...), expected z.object(...)`);
  const [argument] = call.arguments;
  if (!argument || !ts.isObjectLiteralExpression(argument)) {
    fail(parsed, `${context} no longer takes an object literal`);
  }
  return argument;
}

/** Field names of `const X = z.object({ ... })...`. */
function zodObjectKeys(parsed: ParsedSource, variableName: string): string[] {
  return objectLiteralKeys(
    parsed,
    zodObjectLiteral(parsed, zodSchemaVariable(parsed, variableName), `const ${variableName}`),
    variableName,
  );
}

/** Field names of a nested `field: z.object({ ... })...` inside `const X`. */
function zodNestedObjectKeys(
  parsed: ParsedSource,
  variableName: string,
  fieldName: string,
): string[] {
  const schema = zodObjectLiteral(
    parsed,
    zodSchemaVariable(parsed, variableName),
    `const ${variableName}`,
  );
  const property = objectProperty(parsed, schema, fieldName, variableName);
  const call = zodBaseCall(parsed, property.initializer, `${variableName}.${fieldName}`);
  return objectLiteralKeys(
    parsed,
    zodObjectLiteral(parsed, call, `${variableName}.${fieldName}`),
    `${variableName}.${fieldName}`,
  );
}

/** Options of a `field: z.enum([...])` property inside `const X`. */
function zodEnumOptions(
  parsed: ParsedSource,
  variableName: string,
  fieldName: string,
): string[] {
  const schema = zodObjectLiteral(
    parsed,
    zodSchemaVariable(parsed, variableName),
    `const ${variableName}`,
  );
  const property = objectProperty(parsed, schema, fieldName, variableName);
  const call = zodBaseCall(parsed, property.initializer, `${variableName}.${fieldName}`);
  const kind = zodCallKind(parsed, call, `${variableName}.${fieldName}`);
  if (kind !== "enum") {
    fail(parsed, `${variableName}.${fieldName} is now z.${kind}(...), expected z.enum(...)`);
  }
  return stringLiteralArray(parsed, call.arguments[0], `${variableName}.${fieldName}`);
}

/** The single literal of a `field: z.array(z.literal('...'))` property. */
function zodArrayLiteralMember(
  parsed: ParsedSource,
  variableName: string,
  fieldName: string,
): string {
  const schema = zodObjectLiteral(
    parsed,
    zodSchemaVariable(parsed, variableName),
    `const ${variableName}`,
  );
  const property = objectProperty(parsed, schema, fieldName, variableName);
  const context = `${variableName}.${fieldName}`;
  const arrayCall = zodBaseCall(parsed, property.initializer, context);
  if (zodCallKind(parsed, arrayCall, context) !== "array") {
    fail(parsed, `${context} is no longer a z.array(...)`);
  }
  const literalCall = zodBaseCall(parsed, arrayCall.arguments[0], `${context} element`);
  if (zodCallKind(parsed, literalCall, `${context} element`) !== "literal") {
    fail(parsed, `${context} element is no longer a z.literal(...)`);
  }
  const [argument] = literalCall.arguments;
  if (!argument || !ts.isStringLiteral(argument)) {
    fail(parsed, `${context} element is no longer a string literal`);
  }
  return argument.text;
}

/**
 * The `{ ok, keys }` of each branch of
 * `const X = z.union([z.object({ ok: z.literal(...), ... }), ...])`.
 */
function zodUnionBranches(
  parsed: ParsedSource,
  variableName: string,
): { ok: boolean; keys: string[] }[] {
  const call = zodSchemaVariable(parsed, variableName);
  if (zodCallKind(parsed, call, `const ${variableName}`) !== "union") {
    fail(parsed, `const ${variableName} is no longer a z.union(...)`);
  }
  const [argument] = call.arguments;
  if (!argument || !ts.isArrayLiteralExpression(argument)) {
    fail(parsed, `const ${variableName} no longer takes an array of branches`);
  }
  return argument.elements.map((element, index) => {
    const context = `${variableName} branch ${index}`;
    const branch = zodObjectLiteral(parsed, zodBaseCall(parsed, element, context), context);
    const okInitializer = objectProperty(parsed, branch, "ok", context).initializer;
    const okCall = zodBaseCall(parsed, okInitializer, `${context}.ok`);
    if (zodCallKind(parsed, okCall, `${context}.ok`) !== "literal") {
      fail(parsed, `${context}.ok is no longer a z.literal(...)`);
    }
    const [okArgument] = okCall.arguments;
    if (
      !okArgument ||
      (okArgument.kind !== ts.SyntaxKind.TrueKeyword &&
        okArgument.kind !== ts.SyntaxKind.FalseKeyword)
    ) {
      fail(parsed, `${context}.ok is no longer a boolean literal`);
    }
    return {
      ok: okArgument.kind === ts.SyntaxKind.TrueKeyword,
      keys: objectLiteralKeys(parsed, branch, context),
    };
  });
}

/** Field names of the `z.object({ ... })` parsed inside a mirror function. */
function mirrorFunctionObjectKeys(parsed: ParsedSource, functionName: string): string[] {
  const declaration = parsed.sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
  );
  if (!declaration) fail(parsed, `function ${functionName} not found`);
  let literal: ts.ObjectLiteralExpression | undefined;
  visitAll(declaration, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "z" &&
      node.expression.name.text === "object" &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      literal = node.arguments[0];
    }
  });
  if (!literal) fail(parsed, `function ${functionName} no longer parses a z.object literal`);
  return objectLiteralKeys(parsed, literal, functionName);
}

// --- Server side: read the route/lib declarations ---

/** The handler (last argument) of `router.<method>("<url>", ...)`. */
function routeHandler(
  parsed: ParsedSource,
  method: "get" | "post",
  url: string,
): ts.ArrowFunction | ts.FunctionExpression {
  let handler: ts.ArrowFunction | ts.FunctionExpression | undefined;
  visitAll(parsed.sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "router" &&
      node.expression.name.text === method &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === url
    ) {
      const last = node.arguments[node.arguments.length - 1];
      if (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) handler = last;
    }
  });
  if (!handler) fail(parsed, `route ${method.toUpperCase()} ${url} not found`);
  return handler;
}

/** Object literals passed to `res.json({ ... })` inside a route handler. */
function resJsonObjectLiterals(
  parsed: ParsedSource,
  handler: ts.ArrowFunction | ts.FunctionExpression,
): ts.ObjectLiteralExpression[] {
  const literals: ts.ObjectLiteralExpression[] = [];
  visitAll(handler, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "res" &&
      node.expression.name.text === "json" &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      literals.push(node.arguments[0]);
    }
  });
  return literals;
}

/** The object literal a `function name(...) { return { ... } }` returns. */
function returnedObjectLiteral(parsed: ParsedSource, functionName: string): ts.ObjectLiteralExpression {
  const declaration = parsed.sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
  );
  if (!declaration) fail(parsed, `function ${functionName} not found`);
  let literal: ts.ObjectLiteralExpression | undefined;
  visitAll(declaration, (node) => {
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isObjectLiteralExpression(node.expression)
    ) {
      literal = node.expression;
    }
  });
  if (!literal) fail(parsed, `function ${functionName} no longer returns an object literal`);
  return literal;
}

/** The initializer of `const name = ...` at any nesting depth. */
function variableInitializer(parsed: ParsedSource, variableName: string): ts.Expression {
  let initializer: ts.Expression | undefined;
  visitAll(parsed.sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      initializer = node.initializer;
    }
  });
  if (!initializer) fail(parsed, `const ${variableName} not found`);
  return initializer;
}

function interfaceDeclaration(parsed: ParsedSource, name: string): ts.InterfaceDeclaration {
  const declaration = parsed.sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (!declaration) fail(parsed, `interface ${name} not found`);
  return declaration;
}

/** Member names of an interface. */
function interfaceMemberNames(parsed: ParsedSource, name: string): string[] {
  return interfaceDeclaration(parsed, name).members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.name) {
      fail(parsed, `interface ${name} has a member this test cannot read`);
    }
    return propertyName(parsed, member.name, name);
  });
}

/** Member names of an inline `{ ... }` type on an interface property. */
function interfaceInlineTypeMembers(
  parsed: ParsedSource,
  name: string,
  fieldName: string,
): string[] {
  const member = interfaceDeclaration(parsed, name).members.find(
    (entry): entry is ts.PropertySignature =>
      ts.isPropertySignature(entry) &&
      entry.name !== undefined &&
      propertyName(parsed, entry.name, name) === fieldName,
  );
  if (!member || !member.type) fail(parsed, `${name}.${fieldName} not found`);
  const candidates = ts.isUnionTypeNode(member.type) ? member.type.types : [member.type];
  const literal = candidates.find((candidate) => ts.isTypeLiteralNode(candidate));
  if (!literal || !ts.isTypeLiteralNode(literal)) {
    fail(parsed, `${name}.${fieldName} no longer contains an inline object type`);
  }
  return (literal as ts.TypeLiteralNode).members.map((entry) => {
    if (!ts.isPropertySignature(entry) || !entry.name) {
      fail(parsed, `${name}.${fieldName} has a member this test cannot read`);
    }
    return propertyName(parsed, entry.name, `${name}.${fieldName}`);
  });
}

/** String literals of a `type X = "a" | "b"` alias (a single literal is fine). */
function typeAliasStringLiterals(parsed: ParsedSource, aliasName: string): string[] {
  const alias = parsed.sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === aliasName,
  );
  if (!alias) fail(parsed, `type ${aliasName} not found`);
  const members = ts.isUnionTypeNode(alias.type) ? alias.type.types : [alias.type];
  return members.map((member) => {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      fail(parsed, `type ${aliasName} contains a non-literal member`);
    }
    return member.literal.text;
  });
}

/** The boolean of an `ok: true as const` / `ok: false` property. */
function okLiteralValue(
  parsed: ParsedSource,
  literal: ts.ObjectLiteralExpression,
  context: string,
): boolean {
  const initializer = objectProperty(parsed, literal, "ok", context).initializer;
  const unwrapped = ts.isAsExpression(initializer) ? initializer.expression : initializer;
  if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return false;
  return fail(parsed, `${context}.ok is no longer a boolean literal`);
}

// --- GET /api/cas/outbox/status vs. casOutboxStatusResponseSchema ---

const outboxStatusHandler = routeHandler(casRoute, "get", "/cas/outbox/status");
const outboxStatusBodies = resJsonObjectLiterals(casRoute, outboxStatusHandler);
assert.equal(
  outboxStatusBodies.length,
  1,
  "the outbox-status route should respond with exactly one res.json object literal",
);
const outboxStatusBody = outboxStatusBodies[0];

test("server outbox-status response fields match the console mirror schema keys exactly", () => {
  assert.deepEqual(
    sorted(objectLiteralKeys(casRoute, outboxStatusBody, "outbox-status response")),
    sorted(zodObjectKeys(outboxMirror, "casOutboxStatusResponseSchema")),
    "the outbox-status route response and casOutboxStatusResponseSchema disagree; change both sides together (routes/cas.ts and covert-alert-system/src/lib/cas-outbox-status-schema.ts)",
  );
});

test("server outbox-status counts fields match the console counts schema keys exactly", () => {
  const countsInitializer = variableInitializer(casRoute, "counts");
  if (!ts.isObjectLiteralExpression(countsInitializer)) {
    fail(casRoute, "const counts is no longer an object literal");
  }
  assert.deepEqual(
    sorted(objectLiteralKeys(casRoute, countsInitializer, "outbox-status counts")),
    sorted(zodObjectKeys(outboxMirror, "outboxStateCountsSchema")),
    "the outbox-status counts and outboxStateCountsSchema disagree; change both sides together",
  );
});

test("server lastDeliveryError fields match the console lastDeliveryError schema keys exactly", () => {
  const property = objectProperty(casRoute, outboxStatusBody, "lastDeliveryError", "outbox-status response");
  if (!ts.isConditionalExpression(property.initializer)) {
    fail(casRoute, "lastDeliveryError is no longer a conditional expression");
  }
  const whenPresent = property.initializer.whenTrue;
  if (!ts.isObjectLiteralExpression(whenPresent)) {
    fail(casRoute, "lastDeliveryError no longer builds an object literal when present");
  }
  assert.deepEqual(
    sorted(objectLiteralKeys(casRoute, whenPresent, "outbox-status lastDeliveryError")),
    sorted(zodNestedObjectKeys(outboxMirror, "casOutboxStatusResponseSchema", "lastDeliveryError")),
    "the server lastDeliveryError shape and the console mirror disagree; change both sides together",
  );
});

test("worker heartbeat interface fields match the console worker schema keys exactly", () => {
  assert.deepEqual(
    sorted(interfaceMemberNames(heartbeatLib, "CasOutboxWorkerHeartbeat")),
    sorted(zodObjectKeys(outboxMirror, "workerHeartbeatSchema")),
    "CasOutboxWorkerHeartbeat and workerHeartbeatSchema disagree; change both sides together (lib/cas-outbox-status.ts and covert-alert-system/src/lib/cas-outbox-status-schema.ts)",
  );
});

test("worker tick summary fields match the console lastTick schema keys exactly", () => {
  assert.deepEqual(
    sorted(interfaceMemberNames(heartbeatLib, "CasOutboxTickSummary")),
    sorted(zodNestedObjectKeys(outboxMirror, "workerHeartbeatSchema", "lastTick")),
    "CasOutboxTickSummary and the workerHeartbeatSchema lastTick shape disagree; change both sides together",
  );
});

test("worker lastError fields match the console lastError schema keys exactly", () => {
  assert.deepEqual(
    sorted(interfaceInlineTypeMembers(heartbeatLib, "CasOutboxWorkerHeartbeat", "lastError")),
    sorted(zodNestedObjectKeys(outboxMirror, "workerHeartbeatSchema", "lastError")),
    "the CasOutboxWorkerHeartbeat lastError shape and the console mirror disagree; change both sides together",
  );
});

test("server SmsDeliveryMode union matches the console smsDeliveryMode enum", () => {
  assert.deepEqual(
    sorted(typeAliasStringLiterals(deviceDeliveryLib, "SmsDeliveryMode")),
    sorted(zodEnumOptions(outboxMirror, "casOutboxStatusResponseSchema", "smsDeliveryMode")),
    "SmsDeliveryMode and the console smsDeliveryMode enum disagree; change both sides together (lib/cas-device-delivery.ts and cas-outbox-status-schema.ts)",
  );
});

test("server DeviceChannel union matches the console deviceChannels literal", () => {
  assert.deepEqual(
    sorted(typeAliasStringLiterals(deviceDeliveryLib, "DeviceChannel")),
    sorted([zodArrayLiteralMember(outboxMirror, "casOutboxStatusResponseSchema", "deviceChannels")]),
    "DeviceChannel and the console deviceChannels literal disagree; change both sides together",
  );
});

// --- /api/cas/config/* vs. the cas-config mirror schemas ---

test("server responders response fields match the console responders parser keys exactly", () => {
  const bodies = resJsonObjectLiterals(
    casConfigRoute,
    routeHandler(casConfigRoute, "get", "/cas/config/responders"),
  );
  assert.equal(bodies.length, 1, "the responders list route should respond with one res.json object literal");
  assert.deepEqual(
    sorted(objectLiteralKeys(casConfigRoute, bodies[0], "responders response")),
    sorted(mirrorFunctionObjectKeys(configMirror, "parseCasRespondersResponse")),
    "the responders response and parseCasRespondersResponse disagree; change both sides together (routes/cas-config.ts and covert-alert-system/src/lib/cas-config-schema.ts)",
  );
});

test("server shapeResponder fields match the console responder schema keys exactly", () => {
  assert.deepEqual(
    sorted(objectLiteralKeys(casConfigRoute, returnedObjectLiteral(casConfigRoute, "shapeResponder"), "shapeResponder")),
    sorted(zodObjectKeys(configMirror, "responderSchema")),
    "shapeResponder and responderSchema disagree; change both sides together",
  );
});

test("server shapeResponder channel fields match the console channels schema keys exactly", () => {
  const shape = returnedObjectLiteral(casConfigRoute, "shapeResponder");
  const channels = objectProperty(casConfigRoute, shape, "channels", "shapeResponder").initializer;
  if (!ts.isObjectLiteralExpression(channels)) {
    fail(casConfigRoute, "shapeResponder channels is no longer an object literal");
  }
  assert.deepEqual(
    sorted(objectLiteralKeys(casConfigRoute, channels, "shapeResponder channels")),
    sorted(zodNestedObjectKeys(configMirror, "responderSchema", "channels")),
    "shapeResponder channels and the responderSchema channels shape disagree; change both sides together",
  );
});

test("server templates response fields match the console templates parser keys exactly", () => {
  const bodies = resJsonObjectLiterals(
    casConfigRoute,
    routeHandler(casConfigRoute, "get", "/cas/config/templates"),
  );
  assert.equal(bodies.length, 1, "the templates list route should respond with one res.json object literal");
  assert.deepEqual(
    sorted(objectLiteralKeys(casConfigRoute, bodies[0], "templates response")),
    sorted(mirrorFunctionObjectKeys(configMirror, "parseCasTemplatesResponse")),
    "the templates response and parseCasTemplatesResponse disagree; change both sides together",
  );
});

test("server shapeTemplate fields match the console template schema keys exactly", () => {
  assert.deepEqual(
    sorted(objectLiteralKeys(casConfigRoute, returnedObjectLiteral(casConfigRoute, "shapeTemplate"), "shapeTemplate")),
    sorted(zodObjectKeys(configMirror, "templateInfoSchema")),
    "shapeTemplate and templateInfoSchema disagree; change both sides together",
  );
});

test("server template channels match the console template channel enum", () => {
  assert.deepEqual(
    sorted(stringLiteralArray(casConfigRoute, variableInitializer(templateLib, "CAS_TEMPLATE_CHANNELS"), "CAS_TEMPLATE_CHANNELS")),
    sorted(zodEnumOptions(configMirror, "templateInfoSchema", "channel")),
    "CAS_TEMPLATE_CHANNELS and the templateInfoSchema channel enum disagree; change both sides together (lib/cas-message-template.ts and cas-config-schema.ts)",
  );
});

test("server shapeTemplate source literals match the console template source enum", () => {
  const shape = returnedObjectLiteral(casConfigRoute, "shapeTemplate");
  const source = objectProperty(casConfigRoute, shape, "source", "shapeTemplate").initializer;
  assert.deepEqual(
    sorted(stringLiteralsWithin(source)),
    sorted(zodEnumOptions(configMirror, "templateInfoSchema", "source")),
    "the shapeTemplate source literals and the templateInfoSchema source enum disagree; change both sides together",
  );
});

test("server template preview branches match the console preview result union exactly", () => {
  const bodies = resJsonObjectLiterals(
    casConfigRoute,
    routeHandler(casConfigRoute, "post", "/cas/config/templates/preview"),
  );
  // Both branches respond 200 with an object literal; the 400 rejection goes
  // through res.status(400).json and is not part of the success contract.
  const serverBranches = bodies
    .map((body, index) => ({
      ok: okLiteralValue(casConfigRoute, body, `preview response ${index}`),
      keys: objectLiteralKeys(casConfigRoute, body, `preview response ${index}`),
    }))
    .sort((a, b) => Number(a.ok) - Number(b.ok));
  const mirrorBranches = zodUnionBranches(configMirror, "templatePreviewResultSchema").sort(
    (a, b) => Number(a.ok) - Number(b.ok),
  );
  assert.deepEqual(
    serverBranches,
    mirrorBranches,
    "the template preview response branches and templatePreviewResultSchema disagree; change both sides together",
  );
});
