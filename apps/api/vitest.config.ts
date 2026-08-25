import { defineConfig } from "vitest/config";
import {
  assertDisposableTestDatabase,
  resolveTestDatabaseUrl,
} from "./scripts/test-database.js";

const testDatabaseUrl = resolveTestDatabaseUrl();
assertDisposableTestDatabase(testDatabaseUrl);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = "test";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    env: {
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: "test",
    },
  },
});
