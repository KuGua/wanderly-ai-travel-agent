import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL ??
  `postgres://${process.env.DB_USER ?? "travelagent"}:${process.env.DB_PASSWORD ?? "travelagent"}@${process.env.DB_HOST ?? "127.0.0.1"}:${process.env.DB_PORT ?? "5432"}/${process.env.DB_NAME ?? "travelagent"}`;

const queryClient = postgres(connectionString);

export const db = drizzle(queryClient, { schema });
export type DB = typeof db;
