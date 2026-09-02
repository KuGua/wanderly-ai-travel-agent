/**
 * Reconciliation utility: the local DB at 127.0.0.1 was bootstrapped to
 * the final schema state (post-0060), but `schema_migrations` only has
 * records through 0011. Re-running migrations 0012–0060 would either
 * fail validation (e.g. 0012's narrow operation_refs_check rejects
 * existing RESEARCH rows) or hit non-idempotent statements
 * (DROP/RENAME in 0049, 0056, 0057, 0058). Bring the ledger into sync
 * with the actual schema instead.
 *
 * Pre-flight checks verify the schema is already at the final state
 * before recording anything:
 *   - agent_task_runs_operation_refs_check includes PERSONAL_RESEARCH
 *     (the 0048 widening, the last change to that constraint).
 *   - trip_preference_card_views exists (the 0060 table).
 *   - audit_action enum is the post-0049 renamed version.
 *
 * If any check fails, the script aborts without writing to
 * schema_migrations — investigate the schema drift first.
 *
 * Usage:
 *   DATABASE_URL=postgres://travelagent:travelagent@127.0.0.1:5432/travelagent \
 *     tsx scripts/sync-migrations-ledger.ts
 */
import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(`preflight failed: ${message}`);
  }
}

async function preflight(sql: postgres.Sql): Promise<void> {
  // Final constraint (post-0048) admits PERSONAL_RESEARCH.
  const constraintRows = await sql<{ def: string }[]>`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'agent_task_runs'
      AND c.conname = 'agent_task_runs_operation_refs_check'
  `;
  assert(
    constraintRows[0]?.def.includes("PERSONAL_RESEARCH"),
    `agent_task_runs_operation_refs_check does not include PERSONAL_RESEARCH — schema is not at post-0048 state.\n  current: ${constraintRows[0]?.def}`,
  );

  // 0060 creates this table.
  const tableRows = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'trip_preference_card_views'
  `;
  assert(tableRows.length === 1, "trip_preference_card_views missing — schema is not at post-0060 state");

  // 0049 renames audit_action. Legacy type must be gone.
  const enumRows = await sql`
    SELECT typname FROM pg_type WHERE typname IN ('audit_action', 'audit_action_legacy')
  `;
  const names = enumRows.map(r => r.typname);
  assert(
    names.includes("audit_action") && !names.includes("audit_action_legacy"),
    `audit_action enum in unexpected state: ${names.join(", ")}`,
  );
}

async function main(): Promise<void> {
  const sql = postgres(url!);
  try {
    await preflight(sql);

    const allFiles = (await readdir(migrationsDir))
      .filter(name => /^\d{4}_.*\.sql$/.test(name) && !name.endsWith(".down.sql"))
      .sort();

    const recorded = await sql<{ filename: string }[]>`
      SELECT filename FROM schema_migrations
    `;
    const recordedSet = new Set(recorded.map(r => r.filename));

    const missing = allFiles.filter(f => !recordedSet.has(f));
    if (missing.length === 0) {
      console.log("ledger already in sync — nothing to record");
      return;
    }

    console.log(`preflight passed; recording ${missing.length} migrations:`);
    for (const f of missing) console.log(`  + ${f}`);

    const inserted = await sql<{ filename: string }[]>`
      INSERT INTO schema_migrations (filename)
      SELECT * FROM unnest(${missing}::text[])
      ON CONFLICT (filename) DO NOTHING
      RETURNING filename
    `;
    console.log(`recorded ${inserted.length} migrations`);
  } finally {
    await sql.end();
  }
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
