/**
 * Boot-time database schema ensure for production deployments.
 *
 * The committed drizzle migrations in lib/db/drizzle (generated with
 * `pnpm --filter @workspace/db run generate`, freshness enforced by
 * scripts/check-db-migrations-freshness.sh) are applied here at server boot
 * whenever NODE_ENV=production, so a brand-new "Create production database"
 * deployment becomes usable with no workspace-shell step, and every later
 * schema change ships as a reviewed, committed migration that the next boot
 * applies. drizzle's migrator records applied migrations in
 * drizzle.__drizzle_migrations and only runs the pending ones, so this is a
 * no-op on an up-to-date database.
 *
 * Guard rails:
 *  - Production only. Development keeps using `drizzle-kit push` by hand, and
 *    test harnesses manage their disposable databases themselves; neither may
 *    be surprised by boot-time DDL.
 *  - A PostgreSQL advisory lock makes concurrent boots (e.g. a rolling
 *    restart) apply the migrations exactly once.
 *  - Legacy adoption: a database created by an older manual `drizzle-kit
 *    push` has tables but no drizzle journal. Before stamping a baseline we
 *    verify the database matches the FULL current shape demanded by the
 *    latest migration snapshot — every table and column with its type,
 *    nullability and default, plus primary keys, unique constraints and
 *    foreign keys. Only an exact match is stamped: anything weaker would let
 *    boot go green against a database that breaks real operations (a missing
 *    primary key surfaces later as a failed upsert, a drifted column type as
 *    a failed write). A mismatch aborts boot with reconcile instructions
 *    instead.
 *  - Any failure aborts boot loudly (the caller exits non-zero) instead of
 *    serving against a schema the code does not match.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { db, pool } from "@workspace/db";

import { logger } from "./logger";

// Structural subset of pg.PoolClient — api-server does not depend on `pg`
// directly (the pool comes from @workspace/db), so the client is typed by
// shape instead of importing the driver here.
interface QueryClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

// Fixed advisory-lock key namespace for this ensure; any two server processes
// sharing a database serialize on it.
const ADVISORY_LOCK_KEY = "hashtextextended('cas.db-schema-ensure', 0)";

// Table whose presence proves the database was set up by an older manual
// `drizzle-kit push` rather than by these migrations: it is the schema's core
// table and exists in every CAS database ever pushed.
const LEGACY_SENTINEL_TABLE = "public.cas_incidents";

interface MigrationJournalEntry {
  idx: number;
  tag: string;
  when: number;
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

// Shape of a drizzle-kit PostgreSQL snapshot file (meta/NNNN_snapshot.json),
// narrowed to what this schema uses. Snapshot column `type` strings are
// already PostgreSQL type names as information_schema.data_type reports them
// for every type this schema uses (text, integer, real, double precision,
// boolean, jsonb, bytea, timestamp with time zone) — verified by the drift
// gate staying green against the pushed development database shape.
interface SnapshotColumn {
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  default?: unknown;
}

interface SnapshotForeignKey {
  tableFrom: string;
  tableTo: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete?: string;
}

interface SnapshotTable {
  name?: string;
  columns: Record<string, SnapshotColumn>;
  uniqueConstraints: Record<string, { columns: string[] }> | unknown[];
  foreignKeys: Record<string, SnapshotForeignKey> | unknown[];
  compositePrimaryKeys: Record<string, { columns: string[] }> | unknown[];
}

interface PgSnapshot {
  tables: Record<string, SnapshotTable>;
  enums: Record<string, unknown>;
  views: Record<string, unknown>;
  sequences: Record<string, unknown>;
}

interface DbColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface DbConstraintRow {
  table_name: string;
  contype: "p" | "u" | "f";
  cols: string[];
  ref_table: string | null;
  ref_cols: string[] | null;
  del_action: string | null;
}

export interface EnsureSchemaOptions {
  /**
   * Test hook: apply the ensure even when NODE_ENV is not "production".
   * Production code must never set this — the guard exists so dev/test
   * databases managed by their own tooling are never surprised by DDL.
   */
  ignoreEnvironmentGuard?: boolean;
}

function resolveMigrationsFolder(): string {
  // Candidates cover both layouts this file runs in: the bundled production
  // entrypoint (artifacts/api-server/dist/index.mjs, three levels below the
  // repo root) and the tsx development/test entrypoint (src/lib/, four
  // levels). cwd is a last resort for launchers that start the bundle from
  // the repo root (the Replit deployment run command and the systemd unit
  // both do).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../lib/db/drizzle"),
    path.resolve(here, "../../../../lib/db/drizzle"),
    path.resolve(process.cwd(), "lib/db/drizzle"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }
  throw new Error(
    `Cannot find the committed drizzle migrations (meta/_journal.json) in any of: ${candidates.join(", ")}. ` +
      "Run `pnpm --filter @workspace/db run generate` and redeploy with lib/db/drizzle included.",
  );
}

function readJournal(migrationsFolder: string): MigrationJournal {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error(`The migrations journal in ${migrationsFolder} has no entries.`);
  }
  return journal;
}

function readLatestSnapshot(migrationsFolder: string, journal: MigrationJournal): PgSnapshot {
  const last = journal.entries[journal.entries.length - 1];
  // drizzle snapshots are complete schema pictures per migration, so the
  // newest one describes the exact shape a fully migrated database must have.
  const snapshotPath = path.join(
    migrationsFolder,
    "meta",
    `${String(last.idx).padStart(4, "0")}_snapshot.json`,
  );
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as PgSnapshot;
}

function migrationHash(migrationsFolder: string, entry: MigrationJournalEntry): string {
  // Same input the drizzle migrator hashes when it records an applied
  // migration, so a stamped baseline is indistinguishable from a real run.
  const sqlText = readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), "utf8");
  return createHash("sha256").update(sqlText).digest("hex");
}

function asList<T>(value: Record<string, T> | unknown[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? (value as T[]) : Object.values(value);
}

/**
 * Defaults survive a round trip through PostgreSQL in normalized form:
 * 'PENDING' comes back as 'PENDING'::text, JSON booleans come back as
 * lowercase literals. Compare on a stripped-down form (no casts, quotes, or
 * whitespace, lowercased) so equivalent defaults match and real drift does
 * not.
 */
function normalizeDefault(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value).replace(/::[a-z ]+/gi, "").replace(/['\s]/g, "").toLowerCase();
}

const FK_DELETE_ACTIONS: Record<string, string> = {
  a: "no action",
  c: "cascade",
  r: "restrict",
  n: "set null",
  d: "set default",
};

/**
 * Every way the database falls short of (or contradicts) the latest snapshot,
 * as human-readable difference strings for the boot error. An empty list
 * means the database provably has the full current shape and is safe to
 * baseline-stamp.
 */
async function collectBaselineDifferences(
  client: QueryClient,
  snapshot: PgSnapshot,
): Promise<string[]> {
  for (const label of ["enums", "views", "sequences"] as const) {
    if (Object.keys(snapshot[label]).length > 0) {
      throw new Error(
        `Baseline verification does not know how to compare ${label} yet — extend db-schema-ensure before relying on it.`,
      );
    }
  }

  const columnRows = await client.query<DbColumnRow>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const constraintRows = await client.query<DbConstraintRow>(
    // The ::text[] casts matter: pg_attribute.attname is the `name` type and
    // node-pg has no built-in parser for name[], so uncast arrays arrive as
    // raw "{a,b}" strings.
    `SELECT c.conrelid::regclass::text AS table_name, c.contype,
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                  ORDER BY k.ord)::text[] AS cols,
            CASE WHEN c.contype = 'f' THEN c.confrelid::regclass::text END AS ref_table,
            CASE WHEN c.contype = 'f' THEN
              ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                    ORDER BY k.ord)::text[]
            END AS ref_cols,
            c.confdeltype AS del_action
     FROM pg_constraint c
     WHERE c.connamespace = 'public'::regnamespace AND c.contype IN ('p', 'u', 'f')`,
  );

  const columnsByTable = new Map<string, Map<string, DbColumnRow>>();
  for (const row of columnRows.rows) {
    let table = columnsByTable.get(row.table_name);
    if (!table) columnsByTable.set(row.table_name, (table = new Map()));
    table.set(row.column_name, row);
  }
  const constraintsByTable = new Map<string, DbConstraintRow[]>();
  for (const row of constraintRows.rows) {
    const list = constraintsByTable.get(row.table_name) ?? [];
    list.push(row);
    constraintsByTable.set(row.table_name, list);
  }

  const differences: string[] = [];

  for (const [key, table] of Object.entries(snapshot.tables)) {
    const tableName = table.name ?? key.replace(/^public\./, "");
    const actualColumns = columnsByTable.get(tableName);
    if (!actualColumns) {
      differences.push(`${tableName} (table missing)`);
      continue;
    }

    for (const [columnName, column] of Object.entries(table.columns)) {
      const actual = actualColumns.get(columnName);
      if (!actual) {
        differences.push(`${tableName}.${columnName} (column missing)`);
        continue;
      }
      if (actual.data_type !== column.type) {
        differences.push(
          `${tableName}.${columnName} (type: expected ${column.type}, found ${actual.data_type})`,
        );
      }
      if ((actual.is_nullable === "YES") === column.notNull) {
        differences.push(
          `${tableName}.${columnName} (nullability: expected ${column.notNull ? "NOT NULL" : "nullable"})`,
        );
      }
      const expectedDefault = normalizeDefault(column.default);
      const actualDefault = normalizeDefault(actual.column_default);
      if (expectedDefault !== actualDefault) {
        differences.push(`${tableName}.${columnName} (default mismatch)`);
      }
    }

    const actualConstraints = constraintsByTable.get(tableName) ?? [];
    const actualPk = actualConstraints.find((c) => c.contype === "p");
    // Snapshot primary key = columns flagged primaryKey, or the composite list.
    const expectedPk = Object.entries(table.columns)
      .filter(([, c]) => c.primaryKey)
      .map(([name]) => name)
      .concat(asList<{ columns: string[] }>(table.compositePrimaryKeys).flatMap((c) => c.columns))
      .sort();
    const actualPkCols = (actualPk?.cols ?? []).slice().sort();
    if (expectedPk.join(",") !== actualPkCols.join(",")) {
      differences.push(
        `${tableName} (primary key: expected [${expectedPk.join(", ")}], found [${actualPkCols.join(", ")}])`,
      );
    }

    const expectedUniques = asList<{ columns: string[] }>(table.uniqueConstraints)
      .map((c) => c.columns.slice().sort().join(","))
      .sort();
    const actualUniques = actualConstraints
      .filter((c) => c.contype === "u")
      .map((c) => c.cols.slice().sort().join(","))
      .sort();
    if (expectedUniques.join("|") !== actualUniques.join("|")) {
      differences.push(
        `${tableName} (unique constraints: expected [${expectedUniques.join(" | ")}], found [${actualUniques.join(" | ")}])`,
      );
    }

    const fkKey = (from: string, to: string, cols: string[], refCols: string[], onDelete: string) =>
      `${cols.join(",")} -> ${to}(${refCols.join(",")}) on delete ${onDelete.toLowerCase()}`;
    const expectedFks = asList<SnapshotForeignKey>(table.foreignKeys)
      .map((fk) =>
        fkKey(tableName, fk.tableTo, fk.columnsFrom, fk.columnsTo, fk.onDelete ?? "no action"),
      )
      .sort();
    const actualFks = actualConstraints
      .filter((c) => c.contype === "f")
      .map((c) =>
        fkKey(
          tableName,
          c.ref_table ?? "?",
          c.cols,
          c.ref_cols ?? [],
          FK_DELETE_ACTIONS[c.del_action ?? "a"] ?? "?",
        ),
      )
      .sort();
    if (expectedFks.join("|") !== actualFks.join("|")) {
      differences.push(
        `${tableName} (foreign keys: expected [${expectedFks.join(" | ")}], found [${actualFks.join(" | ")}])`,
      );
    }
  }

  return differences;
}

/**
 * A database pushed by hand before migration-based setup existed has no
 * drizzle journal, so the migrator would try to recreate everything and die
 * on "relation already exists". If the database provably matches the full
 * current shape, stamp every committed migration as applied (same hashes the
 * migrator itself would record) and let the migrator carry on from there —
 * a no-op today, correct for future migrations. Any difference means the
 * pushed schema diverges from the code and there is no safe guess: abort
 * boot with the one-time reconcile instead of serving a broken schema.
 */
async function stampBaselineIfLegacy(
  client: QueryClient,
  migrationsFolder: string,
  journal: MigrationJournal,
): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
  const recorded = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations`,
  );
  if ((recorded.rows[0]?.n ?? 0) > 0) return;

  const sentinel = await client.query<{ t: string | null }>(
    `SELECT to_regclass('${LEGACY_SENTINEL_TABLE}') AS t`,
  );
  if (!sentinel.rows[0]?.t) return; // fresh database: migrate creates everything

  const differences = await collectBaselineDifferences(
    client,
    readLatestSnapshot(migrationsFolder, journal),
  );
  if (differences.length > 0) {
    throw new Error(
      "This database has CAS tables (created by an older manual drizzle-kit push) but does not match " +
        `the current schema — differences: ${differences.join("; ")}. Refusing to guess a migration baseline. ` +
        "Reconcile it once from a workspace checkout with " +
        "`DATABASE_URL=<this database> pnpm --filter @workspace/db run push` (review the printed diff), " +
        "then restart: boot will stamp the baseline automatically.",
    );
  }

  for (const entry of journal.entries) {
    await client.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [migrationHash(migrationsFolder, entry), entry.when],
    );
  }
  logger.warn(
    { migrationsStamped: journal.entries.length },
    "Database has the full current schema but no migration journal (created by a manual drizzle-kit push): " +
      "stamped the committed migrations as applied and continuing normally.",
  );
}

export async function ensureCasDatabaseSchema(options: EnsureSchemaOptions = {}): Promise<void> {
  if (!options.ignoreEnvironmentGuard && process.env["NODE_ENV"] !== "production") {
    logger.debug(
      "Database schema ensure skipped outside production (dev/test databases are managed by their own tooling).",
    );
    return;
  }

  const migrationsFolder = resolveMigrationsFolder();
  const journal = readJournal(migrationsFolder);

  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    try {
      await stampBaselineIfLegacy(client, migrationsFolder, journal);
      await migrate(db, { migrationsFolder });
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    }
  } finally {
    client.release();
  }

  const applied = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations`,
  );
  logger.info(
    { migrationsApplied: applied.rows[0]?.n ?? 0, migrationsCommitted: journal.entries.length },
    "Database schema ensure complete: committed drizzle migrations are applied.",
  );
}
