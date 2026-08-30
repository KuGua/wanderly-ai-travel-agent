import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import { auditEvents, sharedTrips, tripMembers, tripConstraintFacts, users } from "../src/db/schema.js";
import { MemoryFieldRejectedError } from "../src/services/preference-fact-service.js";
import {
  TripMembershipError,
  deleteTripMemory,
  listGroupDecisions,
  listOverridesForOwner,
  saveGroupDecision,
  saveOverride,
} from "../src/services/trip-memory-service.js";

const ctx = { correlationId: "00000000-0000-4000-8000-0000000000cc", actorUserId: undefined } as never;

let aliceId: string;
let bobId: string;
let outsiderId: string;
let tripOne: string;
let tripTwo: string;

async function ensureUser(externalId: string): Promise<string> {
  const [created] = await db.insert(users)
    .values({ externalId, displayName: externalId })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  if (created) return created.id;
  const [existing] = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
  return existing!.id;
}

async function cleanup() {
  const trips = [tripOne, tripTwo].filter(Boolean);
  const ids = [aliceId, bobId, outsiderId].filter(Boolean);
  // Audit rows carry a trip FK, so they go before the trips they reference.
  if (ids.length > 0) await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, ids));
  if (trips.length > 0) {
    await db.delete(auditEvents).where(inArray(auditEvents.tripId, trips));
    await db.delete(tripConstraintFacts).where(inArray(tripConstraintFacts.tripId, trips));
    await db.delete(tripMembers).where(inArray(tripMembers.tripId, trips));
    await db.delete(sharedTrips).where(inArray(sharedTrips.id, trips));
  }
}

async function createTrip(name: string, memberIds: string[]): Promise<string> {
  const [trip] = await db.insert(sharedTrips).values({
    name,
    createdBy: memberIds[0],
    departureCities: ["Shanghai"],
    destinationCandidates: ["Tokyo", "Kyoto"],
  }).returning();
  await db.insert(tripMembers).values(
    memberIds.map((userId, index) => ({
      tripId: trip.id,
      userId,
      role: index === 0 ? "CREATOR" : "MEMBER",
    })),
  );
  return trip.id;
}

beforeAll(async () => {
  aliceId = await ensureUser("trip-memory-alice");
  bobId = await ensureUser("trip-memory-bob");
  outsiderId = await ensureUser("trip-memory-outsider");
});

afterAll(cleanup);

beforeEach(async () => {
  await cleanup();
  tripOne = await createTrip("Trip One", [aliceId, bobId]);
  tripTwo = await createTrip("Trip Two", [aliceId]);
});

describe("membership authorization", () => {
  it("refuses a non-member trying to read", async () => {
    await expect(listOverridesForOwner(tripOne, outsiderId))
      .rejects.toBeInstanceOf(TripMembershipError);
    await expect(listGroupDecisions(tripOne, outsiderId))
      .rejects.toBeInstanceOf(TripMembershipError);
  });

  it("refuses a non-member trying to write", async () => {
    await expect(saveOverride({
      ctx, tripId: tripOne, userId: outsiderId, fieldKey: "trip_pace", value: "packed",
    })).rejects.toBeInstanceOf(TripMembershipError);
  });
});

describe("personal overrides", () => {
  it("stores a member's own override for this trip", async () => {
    const fact = await saveOverride({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "packed",
    });

    expect(fact).toMatchObject({ kind: "PERSONAL_OVERRIDE", value: "packed", status: "ACTIVE" });
    expect(await listOverridesForOwner(tripOne, aliceId)).toHaveLength(1);
  });

  it("supersedes rather than updating in place", async () => {
    await saveOverride({ ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "packed" });
    await saveOverride({ ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "relaxed" });

    const active = await listOverridesForOwner(tripOne, aliceId);
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("relaxed");

    const all = await db.select().from(tripConstraintFacts)
      .where(and(eq(tripConstraintFacts.tripId, tripOne), eq(tripConstraintFacts.ownerUserId, aliceId)));
    expect(all).toHaveLength(2);
  });

  it("keeps one member's override invisible to another", async () => {
    await saveOverride({ ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "packed" });
    expect(await listOverridesForOwner(tripOne, bobId)).toHaveLength(0);
  });

  it("does not leak an override into another trip", async () => {
    await saveOverride({ ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "packed" });
    expect(await listOverridesForOwner(tripTwo, aliceId)).toHaveLength(0);
  });

  it("lets two members hold different overrides for the same field", async () => {
    await saveOverride({ ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "packed" });
    await saveOverride({ ctx, tripId: tripOne, userId: bobId, fieldKey: "trip_pace", value: "relaxed" });

    expect((await listOverridesForOwner(tripOne, aliceId))[0].value).toBe("packed");
    expect((await listOverridesForOwner(tripOne, bobId))[0].value).toBe("relaxed");
  });

  it("refuses a sensitive field", async () => {
    await expect(saveOverride({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "nationality", value: "Singapore",
    })).rejects.toBeInstanceOf(MemoryFieldRejectedError);
  });

  it("refuses a value outside the field schema", async () => {
    await expect(saveOverride({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "sprint",
    })).rejects.toBeInstanceOf(MemoryFieldRejectedError);
  });
});

describe("group decisions", () => {
  it("is visible to every active member of the trip", async () => {
    await saveGroupDecision({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "accommodation_style", value: "budget",
    });

    expect(await listGroupDecisions(tripOne, aliceId)).toHaveLength(1);
    expect(await listGroupDecisions(tripOne, bobId)).toHaveLength(1);
  });

  it("holds one active decision per field for the whole trip", async () => {
    await saveGroupDecision({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "accommodation_style", value: "budget",
    });
    await saveGroupDecision({
      ctx, tripId: tripOne, userId: bobId, fieldKey: "accommodation_style", value: "luxury",
    });

    const active = await listGroupDecisions(tripOne, aliceId);
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("luxury");
  });

  it("does not leak into another trip", async () => {
    await saveGroupDecision({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "accommodation_style", value: "budget",
    });
    expect(await listGroupDecisions(tripTwo, aliceId)).toHaveLength(0);
  });

  it("refuses a field that is personal-only", async () => {
    // Interests are individual; they are not the group's to decide.
    await expect(saveGroupDecision({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "interests", value: ["art"],
    })).rejects.toBeInstanceOf(MemoryFieldRejectedError);
  });

  it("refuses a sensitive field", async () => {
    await expect(saveGroupDecision({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "date_of_birth", value: "1990-01-01",
    })).rejects.toBeInstanceOf(MemoryFieldRejectedError);
  });
});

describe("deletion", () => {
  it("removes the whole version chain so no value survives", async () => {
    await saveOverride({ ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "packed" });
    const latest = await saveOverride({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "relaxed",
    });

    expect(await deleteTripMemory({ ctx, tripId: tripOne, userId: aliceId, factId: latest.id })).toBe(true);

    const remaining = await db.select().from(tripConstraintFacts)
      .where(and(eq(tripConstraintFacts.tripId, tripOne), eq(tripConstraintFacts.ownerUserId, aliceId)));
    expect(remaining).toHaveLength(0);
  });

  it("will not delete another member's override", async () => {
    const fact = await saveOverride({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "packed",
    });
    expect(await deleteTripMemory({ ctx, tripId: tripOne, userId: bobId, factId: fact.id })).toBe(false);
    expect(await listOverridesForOwner(tripOne, aliceId)).toHaveLength(1);
  });

  it("will not delete across trips", async () => {
    const fact = await saveOverride({
      ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "packed",
    });
    expect(await deleteTripMemory({ ctx, tripId: tripTwo, userId: aliceId, factId: fact.id })).toBe(false);
  });
});

describe("coexistence with team-orchestration constraints", () => {
  it("lets a member constraint and a group decision share one trip and field", async () => {
    // The pre-existing active-unique index is (trip, owner, field); the group
    // decision adds (trip, field) for its own kind only. Both must fit.
    await db.insert(tripConstraintFacts).values({
      tripId: tripOne,
      ownerUserId: aliceId,
      fieldKey: "accommodation_style",
      valueJson: { value: "luxury" },
      valueHash: "coexist-fixture",
      strength: "HARD",
      visibility: "TEAM_VISIBLE",
      kind: "MEMBER_CONSTRAINT",
      revision: 1,
      status: "ACTIVE",
    });

    const decision = await saveGroupDecision({
      ctx, tripId: tripOne, userId: aliceId,
      fieldKey: "accommodation_style", value: "budget",
    });

    expect(decision.value).toBe("budget");
    const rows = await db.select().from(tripConstraintFacts)
      .where(and(eq(tripConstraintFacts.tripId, tripOne), eq(tripConstraintFacts.status, "ACTIVE")));
    expect(rows).toHaveLength(2);
  });

  it("refuses to delete a team-orchestration constraint", async () => {
    const [constraint] = await db.insert(tripConstraintFacts).values({
      tripId: tripOne,
      ownerUserId: aliceId,
      fieldKey: "trip_pace",
      valueJson: { value: "relaxed" },
      valueHash: "not-ours",
      strength: "HARD",
      visibility: "TEAM_VISIBLE",
      kind: "MEMBER_CONSTRAINT",
      revision: 1,
      status: "ACTIVE",
    }).returning();

    // That row belongs to the orchestration flow, not to memory.
    expect(await deleteTripMemory({
      ctx, tripId: tripOne, userId: aliceId, factId: constraint.id,
    })).toBe(false);
  });

  it("keeps a member constraint out of the memory listings", async () => {
    await db.insert(tripConstraintFacts).values({
      tripId: tripOne,
      ownerUserId: aliceId,
      fieldKey: "trip_pace",
      valueJson: { value: "relaxed" },
      valueHash: "invisible",
      strength: "HARD",
      visibility: "TEAM_VISIBLE",
      kind: "MEMBER_CONSTRAINT",
      revision: 1,
      status: "ACTIVE",
    });

    expect(await listOverridesForOwner(tripOne, aliceId)).toHaveLength(0);
    expect(await listGroupDecisions(tripOne, aliceId)).toHaveLength(0);
  });
});

describe("telemetry redaction", () => {
  it("never records the value in the audit trail", async () => {
    await saveOverride({ ctx, tripId: tripOne, userId: aliceId, fieldKey: "trip_pace", value: "packed" });

    const events = await db.select().from(auditEvents).where(eq(auditEvents.actorUserId, aliceId));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("packed");
    expect(serialized).toContain("TRIP_MEMORY_UPDATE");
  });
});
