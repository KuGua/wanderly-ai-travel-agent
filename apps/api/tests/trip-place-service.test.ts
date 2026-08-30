import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  constraintSnapshots,
  itineraryPlans,
  memberConfirmations,
  navigationRouteEvidence,
  sharedTrips,
  tripMembers,
  tripPlaces,
  users,
} from "../src/db/schema.js";
import {
  PlaceNotFoundError,
  PlaceVisibilityDeniedError,
  adoptTripPlace,
  proposeTripPlace,
  revokeTripPlace,
  toTripPlace,
} from "../src/services/trip-place-service.js";
import { createRequestContext } from "../src/utils/context.js";

const SNAPSHOT_DATA = {
  authorizedData: {},
  departureCities: ["Shanghai"],
  destinationCandidates: ["tokyo"],
};

const BASE_CANDIDATE = {
  candidateId: randomUUID(),
  displayName: "Senso-ji",
  kind: "ATTRACTION" as const,
  countryCode: "JP",
  cityName: "Tokyo",
  longitude: 139.79,
  latitude: 35.71,
  confidence: 0.9,
  needsUserConfirmation: false,
  source: "ORS Geocoding",
  capturedAt: new Date().toISOString(),
};

describe("trip-place-service", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;

  beforeEach(async () => {
    const [user] = await db.insert(users).values({ externalId: `trip-place-${randomUUID()}`, displayName: "Trip place test" }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({ name: "Trip place trip", createdBy: userId, ...SNAPSHOT_DATA }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [snapshot] = await db.insert(constraintSnapshots).values({ tripId, version: 1, ...SNAPSHOT_DATA }).returning();
    snapshotId = snapshot.id;
  });

  afterEach(async () => {
    await db.delete(auditEvents).where(or(eq(auditEvents.tripId, tripId), eq(auditEvents.actorUserId, userId)));
    await db.delete(navigationRouteEvidence).where(eq(navigationRouteEvidence.tripId, tripId));
    await db.delete(memberConfirmations).where(eq(memberConfirmations.tripId, tripId));
    await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
    await db.delete(tripPlaces).where(eq(tripPlaces.tripId, tripId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("proposeTripPlace persists a PROPOSED row bound to the run", async () => {
    const ctx = createRequestContext(userId, randomUUID(), randomUUID());
    const placeId = await proposeTripPlace({
      ctx, tripId, ownerUserId: userId, snapshotId, agentTaskRunId: null,
      candidate: BASE_CANDIDATE, visibility: "TEAM_VISIBLE", kind: "ATTRACTION",
    });
    const rows = await db.select().from(tripPlaces).where(eq(tripPlaces.id, placeId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PROPOSED");
    expect(rows[0].visibility).toBe("TEAM_VISIBLE");
    expect(rows[0].kind).toBe("ATTRACTION");
    expect(rows[0].displayName).toBe("Senso-ji");
  });

  it("adoptTripPlace flips status to ACTIVE", async () => {
    const ctx = createRequestContext(userId, randomUUID(), randomUUID());
    const placeId = await proposeTripPlace({
      ctx, tripId, ownerUserId: userId, snapshotId, agentTaskRunId: null,
      candidate: BASE_CANDIDATE, visibility: "TEAM_VISIBLE", kind: "ATTRACTION",
    });
    await adoptTripPlace({ ctx, tripId, placeId });
    const rows = await db.select().from(tripPlaces).where(eq(tripPlaces.id, placeId));
    expect(rows[0].status).toBe("ACTIVE");
  });

  it("adoptTripPlace rejects OWNER_PRIVATE places", async () => {
    const ctx = createRequestContext(userId, randomUUID(), randomUUID());
    const placeId = await proposeTripPlace({
      ctx, tripId, ownerUserId: userId, snapshotId, agentTaskRunId: null,
      candidate: BASE_CANDIDATE, visibility: "OWNER_PRIVATE", kind: "ATTRACTION",
    });
    await expect(adoptTripPlace({ ctx, tripId, placeId }))
      .rejects.toBeInstanceOf(PlaceVisibilityDeniedError);
  });

  it("adoptTripPlace rejects places that belong to another trip", async () => {
    const ctx = createRequestContext(userId, randomUUID(), randomUUID());
    await expect(adoptTripPlace({ ctx, tripId, placeId: randomUUID() }))
      .rejects.toBeInstanceOf(PlaceNotFoundError);
  });

  it("revokeTripPlace flips status to REVOKED and is idempotent", async () => {
    const ctx = createRequestContext(userId, randomUUID(), randomUUID());
    const placeId = await proposeTripPlace({
      ctx, tripId, ownerUserId: userId, snapshotId, agentTaskRunId: null,
      candidate: BASE_CANDIDATE, visibility: "TEAM_VISIBLE", kind: "ATTRACTION",
    });
    await adoptTripPlace({ ctx, tripId, placeId });
    await revokeTripPlace({ ctx, tripId, placeId, reason: "user_changed_mind" });
    const first = await db.select().from(tripPlaces).where(eq(tripPlaces.id, placeId));
    expect(first[0].status).toBe("REVOKED");
    // Idempotent: revoke again is a no-op
    await revokeTripPlace({ ctx, tripId, placeId, reason: "user_changed_mind" });
    const second = await db.select().from(tripPlaces).where(eq(tripPlaces.id, placeId));
    expect(second[0].status).toBe("REVOKED");
  });

  it("toTripPlace maps the row to a TripPlace domain object", async () => {
    const ctx = createRequestContext(userId, randomUUID(), randomUUID());
    const placeId = await proposeTripPlace({
      ctx, tripId, ownerUserId: userId, snapshotId, agentTaskRunId: null,
      candidate: BASE_CANDIDATE, visibility: "TEAM_VISIBLE", kind: "ATTRACTION",
    });
    const [row] = await db.select().from(tripPlaces).where(eq(tripPlaces.id, placeId));
    const mapped = toTripPlace(row);
    expect(mapped.displayName).toBe("Senso-ji");
    expect(mapped.kind).toBe("ATTRACTION");
    expect(mapped.visibility).toBe("TEAM_VISIBLE");
    expect(mapped.status).toBe("PROPOSED");
    expect(mapped.tripId).toBe(tripId);
  });
});