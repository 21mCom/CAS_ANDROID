/**
 * Boot-time schema ensure (lib/db-schema-ensure.ts) against the disposable
 * review database. The contract runner prepares that database with
 * `drizzle-kit push-force` — tables but no migration journal — which is
 * exactly the legacy hand-pushed shape the adoption path exists for.
 *
 * Covered:
 *  1. legacy adoption: a pushed database matching the current schema in full
 *     (columns, types, nullability, defaults, PK/unique/FK constraints) is
 *     stamped with the committed migrations and migrates cleanly afterwards;
 *  2-4. negative proofs: a legacy database missing a column, missing a
 *     primary key, or holding an incompatible column type must abort with
 *     the difference named and the journal left empty — boot must never go
 *     green against a schema that breaks real operations;
 *  5. fresh database: an empty cluster gets the full schema from the
 *     committed migrations alone (and doubles as the cleanup that restores
 *     the database for the rest of the suite).
 *
 * Each test drops the drizzle journal schema first so none depends on a
 * previous test's stamp. Runs as its own tsx --test invocation (DB-touching
 * suites never share a process — see the test:direct chain in package.json).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { pool } from "@workspace/db";

import { assertDisposableTestDatabase } from "./cas-test-db-guard";
import { ensureCasDatabaseSchema } from "./db-schema-ensure";

// The ensure rewrites the schema of whatever DATABASE_URL points at: refuse
// to boot unless the contract runner's disposable review database is
// provably the target (never the dev database).
assertDisposableTestDatabase();

const ensure = () => ensureCasDatabaseSchema({ ignoreEnvironmentGuard: true });

/**
 * null when the drizzle journal table does not exist at all. Two separate
 * queries on purpose: PostgreSQL resolves relations at plan time, so a CASE
 * around a SELECT from the maybe-missing table fails with 42P01 instead of
 * falling through.
 */
async function migrationJournalCount(): Promise<number | null> {
  const exists = await pool.query<{ t: string | null }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') AS t`,
  );
  if (!exists.rows[0]?.t) return null;
  const count = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations`,
  );
  return count.rows[0]?.n ?? 0;
}

async function committedMigrationCount(): Promise<number> {
  const journal = JSON.parse(
    readFileSync(
      new URL("../../../../lib/db/drizzle/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

/** Un-journal the database so each negative test stages its own legacy DB. */
async function dropJournal(): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
}

async function expectBaselineRejection(needle: RegExp): Promise<void> {
  const error = await ensure().then(
    () => null,
    (err: unknown) => err as Error,
  );
  assert.ok(error, "ensure must abort on a legacy database that diverges from the current schema");
  assert.match(error.message, /does not match the current schema/);
  assert.match(error.message, needle);
  assert.match(
    error.message,
    /run push/,
    "the error names the one-time reconcile command",
  );
  const count = await migrationJournalCount();
  assert.ok(count === null || count === 0, `journal must stay empty on rejection, got ${count}`);
}

test("adopts a legacy hand-pushed database that matches the current schema", async () => {
  // Harness state: full schema via push-force, no drizzle journal.
  await dropJournal();
  assert.equal(await migrationJournalCount(), null);

  await ensure();

  const expected = await committedMigrationCount();
  assert.equal(
    await migrationJournalCount(),
    expected,
    "every committed migration is stamped as applied",
  );
  // The database itself is untouched and queryable.
  await pool.query(`SELECT COUNT(*) FROM cas_incidents`);

  // Idempotent: a second boot's ensure changes nothing.
  await ensure();
  assert.equal(await migrationJournalCount(), expected);
});

test("rejects a legacy database missing a current column", async () => {
  await dropJournal();
  await pool.query(`ALTER TABLE cas_outbox DROP COLUMN delivered_to`);
  try {
    await expectBaselineRejection(/cas_outbox\.delivered_to \(column missing\)/);
  } finally {
    await pool.query(`ALTER TABLE cas_outbox ADD COLUMN IF NOT EXISTS delivered_to text`);
  }
});

test("rejects a legacy database missing a primary key", async () => {
  await dropJournal();
  // The review's reproducer: an upsert target without its PK fails at query
  // time (42P10), so adoption must refuse it here instead.
  await pool.query(
    `ALTER TABLE cas_message_templates DROP CONSTRAINT cas_message_templates_pkey`,
  );
  await expectBaselineRejection(/cas_message_templates \(primary key: expected \[channel\], found \[\]\)/);
});

test("rejects a legacy database with an incompatible column type", async () => {
  await dropJournal();
  await pool.query(`ALTER TABLE cas_outbox DROP COLUMN delivered_to`);
  await pool.query(`ALTER TABLE cas_outbox ADD COLUMN delivered_to integer`);
  try {
    await expectBaselineRejection(/cas_outbox\.delivered_to \(type: expected text, found integer\)/);
  } finally {
    await pool.query(`ALTER TABLE cas_outbox DROP COLUMN IF EXISTS delivered_to`);
    await pool.query(`ALTER TABLE cas_outbox ADD COLUMN IF NOT EXISTS delivered_to text`);
  }
});

test("creates the full schema in a fresh empty database", async () => {
  await pool.query(`DROP SCHEMA public CASCADE`);
  await pool.query(`CREATE SCHEMA public`);
  await pool.query(`DROP SCHEMA IF EXISTS drizzle CASCADE`);

  await ensure();

  const tables = await pool.query<{ t: string | null; u: string | null }>(
    `SELECT to_regclass('public.cas_incidents') AS t, to_regclass('public.cas_app_updates') AS u`,
  );
  assert.ok(tables.rows[0]?.t, "cas_incidents created from the committed migrations");
  assert.ok(tables.rows[0]?.u, "cas_app_updates created from the committed migrations");
  assert.equal(await migrationJournalCount(), await committedMigrationCount());
});
