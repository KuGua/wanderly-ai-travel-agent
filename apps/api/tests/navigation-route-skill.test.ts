import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { __resetRegistryForTests, invokeSkill, registerSkill } from "../src/agents/skill-registry.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { createNavigationRouteSkill } from "../src/skills/shared/navigation-route-skill.js";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  constraintSnapshots,
  navigationRouteEvidence,
  providerSearchRuns,
  sharedTrips,
  tripMembers,
  tripPlaces,
  users,
} from "../src/db/schema.js";
import { createRequestContext } from "../src/utils/context.js";
import type { NavigationProvider, NormalizedRouteEvidence, ProviderResult } from "../src/providers/types.js";

const SNAPSHOT_DATA = {
  authorizedData: {},
  departureCities: ["Shanghai"],
  destinationCandidates: ["tokyo"],
};

const ORIGIN_ID = "11111111-1111-4111-8111-111111111111";
const DEST_ID = "22222222-2222-4222-8222-222222222222";

function liveProvider(): NavigationProvider {
  return {
    async searchRoute(): Promise<ProviderResult<NormalizedRouteEvidence>> {
      return {
        outcome: "LIVE",
        data: {
          originPlaceId: ORIGIN_ID,
          destinationPlaceId: DEST_ID,
          mode: "WALK",
          distanceMeters: 1500,
          durationSeconds: 600,
          steps: [
            { index: 0, instruction: "head north", distanceMeters: 800, durationSeconds: 300 },
            { index: 1, instruction: "turn right", distanceMeters: 700, durationSeconds: 300 },
          ],
          encodedGeometry: "[[0,0],[0.01,0]]",
          source: "ORS Directions",
          capturedAt: "2026-08-28T00:00:00.000Z",
          refreshAfter: "2026-08-29T00:00:00.000Z",
        },
        source: "ORS Directions",
        capturedAt: "2026-08-28T00:00:00.000Z",
      };
    },
  };
}

function unavailableProvider(): NavigationProvider {
  return {
    async searchRoute(): Promise<ProviderResult<NormalizedRouteEvidence>> {
      return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
    },
  };
}

describe("navigation.route Shared Skill", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;

  beforeEach(async () => {
    __resetRegistryForTests();
    const [user] = await db.insert(users).values({ externalId: `nav-skill-${randomUUID()}`, displayName: "Nav skill test" }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({ name: "Nav skill trip", createdBy: userId, ...SNAPSHOT_DATA }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [snapshot] = await db.insert(constraintSnapshots).values({ tripId, version: 1, ...SNAPSHOT_DATA }).returning();
    snapshotId = snapshot.id;
    // Two ACTIVE TripPlaces that the route will reference.
    await db.insert(tripPlaces).values([
      {
        id: ORIGIN_ID, tripId, ownerUserId: userId, version: 1,
        visibility: "TEAM_VISIBLE", status: "ACTIVE", kind: "ATTRACTION",
        displayName: "Origin", countryCode: "JP", cityName: "Tokyo",
        longitude: 139.79, latitude: 35.71,
        source: "ORS Geocoding", capturedAt: new Date(),
      },
      {
        id: DEST_ID, tripId, ownerUserId: userId, version: 1,
        visibility: "TEAM_VISIBLE", status: "ACTIVE", kind: "RESTAURANT",
        displayName: "Dest", countryCode: "JP", cityName: "Tokyo",
        longitude: 139.80, latitude: 35.72,
        source: "ORS Geocoding", capturedAt: new Date(),
      },
    ]);
    registerSkill(createNavigationRouteSkill(liveProvider()));
  });

  afterEach(async () => {
    await db.delete(auditEvents).where(or(eq(auditEvents.tripId, tripId), eq(auditEvents.actorUserId, userId)));
    await db.delete(navigationRouteEvidence).where(eq(navigationRouteEvidence.tripId, tripId));
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
      navigation: { tripId, snapshotId },
      policyGate: new DefaultPolicyGate(agent),
    };
  }

  function request(overrides: Record<string, unknown> = {}) {
    return {
      snapshotId,
      originPlaceId: ORIGIN_ID,
      destinationPlaceId: DEST_ID,
      mode: "WALK" as const,
      ...overrides,
    };
  }

  it("returns LIVE summary and persists provider_search_runs + navigation_route_evidence", async () => {
    const output = await invokeSkill("navigation.route", context(), request());
    expect(output).toMatchObject({
      outcome: "LIVE",
      summary: expect.objectContaining({
        originPlaceId: ORIGIN_ID,
        destinationPlaceId: DEST_ID,
        mode: "WALK",
        distanceMeters: 1500,
        stepCount: 2,
      }),
    });
    const runs = await db.select().from(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    expect(runs).toHaveLength(1);
    expect(runs[0].category).toBe("navigation");
    const evidence = await db.select().from(navigationRouteEvidence).where(eq(navigationRouteEvidence.tripId, tripId));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].mode).toBe("WALK");
    expect(evidence[0].distanceMeters).toBe(1500);
  });

  it("denies personal and review agents", async () => {
    await expect(invokeSkill("navigation.route", context("personal"), request())).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
    await expect(invokeSkill("navigation.route", context("review"), request())).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
  });

  it("rejects mismatched snapshotId", async () => {
    await expect(invokeSkill("navigation.route", context(), request({ snapshotId: randomUUID() })))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("rejects origin equal to destination", async () => {
    await expect(invokeSkill("navigation.route", context(), { ...request(), originPlaceId: DEST_ID }))
      .rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("rejects modes outside the allow-list", async () => {
    await expect(invokeSkill("navigation.route", context(), { ...request(), mode: "BUS" }))
      .rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("returns UNAVAILABLE without writing route evidence", async () => {
    __resetRegistryForTests();
    registerSkill(createNavigationRouteSkill(unavailableProvider()));
    const output = await invokeSkill("navigation.route", context(), request());
    expect(output).toMatchObject({ outcome: "UNAVAILABLE", code: "NOT_CONFIGURED" });
    const evidence = await db.select().from(navigationRouteEvidence).where(eq(navigationRouteEvidence.tripId, tripId));
    expect(evidence).toHaveLength(0);
  });
});