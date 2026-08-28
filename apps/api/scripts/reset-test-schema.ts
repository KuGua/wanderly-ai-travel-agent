/**
 * One-off maintenance script: drop and recreate the test schema so
 * migrations can be re-applied cleanly. Not part of CI.
 *
 *   DATABASE_URL=postgres://travelagent:travelagent@127.0.0.1:5432/travelagent \
 *     tsx scripts/reset-test-schema.ts
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(url);
try {
  await sql.unsafe("DROP SCHEMA IF EXISTS travelagent_test CASCADE");
  await sql.unsafe("CREATE SCHEMA travelagent_test");
  console.log("schema reset ok");
} finally {
  await sql.end();
}