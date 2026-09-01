import { describe, expect, it, vi } from "vitest";

/**
 * Pure unit tests for the Personal hotel executor. Provider factory is
 * stubbed at the module boundary via `vi.mock` so these tests stay hermetic —
 * no DB, no live HTTP, no env mutation. Integration coverage lives in
 * `tests/routes/personal-research.test.ts`.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5 stage 2.
 */

const mockSearchHotels = vi.fn();
const mockCreateHotelProvider = vi.fn(() => ({
  providerName: "nuitee_connect",
  source: "nuitee",
  searchHotels: mockSearchHotels,
}));

const mockGetLocationReferenceResolver = vi.fn(() => ({
  resolveDestinationReference: () => ({
    destinationId: "TYO",
    cityName: "Tokyo",
    countryCode: "JP",
    latitude: 35.68,
    longitude: 139.69,
  }),
}));

const mockLoadActiveQuoteNationality = vi.fn();

vi.mock("../../src/providers/live-provider-factory.js", () => ({
  createHotelProvider: () => mockCreateHotelProvider(),
}));

vi.mock("../../src/location-reference/location-reference-resolver.js", () => ({
  getLocationReferenceResolver: () => mockGetLocationReferenceResolver(),
}));

const mockResolveTripDestinationReference = vi.fn();

vi.mock("../../src/services/destination-reference-service.js", () => ({
  resolveTripDestinationReference: (...args: unknown[]) => mockResolveTripDestinationReference(...args),
}));

vi.mock("../../src/services/stay-search-provider-authorization.js", () => ({
  loadActiveQuoteNationality: (...args: unknown[]) => mockLoadActiveQuoteNationality(...args),
}));

const { executePersonalHotelSearch } = await import("../../src/services/personal-research-executors/hotel.js");

const baseRun = {
  id: "00000000-0000-0000-0000-000000000001",
  createdByUserId: "00000000-0000-0000-0000-000000000002",
  tripId: "00000000-0000-0000-0000-000000000003",
  threadId: "00000000-0000-0000-0000-000000000004",
  snapshotId: null,
  operation_type: "PERSONAL_RESEARCH",
  status: "QUEUED",
  requestedCapabilities: ["hotel.search"],
  researchIntentDraft: null,
  researchIntentState: null,
  originatingIntentRunId: null,
  traceContext: null,
  expiresAt: new Date(Date.now() + 60_000),
} as unknown as Parameters<typeof executePersonalHotelSearch>[0]["run"];

const baseDraft = {
  kind: "HOTEL_SEARCH" as const,
  cityCode: "TYO",
  checkIn: "2026-12-01",
  checkOut: "2026-12-08",
  occupancy: { adults: 2, rooms: 1 },
  currency: "USD",
};

function setProvider(providerName: "unconfigured" | "nuitee_connect" | "serpapi_google_hotels"): void {
  if (providerName === "unconfigured") {
    mockCreateHotelProvider.mockReturnValueOnce({
      providerName: "unconfigured",
      source: "Not configured",
      searchHotels: mockSearchHotels,
    });
  } else if (providerName === "serpapi_google_hotels") {
    mockCreateHotelProvider.mockReturnValueOnce({
      providerName: "serpapi_google_hotels",
      source: "serpapi",
      searchHotels: mockSearchHotels,
    });
  } else {
    mockCreateHotelProvider.mockReturnValueOnce({
      providerName: "nuitee_connect",
      source: "nuitee",
      searchHotels: mockSearchHotels,
    });
  }
}

describe("executePersonalHotelSearch", () => {
  it("returns UNAVAILABLE NOT_CONFIGURED when the provider factory returns 'unconfigured'", async () => {
    setProvider("unconfigured");
    const result = await executePersonalHotelSearch({
      run: baseRun,
      draft: baseDraft,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") {
      expect(result.summary.errorCode).toBe("NOT_CONFIGURED");
    }
    expect(mockSearchHotels).not.toHaveBeenCalled();
  });

  it("returns UNAVAILABLE SEARCH_CONSTRAINTS_INCOMPLETE when destination resolves to null", async () => {
    mockResolveTripDestinationReference.mockResolvedValueOnce(null);
    mockGetLocationReferenceResolver.mockReturnValueOnce({
      resolveDestinationReference: () => null,
    });
    setProvider("serpapi_google_hotels");
    const result = await executePersonalHotelSearch({
      run: baseRun,
      draft: baseDraft,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") {
      expect(result.summary.errorCode).toBe("SEARCH_CONSTRAINTS_INCOMPLETE");
    }
    expect(mockSearchHotels).not.toHaveBeenCalled();
  });

  it("returns UNAVAILABLE SEARCH_CONSTRAINTS_INCOMPLETE for Nuitee without an active nationality binding", async () => {
    mockLoadActiveQuoteNationality.mockResolvedValueOnce(null);
    setProvider("nuitee_connect");
    const result = await executePersonalHotelSearch({
      run: baseRun,
      draft: baseDraft,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") {
      expect(result.summary.errorCode).toBe("SEARCH_CONSTRAINTS_INCOMPLETE");
    }
    expect(mockSearchHotels).not.toHaveBeenCalled();
  });

  it("projects min/max nightly price on AVAILABLE when Nuitee returns offers", async () => {
    mockLoadActiveQuoteNationality.mockResolvedValueOnce({
      id: "auth-1",
      version: 1,
      nationality: "JP",
    });
    mockSearchHotels.mockResolvedValueOnce({
      outcome: "LIVE",
      data: [
        {
          destinationId: "TYO",
          propertyId: "p1",
          propertyName: "Park Hyatt",
          checkIn: "2026-12-01",
          checkOut: "2026-12-08",
          nights: 7,
          roomCount: 1,
          adultsPerRoom: [2],
          totalPrice: 1400,
          pricePerNightUsd: 200,
          currency: "USD",
          style: "luxury",
          location: "Shinjuku",
        },
        {
          destinationId: "TYO",
          propertyId: "p2",
          propertyName: "Capsule",
          checkIn: "2026-12-01",
          checkOut: "2026-12-08",
          nights: 7,
          roomCount: 1,
          adultsPerRoom: [2],
          totalPrice: 350,
          pricePerNightUsd: 50,
          currency: "USD",
          style: "budget",
          location: "Asakusa",
        },
      ],
      source: "nuitee",
      capturedAt: new Date().toISOString(),
    });
    setProvider("nuitee_connect");
    const result = await executePersonalHotelSearch({
      run: baseRun,
      draft: baseDraft,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("AVAILABLE");
    if (result.outcome === "AVAILABLE") {
      expect(result.capability).toBe("hotel.search");
      expect(result.hotel?.propertyCount).toBe(2);
      expect(result.hotel?.minNightlyPrice).toBe(350);
      expect(result.hotel?.maxNightlyPrice).toBe(1400);
    }
  });
});