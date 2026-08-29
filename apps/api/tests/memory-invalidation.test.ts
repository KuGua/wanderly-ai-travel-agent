import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import {
  auditEvents,
  constraintSnapshots,
  consentGrants,
  itineraryPlans,
  preferenceFacts,
  sharedTrips,
  tripMembers,
  userProfiles,
  users,
} from "../src/db/schema.js";
import { deleteFact, replaceFact } from "../src/services/preference-fact-service.js";
import { tripsDependingOnPersonalFact } from "../src/services/memory-invalidation-service.js";

const ctx = { correlationId: "00000000-0000-4000-8000-0000000000ee", actorUserId: undefined } as never;

let ownerId: string;
let profileId: string;
/** Consent covers accommodation_style; its plan must go stale. */
let consentedTrip: string;
/** Member, but no consent for the field; its plan must be left alone. */
let unconsentedTrip: string;

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
  const trips = [consentedTrip, unconsentedTrip].filter(Boolean);
  if (ownerId) {
    await db.delete(auditEvents).where(eq(auditEvents.actorUserId, ownerId));
    await db.delete(preferenceFacts).where(eq(preferenceFacts.userId, ownerId));
  }
  if (trips.length > 0) {
    await db.delete(auditEvents).where(inArray(auditEvents.tripId, trips));
    await db.delete(itineraryPlans).where(inArray(itineraryPlans.tripId, trips));
    await db.delete(constraintSnapshots).where(inArray(constraintSnapshots.tripId, trips));
    await db.delete(consentGrants).where(inArray(consentGrants.tripId, trips));
    await db.delete(tripMembers).where(inArray(tripMembers.tripId, trips));
    await db.delete(sharedTrips).where(inArray(sharedTrips.id, trips));
  }
}

/** A trip with one member and one ACTIVE plan, optionally consenting to a field. */
async function createTripWithPlan(name: string, grantedFields: string[] | null): Promise<string> {
  const [trip] = await db.insert(sharedTrips).values({
    name,
    createdBy: ownerId,
    departureCities: ["Shanghai"],
    destinationCandidates: ["Tokyo", "Kyoto"],
  }).returning();

  await db.insert(tripMembers).values({ tripId: trip.id, userId: ownerId, role: "CREATOR" });

  if (grantedFields) {
    await db.insert(consentGrants).values({
      tripId: trip.id,
      userId: ownerId,
      scope: "PROFILE_PREFERENCES",
      fieldList: grantedFields,
      granted: true,
    });
  }

  const [snapshot] = await db.insert(constraintSnapshots).values({
    tripId: trip.id,
    version: 1,
    authorizedData: {},
    departureCities: ["Shanghai"],
    destinationCandidates: ["Tokyo", "Kyoto"],
  }).returning();

  await db.insert(itineraryPlans).values({
    tripId: trip.id,
    snapshotId: snapshot.id,
    version: 1,
    status: "ACTIVE",
    planData: {},
  });

  return trip.id;
}

async function planStatus(tripId: string): Promise<string> {
  const [plan] = await db.select().from(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
  return plan.status;
}

beforeAll(async () => {
  ownerId = await ensureUser("invalidation-owner");
  const [profile] = await db.insert(userProfiles)
    .values({ userId: ownerId, displayName: "Owner" })
    .onConflictDoNothing({ target: userProfiles.userId })
    .returning();
  profileId = profile
    ? profile.id
    : (await db.select().from(userProfiles).where(eq(userProfiles.userId, ownerId)).limit(1))[0]!.id;
});

afterAll(cleanup);

beforeEach(async () => {
  await cleanup();
  consentedTrip = await createTripWithPlan("Consented", ["accommodation_style"]);
  unconsentedTrip = await createTripWithPlan("Unconsented", ["interests"]);
});

describe("tripsDependingOnPersonalFact", () => {
  it("selects only trips whose consent covers the field", async () => {
    const trips = await tripsDependingOnPersonalFact(ownerId, "accommodation_style");
    expect(trips).toContain(consentedTrip);
    expect(trips).not.toContain(unconsentedTrip);
  });

  it("treats an empty field list as covering its whole scope", async () => {
    // Failing open here would be the safe direction: better to stale a plan
    // that did not need it than to leave one running on a value that changed.
    const trip = await createTripWithPlan("WholeScope", []);
    try {
      expect(await tripsDependingOnPersonalFact(ownerId, "accommodation_style")).toContain(trip);
    } finally {
      await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, trip));
      await db.delete(constraintSnapshots).where(eq(constraintSnapshots.tripId, trip));
      await db.delete(consentGrants).where(eq(consentGrants.tripId, trip));
      await db.delete(tripMembers).where(eq(tripMembers.tripId, trip));
      await db.delete(sharedTrips).where(eq(sharedTrips.id, trip));
    }
  });

  it("ignores a revoked grant", async () => {
    await db.update(consentGrants)
      .set({ granted: false })
      .where(eq(consentGrants.tripId, consentedTrip));

    expect(await tripsDependingOnPersonalFact(ownerId, "accommodation_style"))
      .not.toContain(consentedTrip);
  });
});

describe("changing a personal fact", () => {
  it("stales the plan of a trip that was allowed to see it", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "accommodation_style", value: "budget", path: "PROFILE_FORM",
    });

    expect(await planStatus(consentedTrip)).toBe("STALE");
  });

  it("leaves an unrelated trip's plan active", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "accommodation_style", value: "budget", path: "PROFILE_FORM",
    });

    expect(await planStatus(unconsentedTrip)).toBe("ACTIVE");
  });

  it("stales on deletion as well as replacement", async () => {
    const fact = await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "accommodation_style", value: "budget", path: "PROFILE_FORM",
    });
    // Reset so the deletion is what we observe.
    await db.update(itineraryPlans)
      .set({ status: "ACTIVE", staleReason: null })
      .where(eq(itineraryPlans.tripId, consentedTrip));

    await deleteFact({ ctx, userId: ownerId, factId: fact.id });

    expect(await planStatus(consentedTrip)).toBe("STALE");
  });

  it("records the invalidation without naming the field or the trips", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "accommodation_style", value: "budget", path: "PROFILE_FORM",
    });

    const events = await db.select().from(auditEvents)
      .where(eq(auditEvents.actorUserId, ownerId));
    const invalidation = events.find((event) => event.action === "MEMORY_INVALIDATION");

    expect(invalidation).toBeDefined();
    const serialized = JSON.stringify(invalidation?.summary);
    expect(serialized).toContain("personal_fact");
    expect(serialized).not.toContain("budget");
    expect(serialized).not.toContain("accommodation_style");
  });
});
