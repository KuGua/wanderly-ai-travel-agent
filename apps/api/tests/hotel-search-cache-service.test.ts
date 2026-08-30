import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  constraintSnapshots,
  providerSearchCache,
  providerOffers,
  providerSearchRuns,
  sharedTrips,
  tripMembers,
  users,
} from "../src/db/schema.js";
import type { HotelProvider } from "../src/providers/types.js";
import {
  buildHotelSearchFingerprint,
  executeAndPersistHotelSearch,
  HotelSearchAlreadyAttemptedError,
} from "../src/services/hotel-search-service.js";
import { createRequestContext } from "../src/utils/context.js";

describe("hotel-search-service cache and dedupe", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;
  let taskId: string;
  let destinationId: string;
  let fingerprint: string;

  const snapshot = {
    authorizedData: {},
    departureCities: ["Shanghai"],
    destinationCandidates: [] as string[],
    travelDateStart: "2026-09-15",
    travelDateEnd: "2026-09-18",
  };
  const preferences = { roomCount: 1, adultsPerRoom: [2], currency: "USD" };

  beforeEach(async () => {
    destinationId = `hotel-cache-${randomUUID()}`;
    snapshot.destinationCandidates = [destinationId];
    const [user] = await db.insert(users).values({
      externalId: `hotel-cache-${randomUUID()}`,
      displayName: "Hotel cache test",
    }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Hotel cache trip",
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
      authorizedData: {},
      departureCities: snapshot.departureCities,
      destinationCandidates: snapshot.destinationCandidates,
      travelDateStart: snapshot.travelDateStart,
      travelDateEnd: snapshot.travelDateEnd,
    }).returning();
    snapshotId = storedSnapshot.id;
    taskId = await createTask();
    fingerprint = buildHotelSearchFingerprint({
      destinationId,
      destinationReference: {
        destinationId,
        cityName: "Tokyo",
        countryCode: "JP",
        latitude: 35.6812,
        longitude: 139.7671,
      },
      checkIn: snapshot.travelDateStart,
      checkOut: snapshot.travelDateEnd,
      preferences,
      locale: "en",
    });
  });

  afterEach(async () => {
    await db.delete(providerSearchCache).where(eq(providerSearchCache.requestFingerprint, fingerprint));
    await db.delete(providerOffers).where(eq(providerOffers.snapshotId, snapshotId));
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId));
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("reuses unexpired normalized evidence across runs and rejects a duplicate call in one run", async () => {
    const provider = liveProvider();
    const first = await search(provider, taskId);
    expect(first.outcome).toBe("LIVE");

    await expect(search(provider, taskId)).rejects.toBeInstanceOf(HotelSearchAlreadyAttemptedError);

    await finishTask(taskId);
    const secondTaskId = await createTask();
    const second = await search(provider, secondTaskId);

    expect(second.outcome).toBe("LIVE");
    expect(provider.searchHotels).toHaveBeenCalledTimes(1);
    if (first.outcome === "LIVE" && second.outcome === "LIVE") {
      expect(second.queryId).not.toBe(first.queryId);
      expect(second.data[0].queryId).toBe(second.queryId);
      expect(second.data[0].providerOfferId).toBe(first.data[0].providerOfferId);
    }
    const runs = await db.select().from(providerSearchRuns).where(and(
      eq(providerSearchRuns.snapshotId, snapshotId),
      eq(providerSearchRuns.category, "hotel"),
    ));
    expect(runs).toHaveLength(2);
  });

  it("briefly caches an unavailable outcome instead of spending quota repeatedly", async () => {
    const provider: HotelProvider = {
      searchHotels: vi.fn(async () => ({ outcome: "UNAVAILABLE", reason: "RATE_LIMITED" as const })),
    };
    await expect(search(provider, taskId)).resolves.toEqual({ outcome: "UNAVAILABLE", reason: "RATE_LIMITED" });

    await finishTask(taskId);
    const secondTaskId = await createTask();
    await expect(search(provider, secondTaskId)).resolves.toEqual({ outcome: "UNAVAILABLE", reason: "RATE_LIMITED" });
    expect(provider.searchHotels).toHaveBeenCalledTimes(1);
  });

  async function createTask(): Promise<string> {
    const id = randomUUID();
    await db.insert(agentTaskRuns).values({
      id,
      operation: "PLAN",
      status: "RUNNING",
      createdByUserId: userId,
      tripId,
      snapshotId,
      flightSearchPreferencesVersion: 1,
      staySearchPreferencesVersion: 1,
      requestId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    return id;
  }

  async function finishTask(id: string): Promise<void> {
    await db.update(agentTaskRuns).set({ status: "COMPLETED", finishedAt: new Date() })
      .where(eq(agentTaskRuns.id, id));
  }

  function search(provider: HotelProvider, agentTaskRunId: string) {
    return executeAndPersistHotelSearch({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId,
      snapshotId,
      agentTaskRunId,
      snapshot,
      preferences,
      locale: "en",
      input: { snapshotId, destinationId },
      provider,
      resolveDestinationReference: async () => ({
        destinationId,
        cityName: "Tokyo",
        countryCode: "JP",
        latitude: 35.6812,
        longitude: 139.7671,
      }),
    });
  }

  function liveProvider(): HotelProvider {
    return {
      searchHotels: vi.fn(async () => {
        const capturedAt = new Date().toISOString();
        return {
          outcome: "LIVE" as const,
          source: "SerpApi Google Hotels",
          capturedAt,
          data: [{
            providerOfferId: "offer-1",
            providerName: "serpapi_google_hotels" as const,
            destinationId,
            propertyId: "property-1",
            propertyName: "Cached Hotel",
            checkIn: snapshot.travelDateStart,
            checkOut: snapshot.travelDateEnd,
            nights: 3,
            roomCount: 1,
            adultsPerRoom: [2],
            totalPrice: 360,
            pricePerNight: 120,
            currency: "USD",
            taxesAndFees: { status: "UNKNOWN" as const },
            cancellationSummary: null,
            roomSummary: null,
            source: "SerpApi Google Hotels" as const,
            capturedAt,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          }],
        };
      }),
    };
  }
});
