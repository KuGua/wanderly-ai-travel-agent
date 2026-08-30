import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  constraintSnapshots,
  providerOffers,
  providerSearchCache,
  providerSearchRuns,
  sharedTrips,
  tripMembers,
  users,
} from "../src/db/schema.js";
import type { AccommodationDiscoveryProvider, ActivitiesProvider } from "../src/providers/types.js";
import {
  executeAndPersistAccommodationDiscovery,
} from "../src/services/accommodation-discovery-service.js";
import {
  ActivitiesSearchAlreadyAttemptedError,
  executeAndPersistActivitiesSearch,
} from "../src/services/activities-search-service.js";
import { createRequestContext } from "../src/utils/context.js";

describe("provider search cache integration", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;
  let taskIds: string[];

  const snapshot = {
    authorizedData: {},
    departureCities: ["Shanghai"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: "2026-09-15",
    travelDateEnd: "2026-09-18",
  };

  beforeEach(async () => {
    taskIds = [];
    const [user] = await db.insert(users).values({ externalId: `provider-cache-${randomUUID()}`, displayName: "Provider cache test" }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Provider cache trip",
      createdBy: userId,
      authorizedData: {},
      departureCities: snapshot.departureCities,
      destinationCandidates: snapshot.destinationCandidates,
    }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [storedSnapshot] = await db.insert(constraintSnapshots).values({
      tripId,
      version: 1,
      ...snapshot,
    }).returning();
    snapshotId = storedSnapshot.id;
  });

  afterEach(async () => {
    await db.delete(providerSearchCache).where(eq(providerSearchCache.providerName, "viator_mcp"));
    await db.delete(providerSearchCache).where(eq(providerSearchCache.providerName, "opentripmap"));
    await db.delete(providerOffers).where(eq(providerOffers.snapshotId, snapshotId));
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId));
    for (const id of taskIds) await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, id));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("deduplicates Viator within a run and reuses normalized evidence across runs", async () => {
    const provider: ActivitiesProvider = { searchActivities: vi.fn(async () => ({
      outcome: "LIVE" as const,
      source: "Viator Experiences MCP",
      capturedAt: new Date().toISOString(),
      data: [{
        providerOfferId: "activity-1",
        title: "Tokyo walking tour",
        thumbnailUrl: "https://example.test/activity.jpg",
        rating: 4.8,
        reviewCount: 120,
        freeCancellation: true,
        durationMinutes: { fixed: 120, from: null, to: null },
        category: "Culture",
        fromPrice: 42.5,
        currency: "USD",
      }],
    })) };
    const firstTaskId = await createTask();
    const first = await activitySearch(provider, firstTaskId);
    expect(first.outcome).toBe("LIVE");
    await expect(activitySearch(provider, firstTaskId)).rejects.toBeInstanceOf(ActivitiesSearchAlreadyAttemptedError);

    await finishTask(firstTaskId);
    const second = await activitySearch(provider, await createTask());
    expect(second.outcome).toBe("LIVE");
    expect(provider.searchActivities).toHaveBeenCalledTimes(1);
    if (first.outcome === "LIVE" && second.outcome === "LIVE") {
      expect(second.queryId).not.toBe(first.queryId);
      expect(second.data[0].queryId).toBe(second.queryId);
    }
  });

  it("resolves Tokyo locally and reuses OpenTripMap discovery across runs", async () => {
    const provider: AccommodationDiscoveryProvider = { discoverAccommodations: vi.fn(async ({ destination }) => ({
      outcome: "LIVE" as const,
      source: "OpenTripMap",
      capturedAt: new Date().toISOString(),
      data: [{
        providerPlaceId: "N123",
        name: "Tokyo Station Hotel",
        kind: "hotels",
        longitude: destination.longitude,
        latitude: destination.latitude,
        distanceMeters: 0,
        popularityTier: 3,
        source: "OpenTripMap" as const,
        attribution: "© OpenStreetMap contributors" as const,
        capturedAt: new Date().toISOString(),
      }],
    })) };
    const firstTaskId = await createTask();
    const first = await accommodationSearch(provider, firstTaskId);
    expect(first.outcome).toBe("LIVE");

    await finishTask(firstTaskId);
    const second = await accommodationSearch(provider, await createTask());
    expect(second.outcome).toBe("LIVE");
    expect(provider.discoverAccommodations).toHaveBeenCalledTimes(1);
    if (second.outcome === "LIVE") expect(second.data[0].queryId).toBe(second.queryId);
  });

  async function createTask(): Promise<string> {
    const id = randomUUID();
    taskIds.push(id);
    await db.insert(agentTaskRuns).values({
      id,
      operation: "PLAN",
      status: "RUNNING",
      createdByUserId: userId,
      tripId,
      snapshotId,
      flightSearchPreferencesVersion: 1,
      requestId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    return id;
  }

  async function finishTask(id: string): Promise<void> {
    await db.update(agentTaskRuns).set({ status: "COMPLETED", finishedAt: new Date() }).where(eq(agentTaskRuns.id, id));
  }

  function activitySearch(provider: ActivitiesProvider, agentTaskRunId: string) {
    return executeAndPersistActivitiesSearch({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId,
      snapshotId,
      agentTaskRunId,
      snapshot,
      input: { snapshotId, destinationId: "Tokyo", theme: "CULTURE", locale: "en" },
      currency: "USD",
      provider,
    });
  }

  function accommodationSearch(provider: AccommodationDiscoveryProvider, agentTaskRunId: string) {
    return executeAndPersistAccommodationDiscovery({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId,
      snapshotId,
      agentTaskRunId,
      input: { snapshotId, destinationId: "Tokyo" },
      provider,
    });
  }
});
