import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../src/db/database.js";
import {
  users,
  userProfiles,
  sharedTrips,
  tripMembers,
  consentGrants,
  constraintSnapshots,
  auditEvents,
  itineraryPlans,
  memberConfirmations,
  visaReadinessChecks,
} from "../src/db/schema.js";
import { buildAuthorizedData, grantConsent } from "../src/services/consent-service.js";
import { checkVisaReadiness } from "../src/services/visa-service.js";
import { createRequestContext } from "../src/utils/context.js";

const fixtureTrip = {
  departureCities: ["San Francisco", "Shanghai"],
  destinationCandidates: ["Japan", "Thailand"],
  travelDateStart: "2025-08-01",
  travelDateEnd: "2025-08-07",
};

async function setupMember(externalId: string, nationality: string | null = null) {
  const [user] = await db.insert(users)
    .values({ externalId, displayName: externalId })
    .onConflictDoNothing({ target: users.externalId })
    .returning();

  const resolved = user ?? (await db.select().from(users).where(eq(users.externalId, externalId)).limit(1))[0];
  if (!resolved) throw new Error(`Failed to provision ${externalId}`);

  if (nationality) {
    await db.insert(userProfiles)
      .values({ userId: resolved.id, nationality })
      .onConflictDoNothing({ target: userProfiles.userId });
  }
  return resolved;
}

async function setupTrip(createdBy: string) {
  const [trip] = await db.insert(sharedTrips).values({
    name: `visa-test-${randomUUID()}`,
    createdBy,
    ...fixtureTrip,
  }).returning();

  return trip;
}

async function setupSnapshot(tripId: string, memberIds: string[], authorized: Record<string, unknown>) {
  const [snap] = await db.insert(constraintSnapshots).values({
    tripId,
    version: 1,
    authorizedData: authorized,
    departureCities: fixtureTrip.departureCities,
    destinationCandidates: fixtureTrip.destinationCandidates,
    travelDateStart: fixtureTrip.travelDateStart,
    travelDateEnd: fixtureTrip.travelDateEnd,
  }).returning();
  return snap;
}

describe("visa-service authorized branch", () => {
  let aliceId: string;
  let bobId: string;
  let tripId: string;
  let snapshotId: string;
  let planId: string;

  beforeEach(async () => {
    const alice = await setupMember(`visa-alice-${randomUUID()}`, "CN");
    const bob = await setupMember(`visa-bob-${randomUUID()}`, "US");
    aliceId = alice.id;
    bobId = bob.id;

    const trip = await setupTrip(aliceId);
    tripId = trip.id;

    await db.insert(tripMembers).values([
      { tripId, userId: aliceId, role: "CREATOR", isRequired: true },
      { tripId, userId: bobId, role: "MEMBER", isRequired: true },
    ]);

    const auth: Record<string, unknown> = {};
    auth[aliceId] = { nationality: "CN" };
    auth[bobId] = { nationality: "US" };

    const snap = await setupSnapshot(tripId, [aliceId, bobId], auth);
    snapshotId = snap.id;

    const [plan] = await db.insert(itineraryPlans).values({
      tripId,
      snapshotId,
      version: 1,
      status: "ACTIVE",
      planData: {},
    }).returning();
    planId = plan.id;
  });

  afterEach(async () => {
    await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId));
    await db.delete(memberConfirmations).where(eq(memberConfirmations.tripId, tripId));
    await db.delete(visaReadinessChecks).where(eq(visaReadinessChecks.planId, planId));
    await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.tripId, tripId));
    await db.delete(consentGrants).where(eq(consentGrants.tripId, tripId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(userProfiles).where(inArray(userProfiles.userId, [aliceId, bobId]));
    await db.delete(users).where(inArray(users.id, [aliceId, bobId]));
  });

  it("reads nationality from snapshot authorizedData, not from a hardcoded value", async () => {
    const ctx = createRequestContext(aliceId, randomUUID(), randomUUID());
    await grantConsent({
      ctx,
      tripId,
      userId: aliceId,
      scope: "PROFILE_NATIONALITY",
      fieldList: ["nationality"],
    });

    const result = await checkVisaReadiness({
      planId,
      snapshotId,
      memberId: aliceId,
      tripId,
      destinationCountry: "Japan",
    });

    expect(result.status).toBe("AUTHORIZED_CHECK");
    expect(result.nationality).toBe("CN");
    expect(result.disclaimer ?? "").toContain("snapshot");
  });

  it("returns UNAUTHORIZED_NO_CHECK when the snapshot entry is missing nationality", async () => {
    const ctx = createRequestContext(bobId, randomUUID(), randomUUID());
    // Grant consent but snapshot's authorizedData has no nationality key for Bob.
    await grantConsent({
      ctx,
      tripId,
      userId: bobId,
      scope: "PROFILE_NATIONALITY",
      fieldList: ["nationality"],
    });

    // Overwrite the snapshot with no Bob entry.
    const aliceAuth = await buildAuthorizedData({ tripId, userId: aliceId });
    const newAuth: Record<string, unknown> = { [aliceId]: aliceAuth };
    await db.update(constraintSnapshots)
      .set({ authorizedData: newAuth })
      .where(eq(constraintSnapshots.id, snapshotId));

    const result = await checkVisaReadiness({
      planId,
      snapshotId,
      memberId: bobId,
      tripId,
      destinationCountry: "Japan",
    });

    expect(result.status).toBe("UNAUTHORIZED_NO_CHECK");
  });
});
