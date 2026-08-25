import { eq } from "drizzle-orm";
import { db } from "./database.js";
import { users, userProfiles } from "../db/schema.js";
import { DEMO_USERS, DEMO_PROFILES } from "../providers/fixtures.js";

async function upsertUserByExternalId(externalId: string, displayName: string) {
  const inserted = await db.insert(users)
    .values({ externalId, displayName })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  if (inserted.length > 0) return inserted[0];
  const [existing] = await db.select().from(users)
    .where(eq(users.externalId, externalId))
    .limit(1);
  if (!existing) {
    throw new Error(`Failed to provision demo user ${externalId}`);
  }
  return existing;
}

async function seed() {
  console.log("Seeding database...");

  // Create or fetch demo users — second run is a no-op.
  for (const demoUser of DEMO_USERS) {
    const user = await upsertUserByExternalId(demoUser.externalId, demoUser.displayName);
    console.log(`Ensured user: ${user.displayName} (${user.id})`);

    // Create or keep the seeded profile. Profiles are keyed by the unique
    // user_id, so the second run will skip the insert and the existing row
    // is preserved (seed never silently overwrites a profile edited via API).
    const profileData = DEMO_PROFILES[demoUser.externalId as keyof typeof DEMO_PROFILES];
    if (!profileData) continue;

    const insertedProfile = await db.insert(userProfiles)
      .values({ userId: user.id, ...profileData })
      .onConflictDoNothing({ target: userProfiles.userId })
      .returning();

    if (insertedProfile.length > 0) {
      console.log(`Created profile for: ${user.displayName}`);
    } else {
      console.log(`Profile already exists for: ${user.displayName}`);
    }
  }

  console.log("Seed completed successfully");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
