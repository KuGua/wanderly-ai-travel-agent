import postgres from "postgres";

import { runMigrations } from "../src/db/migrate.js";
import {
  assertDisposableTestDatabase,
  readTestSchema,
  resolveTestDatabaseUrl,
} from "./test-database.js";

const connectionString = resolveTestDatabaseUrl();
const target = assertDisposableTestDatabase(connectionString);
const databaseName = decodeURIComponent(target.pathname.slice(1));
const schemaName = readTestSchema(target);

if (schemaName) {
  const bootstrapUrl = new URL(target);
  bootstrapUrl.searchParams.delete("options");
  const bootstrap = postgres(bootstrapUrl.toString(), { max: 1 });
  try {
    await bootstrap.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  } finally {
    await bootstrap.end({ timeout: 5 });
  }
}

const applied = await runMigrations(connectionString);
console.log(
  `[test-db] ready ${databaseName}${schemaName ? `/${schemaName}` : ""}; migrations applied: ${applied.length}`,
);
