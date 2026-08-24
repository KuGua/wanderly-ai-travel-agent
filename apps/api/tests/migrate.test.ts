import { describe, expect, it, beforeEach } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../src/db/migrate.js";

function buildConnectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.DB_USER ?? "travelagent";
  const password = process.env.DB_PASSWORD ?? "travelagent";
  const host = process.env.DB_HOST ?? "127.0.0.1";
  const port = process.env.DB_PORT ?? "5432";
  const database = process.env.DB_NAME ?? "travelagent";
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

describe("migration runner", () => {
  beforeEach(async () => {
    const conn = buildConnectionString();
    const client = postgres(conn, { max: 1 });
    try {
      await client`DROP TABLE IF EXISTS schema_migrations`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("applies all migrations on first run and is idempotent on the second", async () => {
    const conn = buildConnectionString();
    const first = await runMigrations(conn);
    expect(first.length).toBeGreaterThanOrEqual(4);
    const second = await runMigrations(conn);
    expect(second).toEqual([]);
  });
});