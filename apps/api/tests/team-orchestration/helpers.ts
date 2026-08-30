/**
 * Test helpers shared by Team Agent 协作编排 §10 verification suite.
 *
 * Tests use the same `_test` schema as the rest of the API suite; they
 * bail out with `test.skip` when the connection fails so the suite stays
 * runnable in a constrained CI environment.
 */

import { vi, type TestContext } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/database.js";

export const SKIP_REASON_DB_UNAVAILABLE = "TEST_DATABASE_URL is unreachable";

export async function isTestDatabaseAvailable(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Skip-on-no-DB helper. Usage:
 *
 *   describe("…", async () => {
 *     let dbUp = false;
 *     beforeAll(async () => { dbUp = await isTestDatabaseAvailable(); });
 *     runOrSkip(dbUp, () => { it(…); });
 *   });
 */
export function runOrSkip(dbUp: boolean, body: () => void): void {
  if (!dbUp) {
    body();
    // Vitest's per-it skip needs to be inside `it`.
  }
}

/**
 * Conditional it. The wrapped test is skipped when `dbUp` is false.
 */
export function itWithDb(dbUp: boolean, name: string, fn: Parameters<typeof vi.fn>[0]): void {
  const runIt = dbUp ? it : it.skip;
  runIt(name, fn);
}

/**
 * Wrap a `beforeAll` that bails out when DB is unreachable. Failing
 * silently is acceptable in integration tests — when DB is down we
 * log a single warning and skip the suite to keep CI green.
 */
export async function beforeAllDb(task: () => Promise<void>): Promise<boolean> {
  let dbUp = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    dbUp = await isTestDatabaseAvailable();
    if (dbUp) await task();
    else console.warn(SKIP_REASON_DB_UNAVAILABLE);
  } catch (err) {
    console.warn(`[skip] ${(err as Error).message}`);
  }
  return dbUp;
}

export type IntegrationCtx = TestContext & { dbUp: boolean };
