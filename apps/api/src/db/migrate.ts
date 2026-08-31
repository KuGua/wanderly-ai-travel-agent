import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

function buildConnectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.DB_USER ?? "travelagent";
  const password = process.env.DB_PASSWORD ?? "travelagent";
  const host = process.env.DB_HOST ?? "127.0.0.1";
  const port = process.env.DB_PORT ?? "5432";
  const database = process.env.DB_NAME ?? "travelagent";
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

export async function runMigrations(connectionString: string = buildConnectionString()): Promise<string[]> {
  const client = postgres(connectionString, { max: 1 });
  const applied: string[] = [];

  try {
    await client`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    const files = (await readdir(migrationsDir))
      .filter(name => /^\d{4}_.*\.sql$/.test(name) && !name.endsWith(".down.sql"))
      .sort();

    for (const file of files) {
      const existing = await client<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM schema_migrations WHERE filename = ${file}
      `;
      if (existing[0]?.count !== "0") continue;

      const body = await readFile(join(migrationsDir, file), "utf8");
      await client.begin(async tx => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations(filename) VALUES (${file})`;
      });
      applied.push(file);
      console.log(`[migrate] applied ${file}`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }

  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(files => {
      if (files.length === 0) {
        console.log("[migrate] schema already up to date");
      }
      process.exit(0);
    })
    .catch(err => {
      console.error("[migrate] failed:", err);
      process.exit(1);
    });
}
