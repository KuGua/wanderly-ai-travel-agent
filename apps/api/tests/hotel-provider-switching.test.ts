import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  constraintSnapshots,
  itineraryPlans,
  providerOffers,
  providerSearchCache,
  providerSearchRuns,
  sharedTrips,
  tripMembers,
  users,
} from "../src/db/schema.js";
import {
  buildHotelSearchFingerprint,
  executeAndPersistHotelSearch,
} from "../src/services/hotel-search-service.js";
import type { HotelOffer, HotelProvider } from "../src/providers/types.js";
import {
  resolveHotelProviderByName,
  resolvePersistedHotelProviderName,
} from "../src/providers/live-provider-factory.js";
import { createRequestContext } from "../src/utils/context.js";

const snapshot = {
  authorizedData: {},
  departureCities: ["Shanghai"],
  destinationCandidates: [] as string[],
  travelDateStart: "2026-09-15",
  travelDateEnd: "2026-09-18",
};
const preferences = { roomCount: 1, adultsPerRoom: [2], currency: "USD" };

describe("hotel provider switching", () => {
  let ownerId: string;
  let tripId: string;
  let snapshotId: string;

  beforeEach(async () => {
    const [owner] = await db.insert(users).values({
      externalId: `switch-${randomUUID()}`,
      displayName: "Switch test",
    }).returning();
    ownerId = owner.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Switch trip",
      createdBy: ownerId,
      authorizedData: {},
      departureCities: snapshot.departureCities,
      destinationCandidates: ["Tokyo"],
    }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId: ownerId, role: "CREATOR", isRequired: true });
    const [stored] = await db.insert(constraintSnapshots).values({
      tripId,
      version: 1,
      authorizedData: {},
      departureCities: snapshot.departureCities,
      destinationCandidates: ["Tokyo"],
      travelDateStart: snapshot.travelDateStart,
      travelDateEnd: snapshot.travelDateEnd,
    }).returning();
    snapshotId = stored.id;
  });

  afterEach(async () => {
    await db.delete(providerSearchCache).where(eq(providerSearchCache.requestFingerprint, ""));
    await db.delete(providerOffers).where(eq(providerOffers.snapshotId, snapshotId));
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId));
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
    await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, ownerId));
  });

  it("builds different cache fingerprints for the same search across providers", () => {
    const fingerprintSerpapi = buildHotelSearchFingerprint({
      provider: "serpapi_google_hotels",
      destinationId: "Tokyo",
      checkIn: "2026-09-15",
      checkOut: "2026-09-18",
      preferences,
      locale: "en",
    });
    const fingerprintNuitee = buildHotelSearchFingerprint({
      provider: "nuitee_connect",
      destinationId: "Tokyo",
      checkIn: "2026-09-15",
      checkOut: "2026-09-18",
      preferences,
      locale: "en",
    });
    expect(fingerprintSerpapi).not.toBe(fingerprintNuitee);
    expect(fingerprintSerpapi).toHaveLength(64);
    expect(fingerprintNuitee).toHaveLength(64);
  });

  it("isolates Nuitee cache entries by the task-bound authorization pointer", () => {
    const base = {
      provider: "nuitee_connect" as const,
      destinationId: "Tokyo",
      checkIn: "2026-09-15",
      checkOut: "2026-09-18",
      preferences,
      locale: "en" as const,
    };
    expect(buildHotelSearchFingerprint({ ...base, quoteAuthorization: { id: "grant-a", version: 1 } }))
      .not.toBe(buildHotelSearchFingerprint({ ...base, quoteAuthorization: { id: "grant-b", version: 1 } }));
    expect(buildHotelSearchFingerprint({ ...base, quoteAuthorization: { id: "grant-a", version: 1 } }))
      .not.toBe(buildHotelSearchFingerprint({ ...base, quoteAuthorization: { id: "grant-a", version: 2 } }));
  });

  it("never persists an offer when the run-bound provider is not configured", async () => {
    const provider: HotelProvider = resolveHotelProviderByName("nuitee_connect");
    expect(provider.providerName).toBe("unconfigured");
    const result = await executeAndPersistHotelSearch({
      ctx: createRequestContext(ownerId, randomUUID(), randomUUID()),
      tripId,
      snapshotId,
      snapshot,
      preferences,
      locale: "en",
      input: { snapshotId, destinationId: "Tokyo" },
      provider,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") {
      expect(result.reason).toBe("NOT_CONFIGURED");
    }
    const runs = await db.select().from(providerSearchRuns)
      .where(eq(providerSearchRuns.snapshotId, snapshotId));
    // `unconfigured` is never persisted as an offer/search-run provider.
    // The caller turns this into a bounded hotel service gap instead.
    expect(runs).toHaveLength(0);
  });

  it("stamps providerName and source onto every persisted offer", async () => {
    const provider: HotelProvider = makeFakeHotelProvider("serpapi_google_hotels", "SerpApi Google Hotels");
    const result = await executeAndPersistHotelSearch({
      ctx: createRequestContext(ownerId, randomUUID(), randomUUID()),
      tripId,
      snapshotId,
      snapshot,
      preferences,
      locale: "en",
      input: { snapshotId, destinationId: "Tokyo" },
      provider,
    });
    expect(result.outcome).toBe("LIVE");
    if (result.outcome !== "LIVE") return;
    expect(result.data[0].providerName).toBe("serpapi_google_hotels");
    expect(result.data[0].source).toBe("SerpApi Google Hotels");

    const persisted = await db.select().from(providerOffers)
      .where(and(eq(providerOffers.searchRunId, result.queryId!)));
    expect(persisted).toHaveLength(1);
    const offerData = persisted[0].offerData as { providerName: string; source: string };
    expect(offerData.providerName).toBe("serpapi_google_hotels");
    expect(offerData.source).toBe("SerpApi Google Hotels");
  });

  it("resolvePersistedHotelProviderName returns null when env is disabled", () => {
    expect(resolvePersistedHotelProviderName({})).toBeNull();
    expect(resolvePersistedHotelProviderName({ HOTEL_PROVIDER: "disabled" })).toBeNull();
    expect(resolvePersistedHotelProviderName({ HOTEL_PROVIDER: "unknown" })).toBeNull();
    expect(resolvePersistedHotelProviderName({ HOTEL_PROVIDER: "nuitee" })).toBeNull();
    expect(resolvePersistedHotelProviderName({ HOTEL_PROVIDER: "nuitee", NUITEE_API_KEY: "k" })).toBe("nuitee_connect");
  });
});

function makeFakeHotelProvider(providerName: "serpapi_google_hotels" | "nuitee_connect", source: string): HotelProvider {
  return {
    providerName,
    source,
    searchHotels: viSearchHotels(),
  };
}

function viSearchHotels(): HotelProvider["searchHotels"] {
  return async (params) => {
    const capturedAt = new Date().toISOString();
    const offer: HotelOffer = {
      id: randomUUID(),
      providerOfferId: "offer-x",
      queryId: "ignored",
      providerName: "serpapi_google_hotels",
      destinationId: params.destination.destinationId,
      propertyId: "p",
      propertyName: "Test Hotel",
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      nights: 3,
      roomCount: params.roomCount,
      adultsPerRoom: [...params.adultsPerRoom],
      totalPrice: 300,
      pricePerNight: 100,
      currency: params.currency,
      taxesAndFees: { status: "UNKNOWN" },
      cancellationSummary: null,
      roomSummary: null,
      source: "SerpApi Google Hotels",
      capturedAt,
      expiresAt: new Date(Date.parse(capturedAt) + 15 * 60_000).toISOString(),
    };
    return { outcome: "LIVE", data: [omitQueryAndId(offer)], source: params.destination ? "SerpApi Google Hotels" : "", capturedAt };
  };
}

function omitQueryAndId(offer: HotelOffer): Omit<HotelOffer, "id" | "queryId"> {
  const { id: _id, queryId: _q, ...rest } = offer;
  void _id; void _q;
  return rest;
}
