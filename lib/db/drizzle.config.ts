import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  // Committed migrations: the api-server applies these at boot in production
  // (artifacts/api-server/src/lib/db-schema-ensure.ts), so `drizzle/` must
  // stay in lockstep with the schema — scripts/check-db-migrations-freshness.sh
  // enforces that in CI.
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
