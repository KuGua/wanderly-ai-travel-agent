import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL ??
  `postgres://${process.env.DB_USER ?? "travelagent"}:${process.env.DB_PASSWORD ?? "travelagent"}@${process.env.DB_HOST ?? "127.0.0.1"}:${process.env.DB_PORT ?? "5432"}/${process.env.DB_NAME ?? "travelagent"}`;

// Vitest gives each test file its own module registry, so this module — and the
// pool below with it — is rebuilt once per test file and the previous pool's
// sockets are never closed. Across the suite that climbs monotonically: a full
// local run peaks at 95 of postgres:16's 100 connections, and CI, which also
// reserves superuser slots, tips over into "sorry, too many clients already"
// and fails whichever unrelated tests happen to run last.
//
// `idle_timeout` (seconds) is what breaks the accumulation: a finished file's
// connection is reclaimed instead of held for the rest of the run, and pooled
// connections reopen on demand, so nothing observable changes. Test-only —
// the long-lived server wants its default pool.
const queryClient = process.env.NODE_ENV === "test"
  ? postgres(connectionString, { max: 4, idle_timeout: 1 })
  : postgres(connectionString);

export const db = drizzle(queryClient, { schema });
export const rawDb = queryClient;
export function createDedicatedDatabaseClient() {
  return postgres(connectionString, { max: 1 });
}
export type DB = typeof db;
