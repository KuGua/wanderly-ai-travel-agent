import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  assertTripModeForBrief,
  getTripMode,
  loadAndAssertTripModeForBrief,
} from "../../src/services/trip-mode-service.js";
import * as schema from "../../src/db/schema.js";
import { sharedTrips, tripMembers } from "../../src/db/schema.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("trip-mode-service", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tripId: string;
  let ownerId: string;
  let userIds: string[] = [];

  beforeEach(async () => {
    client = postgres(connectionString, { max: 1 });
    db = drizzle(client, { schema });
    userIds = [];

    // Minimal trip + owner. The owner must exist in users (FK).
    ownerId = await makeUser("mode-test-owner");
    const [trip] = await db.insert(sharedTrips).values({
      name: "mode-test",
      nameSource: "AUTO",
      status: "PLANNING",
      departureCities: [],
      destinationCandidates: [],
      createdBy: ownerId,
    }).returning({ id: sharedTrips.id });
    tripId = trip!.id;
  });

  afterEach(async () => {
    if (tripId) {
      await client`DELETE FROM trip_members WHERE trip_id = ${tripId}`;
      await client`DELETE FROM shared_trips WHERE id = ${tripId}`;
    }
    for (const userId of userIds) {
      await client`DELETE FROM users WHERE id = ${userId}`;
    }
    await client.end({ timeout: 5 });
  });

  async function makeUser(suffix: string): Promise<string> {
    const [u] = await db.insert(schema.users).values({
      externalId: `mode-test-${suffix}-${Date.now()}-${Math.random()}`,
      displayName: "Mode Test User",
    }).returning({ id: schema.users.id });
    userIds.push(u!.id);
    return u!.id;
  }

  async function addMember(userId: string, isRequired: boolean): Promise<void> {
    await db.insert(tripMembers).values({
      tripId,
      userId,
      isRequired,
    });
  }

  describe("getTripMode", () => {
    it("returns SOLO when exactly one required member exists", async () => {
      const owner = await makeUser("solo-owner");
      await addMember(owner, true);
      const mode = await getTripMode(db, tripId);
      expect(mode).toBe("SOLO");
    });

    it("returns TEAM when two required members exist", async () => {
      const a = await makeUser("team-a");
      const b = await makeUser("team-b");
      await addMember(a, true);
      await addMember(b, true);
      const mode = await getTripMode(db, tripId);
      expect(mode).toBe("TEAM");
    });

    it("returns TEAM when only an optional member exists (0 required)", async () => {
      const opt = await makeUser("opt");
      await addMember(opt, false);
      const mode = await getTripMode(db, tripId);
      expect(mode).toBe("TEAM");
    });

    it("returns TEAM for a trip with no members (0 required)", async () => {
      const mode = await getTripMode(db, tripId);
      expect(mode).toBe("TEAM");
    });
  });

  describe("assertTripModeForBrief", () => {
    it.each([
      ["Tokyo"],
      ["A", "B"],
      ["A", "B", "C", "D", "E"],
    ])("accepts SOLO with %d candidate(s)", (candidates: string[]) => {
      expect(() => assertTripModeForBrief("SOLO", candidates)).not.toThrow();
    });

    it("rejects SOLO with 0 candidates", () => {
      expect(() => assertTripModeForBrief("SOLO", [])).toThrow(/RESEARCH_BRIEF_INVALID/);
    });

    it("rejects SOLO with 6 candidates", () => {
      expect(() =>
        assertTripModeForBrief("SOLO", ["A", "B", "C", "D", "E", "F"]),
      ).toThrow(/RESEARCH_BRIEF_INVALID/);
    });

    it.each([
      [["A", "B"], 2],
      [["A", "B", "C"], 3],
    ] as const)("accepts TEAM with %d candidates", (candidates: string[]) => {
      expect(() => assertTripModeForBrief("TEAM", candidates)).not.toThrow();
    });

    it("rejects TEAM with 1 candidate (must be 2+)", () => {
      expect(() => assertTripModeForBrief("TEAM", ["Solo"])).toThrow(/RESEARCH_BRIEF_INVALID/);
    });

    it("rejects TEAM with more than 3 candidates", () => {
      expect(() => assertTripModeForBrief("TEAM", ["A", "B", "C", "D"])).toThrow(/RESEARCH_BRIEF_INVALID/);
    });

    it("rejects TEAM with 0 candidates", () => {
      expect(() => assertTripModeForBrief("TEAM", [])).toThrow(/RESEARCH_BRIEF_INVALID/);
    });
  });

  describe("loadAndAssertTripModeForBrief", () => {
    it("returns SOLO and accepts 1 candidate end-to-end", async () => {
      const owner = await makeUser("e2e-solo");
      await addMember(owner, true);
      const mode = await loadAndAssertTripModeForBrief(db, tripId, ["Solo City"]);
      expect(mode).toBe("SOLO");
    });

    it("returns TEAM and rejects 1 candidate end-to-end", async () => {
      const a = await makeUser("e2e-team-a");
      const b = await makeUser("e2e-team-b");
      await addMember(a, true);
      await addMember(b, true);
      await expect(
        loadAndAssertTripModeForBrief(db, tripId, ["Solo City"]),
      ).rejects.toThrow(/RESEARCH_BRIEF_INVALID/);
    });
  });
});
