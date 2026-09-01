import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { requireResearchEligible } from "../../src/services/trip-status-guard.js";
import * as schema from "../../src/db/schema.js";
import { sharedTrips, tripMembers } from "../../src/db/schema.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("requireResearchEligible", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const userIds: string[] = [];
  const tripIds: string[] = [];

  beforeEach(async () => {
    client = postgres(connectionString, { max: 1 });
    db = drizzle(client, { schema });
  });

  afterEach(async () => {
    for (const tripId of tripIds) {
      await client`DELETE FROM trip_members WHERE trip_id = ${tripId}`;
      await client`DELETE FROM shared_trips WHERE id = ${tripId}`;
    }
    for (const userId of userIds) {
      await client`DELETE FROM users WHERE id = ${userId}`;
    }
    await client.end({ timeout: 5 });
  });

  async function makeUser(): Promise<string> {
    const [u] = await db.insert(schema.users).values({
      externalId: `guard-${Date.now()}-${Math.random()}`,
      displayName: "Guard Test User",
    }).returning({ id: schema.users.id });
    userIds.push(u!.id);
    return u!.id;
  }

  async function makeTrip(status: "DRAFT" | "PLANNING" | "STALE", ownerId: string): Promise<string> {
    const [t] = await db.insert(sharedTrips).values({
      name: "guard-test",
      nameSource: "AUTO",
      status,
      departureCities: [],
      destinationCandidates: [],
      createdBy: ownerId,
    }).returning({ id: sharedTrips.id });
    tripIds.push(t!.id);
    return t!.id;
  }

  async function addMember(tripId: string, userId: string, isRequired: boolean): Promise<void> {
    await db.insert(tripMembers).values({ tripId, userId, isRequired });
  }

  it("rejects a non-existent trip with 404", async () => {
    await expect(
      requireResearchEligible("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000", ["X"]),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("accepts a DRAFT trip — research commands are no longer gated by status", async () => {
    // Phase 2: DRAFT trips are research-eligible. `requireActiveTrip`
    // still rejects DRAFT for non-research operations (planning, consent,
    // booking, etc.), but research is the only command surface that
    // accepts pre-activation states per the product intent in §5.2.
    const owner = await makeUser();
    const tripId = await makeTrip("DRAFT", owner);
    await addMember(tripId, owner, true);
    const mode = await requireResearchEligible(tripId, owner, ["Solo City"]);
    expect(mode).toBe("SOLO");
  });

  it("rejects a non-member caller with 403", async () => {
    const owner = await makeUser();
    const intruder = await makeUser();
    const tripId = await makeTrip("PLANNING", owner);
    await addMember(tripId, owner, true);
    await expect(
      requireResearchEligible(tripId, intruder, ["Solo City"]),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/Only required members/),
    });
  });

  it("rejects an optional member with 403", async () => {
    const owner = await makeUser();
    const optional = await makeUser();
    const tripId = await makeTrip("PLANNING", owner);
    await addMember(tripId, owner, true);
    await addMember(tripId, optional, false);
    await expect(
      requireResearchEligible(tripId, optional, ["Solo City"]),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns SOLO and accepts 1 candidate for a single-required-member trip", async () => {
    const owner = await makeUser();
    const tripId = await makeTrip("PLANNING", owner);
    await addMember(tripId, owner, true);
    const mode = await requireResearchEligible(tripId, owner, ["Solo City"]);
    expect(mode).toBe("SOLO");
  });

  it("rejects SOLO with 6 candidates (RESEARCH_BRIEF_INVALID)", async () => {
    const owner = await makeUser();
    const tripId = await makeTrip("PLANNING", owner);
    await addMember(tripId, owner, true);
    await expect(
      requireResearchEligible(tripId, owner, ["A", "B", "C", "D", "E", "F"]),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/RESEARCH_BRIEF_INVALID/),
    });
  });

  it("returns TEAM and rejects 1 candidate for a multi-required-member trip", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const tripId = await makeTrip("PLANNING", a);
    await addMember(tripId, a, true);
    await addMember(tripId, b, true);
    const mode = await requireResearchEligible(tripId, a, ["A", "B"]);
    expect(mode).toBe("TEAM");
    await expect(
      requireResearchEligible(tripId, a, ["Solo City"]),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/RESEARCH_BRIEF_INVALID/),
    });
  });

  it("accepts a STALE trip", async () => {
    const owner = await makeUser();
    const tripId = await makeTrip("STALE", owner);
    await addMember(tripId, owner, true);
    const mode = await requireResearchEligible(tripId, owner, ["Solo City"]);
    expect(mode).toBe("SOLO");
  });
});