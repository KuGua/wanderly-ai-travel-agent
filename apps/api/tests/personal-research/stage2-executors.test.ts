import { describe, expect, it, vi } from "vitest";

/**
 * Pure unit tests for the stage 2 Personal research executors. Provider
 * factories are stubbed at the module boundary via `vi.mock` so the tests
 * stay hermetic — no DB, no live HTTP, no env mutation.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5 stage 2.
 */

const mockDiscoverAccommodations = vi.fn();
const mockSearchActivities = vi.fn();
const mockResolveTripDestinationReference = vi.fn();
const mockGetLocationReferenceResolver = vi.fn();

const mockCreateAccommodationDiscoveryProvider = vi.fn(() => ({
  providerName: "opentripmap",
  source: "OpenTripMap",
  discoverAccommodations: mockDiscoverAccommodations,
}));
const mockCreateActivitiesProvider = vi.fn(() => ({
  providerName: "viator_mcp",
  source: "Viator MCP",
  searchActivities: mockSearchActivities,
}));

vi.mock("../../src/providers/live-provider-factory.js", () => ({
  createAccommodationDiscoveryProvider: () => mockCreateAccommodationDiscoveryProvider(),
  createActivitiesProvider: () => mockCreateActivitiesProvider(),
}));

vi.mock("../../src/services/destination-reference-service.js", () => ({
  resolveTripDestinationReference: (...args: unknown[]) => mockResolveTripDestinationReference(...args),
}));

vi.mock("../../src/location-reference/location-reference-resolver.js", () => ({
  getLocationReferenceResolver: () => mockGetLocationReferenceResolver(),
}));

// Default: trip resolver returns null, fallback resolver returns a valid
// destination. Individual tests override via `mockReturnValueOnce`.
mockResolveTripDestinationReference.mockResolvedValue(null);
mockGetLocationReferenceResolver.mockReturnValue({
  resolveDestinationReference: () => ({
    destinationId: "TYO",
    cityName: "Tokyo",
    countryCode: "JP",
    latitude: 35.68,
    longitude: 139.69,
  }),
});

const { executePersonalAccommodationDiscovery } = await import(
  "../../src/services/personal-research-executors/accommodation.js"
);
const { executePersonalActivitiesSearch } = await import(
  "../../src/services/personal-research-executors/activities.js"
);

const baseRun = {
  id: "00000000-0000-0000-0000-000000000001",
  createdByUserId: "00000000-0000-0000-0000-000000000002",
  tripId: "00000000-0000-0000-0000-000000000003",
  threadId: "00000000-0000-0000-0000-000000000004",
  snapshotId: null,
  status: "QUEUED",
  requestedCapabilities: ["accommodation.discovery"],
  researchIntentDraft: null,
  researchIntentState: null,
  originatingIntentRunId: null,
  traceContext: null,
  expiresAt: new Date(Date.now() + 60_000),
} as unknown as Parameters<typeof executePersonalAccommodationDiscovery>[0]["run"];

describe("executePersonalAccommodationDiscovery", () => {
  it("returns UNAVAILABLE NOT_CONFIGURED when OpenTripMap is unconfigured", async () => {
    mockCreateAccommodationDiscoveryProvider.mockReturnValueOnce({
      discoverAccommodations: vi.fn().mockResolvedValue({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" }),
    });
    const result = await executePersonalAccommodationDiscovery({
      run: baseRun,
      draft: {
        kind: "ACCOMMODATION_DISCOVERY",
        latitude: 35.68,
        longitude: 139.69,
        radiusMeters: 5000,
        checkIn: "2026-12-01",
        checkOut: "2026-12-08",
        occupancy: { adults: 2, rooms: 1 },
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") {
      expect(result.summary.errorCode).toBe("NOT_CONFIGURED");
    }
  });

  it("returns AVAILABLE with topCategory derived from the dominant kind", async () => {
    mockDiscoverAccommodations.mockResolvedValueOnce({
      outcome: "LIVE",
      data: [
        { providerPlaceId: "p1", name: "Ryokan A", kind: "HOSTEL", longitude: 139.7, latitude: 35.7, distanceMeters: 500, popularityTier: 1, source: "OpenTripMap", attribution: "© OpenStreetMap contributors", capturedAt: new Date().toISOString() },
        { providerPlaceId: "p2", name: "Ryokan B", kind: "HOSTEL", longitude: 139.7, latitude: 35.7, distanceMeters: 600, popularityTier: 1, source: "OpenTripMap", attribution: "© OpenStreetMap contributors", capturedAt: new Date().toISOString() },
        { providerPlaceId: "p3", name: "Hotel C", kind: "HOTEL", longitude: 139.7, latitude: 35.7, distanceMeters: 800, popularityTier: 2, source: "OpenTripMap", attribution: "© OpenStreetMap contributors", capturedAt: new Date().toISOString() },
      ],
      source: "OpenTripMap",
      capturedAt: new Date().toISOString(),
    });
    const result = await executePersonalAccommodationDiscovery({
      run: baseRun,
      draft: {
        kind: "ACCOMMODATION_DISCOVERY",
        latitude: 35.68,
        longitude: 139.69,
        radiusMeters: 5000,
        checkIn: "2026-12-01",
        checkOut: "2026-12-08",
        occupancy: { adults: 2, rooms: 1 },
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("AVAILABLE");
    if (result.outcome === "AVAILABLE") {
      expect(result.accommodation?.candidateCount).toBe(3);
      expect(result.accommodation?.topCategory).toBe("HOSTEL");
    }
  });
});

describe("executePersonalActivitiesSearch", () => {
  it("returns UNAVAILABLE NOT_CONFIGURED when Viator is unconfigured", async () => {
    mockCreateActivitiesProvider.mockReturnValueOnce({
      searchActivities: vi.fn().mockResolvedValue({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" }),
    });
    const result = await executePersonalActivitiesSearch({
      run: baseRun,
      draft: {
        kind: "ACTIVITIES_SEARCH",
        destinationCode: "TYO",
        startDate: "2026-12-01",
        endDate: "2026-12-08",
        category: null,
        limit: 20,
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") {
      expect(result.summary.errorCode).toBe("NOT_CONFIGURED");
    }
  });

  it("returns AVAILABLE with activityCount when Viator returns offers", async () => {
    mockSearchActivities.mockResolvedValueOnce({
      outcome: "LIVE",
      data: [
        {
          activityId: "a1",
          title: "Tea Ceremony",
          city: "Tokyo",
          theme: "CULTURE",
          durationMinutes: 60,
          rating: 4.8,
          providerName: "Viator",
          source: "viator_mcp",
          capturedAt: new Date().toISOString(),
        },
        {
          activityId: "a2",
          title: "Sushi Class",
          city: "Tokyo",
          theme: "FOOD",
          durationMinutes: 120,
          rating: 4.6,
          providerName: "Viator",
          source: "viator_mcp",
          capturedAt: new Date().toISOString(),
        },
      ],
      source: "viator_mcp",
      capturedAt: new Date().toISOString(),
    });
    const result = await executePersonalActivitiesSearch({
      run: baseRun,
      draft: {
        kind: "ACTIVITIES_SEARCH",
        destinationCode: "TYO",
        startDate: "2026-12-01",
        endDate: "2026-12-08",
        category: "CULTURE",
        limit: 20,
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("AVAILABLE");
    if (result.outcome === "AVAILABLE") {
      expect(result.activities?.activityCount).toBe(2);
      expect(result.activities?.destinationCode).toBe("TYO");
      // Per spec §3.5 stage 2, the Personal path does NOT carry price;
      // the Shared path on activate re-queries for the full offer set.
      expect(result.activities?.minPrice).toBeNull();
      expect(result.activities?.maxPrice).toBeNull();
    }
  });
});