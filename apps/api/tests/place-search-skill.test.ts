import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { __resetRegistryForTests, invokeSkill, registerSkill } from "../src/agents/skill-registry.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { createPlaceSearchSkill } from "../src/skills/shared/place-search-skill.js";
import { createTripPlaceSkill } from "../src/skills/shared/trip-place-skill.js";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  constraintSnapshots,
  providerSearchRuns,
  sharedTrips,
  tripMembers,
  tripPlaces,
  users,
} from "../src/db/schema.js";
import { createRequestContext } from "../src/utils/context.js";
import type { NormalizedPlaceCandidate, PlaceSearchProvider, ProviderResult } from "../src/providers/types.js";

const SNAPSHOT_DATA = {
  authorizedData: {},
  departureCities: ["Shanghai"],
  destinationCandidates: ["tokyo", "osaka"],
};

function livePlaceProvider(): PlaceSearchProvider {
  const candidates: NormalizedPlaceCandidate[] = [{
    candidateId: randomUUID(),
    displayName: "Sushi Saito",
    kind: "RESTAURANT",
    countryCode: "JP",
    cityName: "Tokyo",
    longitude: 139.69,
    latitude: 35.68,
    confidence: 0.9,
    needsUserConfirmation: false,
    source: "ORS Geocoding",
    capturedAt: "2026-08-28T00:00:00.000Z",
  }];
  return {
    async searchPlaces(): Promise<ProviderResult<NormalizedPlaceCandidate[]>> {
      return {
        outcome: "LIVE",
        data: candidates,
        source: "ORS Geocoding",
        capturedAt: "2026-08-28T00:00:00.000Z",
      };
    },
  };
}

function unavailableProvider(): PlaceSearchProvider {
  return {
    async searchPlaces(): Promise<ProviderResult<NormalizedPlaceCandidate[]>> {
      return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
    },
  };
}

describe("places.search Shared Skill", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;

  beforeEach(async () => {
    __resetRegistryForTests();
    const [user] = await db.insert(users).values({ externalId: `place-skill-${randomUUID()}`, displayName: "Place skill test" }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({ name: "Place skill trip", createdBy: userId, ...SNAPSHOT_DATA }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [snapshot] = await db.insert(constraintSnapshots).values({ tripId, version: 1, ...SNAPSHOT_DATA }).returning();
    snapshotId = snapshot.id;
    registerSkill(createPlaceSearchSkill(livePlaceProvider()));
    registerSkill(createTripPlaceSkill());
  });

  afterEach(async () => {
    await db.delete(auditEvents).where(or(eq(auditEvents.tripId, tripId), eq(auditEvents.actorUserId, userId)));
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    await db.delete(tripPlaces).where(eq(tripPlaces.tripId, tripId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  function context(agent: "shared" | "personal" | "review" = "shared") {
    return {
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      snapshot: SNAPSHOT_DATA,
      placeSearch: { tripId, snapshotId },
      policyGate: new DefaultPolicyGate(agent),
    };
  }

  function request(overrides: Record<string, unknown> = {}) {
    return {
      snapshotId,
      destinationId: "tokyo",
      keyword: "sushi",
      category: "RESTAURANT" as const,
      ...overrides,
    };
  }

  it("returns LIVE candidates and persists provider_search_runs", async () => {
    const output = await invokeSkill("places.search", context(), request());
    expect(output).toMatchObject({
      outcome: "LIVE",
      candidates: [expect.objectContaining({ displayName: "Sushi Saito", kind: "RESTAURANT" })],
    });
    const runs = await db.select().from(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    expect(runs).toHaveLength(1);
    expect(runs[0].category).toBe("place");
  });

  it("denies personal and review agents", async () => {
    await expect(invokeSkill("places.search", context("personal"), request())).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
    await expect(invokeSkill("places.search", context("review"), request())).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
  });

  it("rejects destination outside snapshot candidates", async () => {
    await expect(invokeSkill("places.search", context(), request({ destinationId: "paris" })))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("rejects mismatched snapshotId", async () => {
    await expect(invokeSkill("places.search", context(), request({ snapshotId: randomUUID() })))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("rejects keywords carrying private markers", async () => {
    await expect(invokeSkill("places.search", context(), request({ keyword: "owner-only ramen" })))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("rejects unknown skills and unknown categories", async () => {
    await expect(invokeSkill("places.unknown", context(), request())).rejects.toMatchObject({ code: "UNKNOWN_SKILL" });
    await expect(invokeSkill("places.search", context(), { ...request(), category: "BUSINESS" })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("returns UNAVAILABLE without writing a trip_places row", async () => {
    __resetRegistryForTests();
    registerSkill(createTripPlaceSkill());
    registerSkill(createPlaceSearchSkill(unavailableProvider()));
    const output = await invokeSkill("places.search", context(), request());
    expect(output).toMatchObject({ outcome: "UNAVAILABLE", code: "NOT_CONFIGURED" });
    const places = await db.select().from(tripPlaces).where(eq(tripPlaces.tripId, tripId));
    expect(places).toHaveLength(0);
  });
});