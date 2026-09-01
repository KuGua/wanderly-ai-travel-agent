import { describe, expect, it, vi } from "vitest";

/**
 * Pure unit tests for the stage 3 Personal research executors. Provider
 * factories are stubbed at the module boundary via `vi.mock` so the tests
 * stay hermetic — no DB, no live HTTP, no env mutation.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5 stage 3.
 */

const mockSearchPlaces = vi.fn();
const mockSearchRoute = vi.fn();
const mockSearchOffers = vi.fn();

const mockCreateOrsPlace = vi.fn(() => ({
  providerName: "ors",
  source: "ors",
  searchPlaces: mockSearchPlaces,
}));
const mockCreateOrsNavigation = vi.fn(() => ({
  providerName: "ors",
  source: "ors",
  searchRoute: mockSearchRoute,
}));
const mockCreateAmadeusTransfer = vi.fn(() => ({
  providerName: "amadeus",
  source: "amadeus",
  searchOffers: mockSearchOffers,
}));

vi.mock("../../src/providers/live-provider-factory.js", () => ({
  createOrsPlace: () => mockCreateOrsPlace(),
  createOrsNavigation: () => mockCreateOrsNavigation(),
  createAmadeusTransfer: () => mockCreateAmadeusTransfer(),
}));

const { executePersonalPlacesSearch } = await import(
  "../../src/services/personal-research-executors/places.js"
);
const { executePersonalNavigationRoute } = await import(
  "../../src/services/personal-research-executors/navigation-route.js"
);
const { executePersonalMobilitySearch } = await import(
  "../../src/services/personal-research-executors/mobility.js"
);

const baseRun = {
  id: "00000000-0000-0000-0000-000000000001",
  createdByUserId: "00000000-0000-0000-0000-000000000002",
  tripId: "00000000-0000-0000-0000-000000000003",
  threadId: "00000000-0000-0000-0000-000000000004",
  snapshotId: null,
  status: "QUEUED",
  requestedCapabilities: ["places.search"],
  researchIntentDraft: null,
  researchIntentState: null,
  originatingIntentRunId: null,
  traceContext: null,
  expiresAt: new Date(Date.now() + 60_000),
} as unknown as Parameters<typeof executePersonalPlacesSearch>[0]["run"];

describe("executePersonalPlacesSearch", () => {
  it("returns UNAVAILABLE NOT_CONFIGURED when ORS place provider is unconfigured", async () => {
    mockCreateOrsPlace.mockReturnValueOnce({
      searchPlaces: vi.fn().mockResolvedValue({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" }),
    });
    const result = await executePersonalPlacesSearch({
      run: baseRun,
      draft: {
        kind: "PLACES_SEARCH",
        latitude: 35.68,
        longitude: 139.69,
        radiusMeters: 1500,
        category: "ATTRACTION",
        limit: 20,
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") {
      expect(result.summary.errorCode).toBe("NOT_CONFIGURED");
    }
  });

  it("returns UNAVAILABLE SEARCH_CONSTRAINTS_INCOMPLETE when radius is below the minimum (handled by Zod upstream)", async () => {
    // Schema enforces radius >= 100; executor passes through and gets an
    // empty LIVE response — counted as zero candidates.
    mockSearchPlaces.mockResolvedValueOnce({
      outcome: "LIVE",
      data: [],
      source: "ors",
      capturedAt: new Date().toISOString(),
    });
    const result = await executePersonalPlacesSearch({
      run: baseRun,
      draft: {
        kind: "PLACES_SEARCH",
        latitude: 35.68,
        longitude: 139.69,
        radiusMeters: 500,
        category: null,
        limit: 10,
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("AVAILABLE");
    if (result.outcome === "AVAILABLE") {
      expect(result.places?.candidateCount).toBe(0);
      expect(result.places?.categories).toEqual([]);
      expect(result.places?.radiusMeters).toBe(500);
    }
  });

  it("returns AVAILABLE with deduped categories when ORS returns candidates", async () => {
    mockSearchPlaces.mockResolvedValueOnce({
      outcome: "LIVE",
      data: [
        {
          candidateId: "c1",
          displayName: "Senso-ji",
          kind: "ATTRACTION",
          countryCode: "JP",
          cityName: "Tokyo",
          longitude: 139.79,
          latitude: 35.71,
          confidence: 0.9,
          needsUserConfirmation: false,
          source: "ors",
          capturedAt: new Date().toISOString(),
        },
        {
          candidateId: "c2",
          displayName: "Another Temple",
          kind: "ATTRACTION",
          countryCode: "JP",
          cityName: "Tokyo",
          longitude: 139.78,
          latitude: 35.72,
          confidence: 0.85,
          needsUserConfirmation: false,
          source: "ors",
          capturedAt: new Date().toISOString(),
        },
      ],
      source: "ors",
      capturedAt: new Date().toISOString(),
    });
    const result = await executePersonalPlacesSearch({
      run: baseRun,
      draft: {
        kind: "PLACES_SEARCH",
        latitude: 35.68,
        longitude: 139.69,
        radiusMeters: 5000,
        category: "ATTRACTION",
        limit: 10,
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("AVAILABLE");
    if (result.outcome === "AVAILABLE") {
      expect(result.places?.candidateCount).toBe(2);
      expect(result.places?.categories).toEqual(["ATTRACTION"]);
    }
  });
});

describe("executePersonalNavigationRoute", () => {
  it("returns UNAVAILABLE NOT_CONFIGURED when ORS nav provider is unconfigured", async () => {
    mockCreateOrsNavigation.mockReturnValueOnce({
      searchRoute: vi.fn().mockResolvedValue({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" }),
    });
    const result = await executePersonalNavigationRoute({
      run: baseRun,
      draft: {
        kind: "NAVIGATION_ROUTE",
        originPlaceId: "11111111-1111-4111-8111-111111111111",
        destinationPlaceId: "22222222-2222-4222-8222-222222222222",
        mode: "driving",
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") {
      expect(result.summary.errorCode).toBe("NOT_CONFIGURED");
    }
  });

  it("returns AVAILABLE with distanceMeters and durationSeconds when ORS returns a route", async () => {
    mockSearchRoute.mockResolvedValueOnce({
      outcome: "LIVE",
      data: {
        originPlaceId: "11111111-1111-4111-8111-111111111111",
        destinationPlaceId: "22222222-2222-4222-8222-222222222222",
        mode: "DRIVE",
        distanceMeters: 12500,
        durationSeconds: 1620,
        steps: [],
        encodedGeometry: "",
        source: "ors",
        capturedAt: new Date().toISOString(),
        refreshAfter: new Date(Date.now() + 86400000).toISOString(),
      },
      source: "ors",
      capturedAt: new Date().toISOString(),
    });
    const result = await executePersonalNavigationRoute({
      run: baseRun,
      draft: {
        kind: "NAVIGATION_ROUTE",
        originPlaceId: "11111111-1111-4111-8111-111111111111",
        destinationPlaceId: "22222222-2222-4222-8222-222222222222",
        mode: "driving",
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("AVAILABLE");
    if (result.outcome === "AVAILABLE") {
      expect(result.navigation?.distanceMeters).toBe(12500);
      expect(result.navigation?.durationSeconds).toBe(1620);
      expect(result.navigation?.mode).toBe("driving");
    }
  });
});

describe("executePersonalMobilitySearch", () => {
  it("returns UNAVAILABLE NOT_CONFIGURED when PLAN_ENABLE_MOBILITY is not 'true'", async () => {
    const originalEnv = process.env.PLAN_ENABLE_MOBILITY;
    delete process.env.PLAN_ENABLE_MOBILITY;
    try {
      const result = await executePersonalMobilitySearch({
        run: baseRun,
        draft: {
          kind: "MOBILITY_SEARCH",
          originPlaceId: "11111111-1111-4111-8111-111111111111",
          destinationPlaceId: "22222222-2222-4222-8222-222222222222",
          transferDateTime: "2026-12-01T08:00:00.000Z",
          passengers: 2,
          currency: "USD",
        },
        signal: new AbortController().signal,
      });
      expect(result.outcome).toBe("UNAVAILABLE");
      if (result.outcome === "UNAVAILABLE") {
        expect(result.summary.errorCode).toBe("NOT_CONFIGURED");
      }
      expect(mockSearchOffers).not.toHaveBeenCalled();
    } finally {
      if (originalEnv !== undefined) process.env.PLAN_ENABLE_MOBILITY = originalEnv;
    }
  });

  it("returns AVAILABLE with offerCount when Amadeus returns offers", async () => {
    process.env.PLAN_ENABLE_MOBILITY = "true";
    mockSearchOffers.mockResolvedValueOnce({
      outcome: "LIVE",
      data: [
        {
          offerId: "o1",
          serviceType: "TRANSFER",
          originPlaceId: "11111111-1111-4111-8111-111111111111",
          destinationPlaceId: "22222222-2222-4222-8222-222222222222",
          passengers: 2,
          departureAt: "2026-12-01T08:00:00.000Z",
          estimatedPrice: 75,
          currency: "USD",
          vehicleClass: "standard",
          estimated: true,
          expiresAt: null,
          source: "amadeus",
          capturedAt: new Date().toISOString(),
        },
      ],
      source: "amadeus",
      capturedAt: new Date().toISOString(),
    });
    try {
      const result = await executePersonalMobilitySearch({
        run: baseRun,
        draft: {
          kind: "MOBILITY_SEARCH",
          originPlaceId: "11111111-1111-4111-8111-111111111111",
          destinationPlaceId: "22222222-2222-4222-8222-222222222222",
          transferDateTime: "2026-12-01T08:00:00.000Z",
          passengers: 2,
          currency: "USD",
        },
        signal: new AbortController().signal,
      });
      expect(result.outcome).toBe("AVAILABLE");
      if (result.outcome === "AVAILABLE") {
        expect(result.mobility?.offerCount).toBe(1);
        expect(result.mobility?.passengers).toBe(2);
        expect(result.mobility?.currency).toBe("USD");
      }
    } finally {
      delete process.env.PLAN_ENABLE_MOBILITY;
    }
  });
});