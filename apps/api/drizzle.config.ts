import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? "travelagent",
    password: process.env.DB_PASSWORD ?? "travelagent",
    database: process.env.DB_NAME ?? "travelagent",
  },
});
