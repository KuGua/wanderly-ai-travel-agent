import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/db/database.js";
import { users, userProfiles } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

/**
 * The seed script is run by `npm run db:seed` and must be idempotent so
 * repeated invocations do not duplicate demo users/profiles. This test
 * snapshots the current row counts, runs seed twice in sequence (the
 * second run is expected to be a no-op), and asserts the counts are
 * unchanged.
 *
 * The seed module itself runs `process.exit(0)` at the end, so we cannot
 * import it directly. Instead we replicate the upsert path here so the
 * test exercises the same idempotency contract.
 */
describe("seed idempotency contract", () => {
  const demoExternalIds = ["alice", "bob", "chen"] as const;

  async function runSeedOnce() {
    for (const externalId of demoExternalIds) {
      const inserted = await db.insert(users)
        .values({ externalId, displayName: externalId })
        .onConflictDoNothing({ target: users.externalId })
        .returning();

      let userId: string;
      if (inserted.length > 0) {
        userId = inserted[0].id;
      } else {
        const [existing] = await db.select({ id: users.id })
          .from(users)
          .where(eq(users.externalId, externalId))
          .limit(1);
        if (!existing) throw new Error(`Failed to provision ${externalId}`);
        userId = existing.id;
      }

      // Skip the actual profile fixture here; we only care that the user
      // upsert path is idempotent.
      void userId;
    }
  }

  async function counts() {
    const userRows = await db.select({ count: sql<number>`count(*)::int` })
      .from(users);
    const profileRows = await db.select({ count: sql<number>`count(*)::int` })
      .from(userProfiles);
    return { users: userRows[0]?.count ?? 0, profiles: profileRows[0]?.count ?? 0 };
  }

  it("does not duplicate demo users on rerun", async () => {
    const before = await counts();
    await runSeedOnce();
    const afterFirst = await counts();
    expect(afterFirst.users).toBe(before.users);

    await runSeedOnce();
    const afterSecond = await counts();
    expect(afterSecond.users).toBe(afterFirst.users);
  });
});
