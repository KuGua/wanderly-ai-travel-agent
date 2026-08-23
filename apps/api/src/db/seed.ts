import { db } from "./database.js";
import { users, userProfiles } from "../db/schema.js";
import { DEMO_USERS, DEMO_PROFILES } from "../providers/fixtures.js";

async function seed() {
  console.log("Seeding database...");

  // Create demo users
  for (const demoUser of DEMO_USERS) {
    const [user] = await db.insert(users).values({
      externalId: demoUser.externalId,
      displayName: demoUser.displayName,
    }).returning();

    console.log(`Created user: ${user.displayName} (${user.id})`);

    // Create profile
    const profileData = DEMO_PROFILES[demoUser.externalId as keyof typeof DEMO_PROFILES];
    if (profileData) {
      await db.insert(userProfiles).values({
        userId: user.id,
        ...profileData,
      });
      console.log(`Created profile for: ${user.displayName}`);
    }
  }

  console.log("Seed completed successfully");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
