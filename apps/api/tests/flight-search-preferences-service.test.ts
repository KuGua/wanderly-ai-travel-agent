import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../src/db/database.js";
import { auditEvents, constraintSnapshots, itineraryPlans, sharedTrips, tripMembers, tripSearchPreferences, users } from "../src/db/schema.js";
import { saveConfirmedSearchPreferences } from "../src/services/flight-search-preferences-service.js";
import { createRequestContext } from "../src/utils/context.js";

describe("confirmed flight search preferences", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;
  let planId: string;

  beforeEach(async () => {
    const [user] = await db.insert(users).values({ externalId: `flight-pref-${randomUUID()}`, displayName: "Flight preference test" }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Flight preference trip", createdBy: userId, departureCities: ["SFO"], destinationCandidates: ["NRT"],
      travelDateStart: "2026-10-01", travelDateEnd: "2026-10-10",
    }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [snapshot] = await db.insert(constraintSnapshots).values({
      tripId, version: 1, authorizedData: {}, departureCities: ["SFO"], destinationCandidates: ["NRT"],
      travelDateStart: "2026-10-01", travelDateEnd: "2026-10-10",
    }).returning();
    snapshotId = snapshot.id;
    const [plan] = await db.insert(itineraryPlans).values({ tripId, snapshotId, version: 1, status: "ACTIVE", planData: {} }).returning();
    planId = plan.id;
  });

  afterEach(async () => {
    await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId));
    await db.delete(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, tripId));
    await db.delete(itineraryPlans).where(eq(itineraryPlans.id, planId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("versions confirmed preferences and stales active plans", async () => {
    const ctx = createRequestContext(userId, randomUUID(), randomUUID());
    const input = { tripType: "ROUND_TRIP" as const, currency: "USD", adults: 2, cabin: "ECONOMY" as const, offerFreshnessMinutes: 30 };
    const first = await saveConfirmedSearchPreferences({ ctx, tripId, confirmedBy: userId, input });
    const second = await saveConfirmedSearchPreferences({ ctx, tripId, confirmedBy: userId, input: { ...input, cabin: "BUSINESS" } });
    expect([first.version, second.version]).toEqual([1, 2]);
    const [plan] = await db.select({ status: itineraryPlans.status, staleReason: itineraryPlans.staleReason })
      .from(itineraryPlans).where(eq(itineraryPlans.id, planId));
    expect(plan).toEqual({ status: "STALE", staleReason: "search_preferences_updated" });
  });
});
