import { beforeEach, describe, expect, it, vi } from "vitest";

import { metrics } from "../src/observability/metrics.js";
import { readSerpApiHotelConfiguration, SerpApiHotelProvider } from "../src/providers/serpapi-hotel-provider.js";

const fixedNow = new Date("2026-08-30T10:00:00.000Z");
const request = {
  destination: {
    destinationId: "Paris",
    cityName: "Paris",
    countryCode: "FR",
    latitude: 48.8566,
    longitude: 2.3522,
  },
  checkIn: "2026-09-15",
  checkOut: "2026-09-18",
  roomCount: 1,
  adultsPerRoom: [2],
  currency: "USD",
  locale: "en" as const,
};

beforeEach(() => metrics.reset());

describe("SerpApiHotelProvider", () => {
  it("normalizes live hotel evidence and never returns provider links or tokens", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("q")).toBe("Paris, FR");
      expect(url.searchParams.get("check_in_date")).toBe("2026-09-15");
      expect(url.searchParams.get("adults")).toBe("2");
      expect(url.searchParams.get("api_key")).toBe("secret");
      return jsonResponse({
        search_metadata: { id: "search-1", status: "Success" },
        properties: [{
          type: "hotel", name: "Safe Hotel", property_token: "raw-property-token",
          rate_per_night: { extracted_lowest: 120, extracted_before_taxes_fees: 100 },
          total_rate: { extracted_lowest: 360, extracted_before_taxes_fees: 300 },
          free_cancellation: true, extracted_hotel_class: 4,
          amenities: ["Pool", "Wi-Fi", "Breakfast"],
          gps_coordinates: { latitude: 48.86, longitude: 2.35 },
          link: "https://provider.example/booking",
        }],
      });
    }) as typeof fetch;
    const result = await provider(fetchImpl).searchHotels(request);
    expect(result).toMatchObject({
      outcome: "LIVE", source: "SerpApi Google Hotels",
      data: [{
        propertyName: "Safe Hotel",
        totalPrice: 360, pricePerNight: 120, currency: "USD",
        taxesAndFees: { status: "INCLUDED", amount: 60 },
        cancellationSummary: "Free cancellation available",
      }],
    });
    // providerName is stamped by the service layer after the adapter returns;
    // the adapter does not embed it in items.
    expect(result).toMatchObject({ outcome: "LIVE", source: "SerpApi Google Hotels" });
    if (result.outcome === "LIVE") {
      expect(result.data[0]).not.toHaveProperty("providerName");
      expect(result.data[0]).not.toHaveProperty("source");
    }
    expect(JSON.stringify(result)).not.toContain("raw-property-token");
    expect(JSON.stringify(result)).not.toContain("provider.example");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each([
    [429, {}, "RATE_LIMITED"],
    [403, {}, "PROVIDER_NOT_APPROVED"],
    [200, { search_metadata: { id: "x", status: "Success" }, properties: [] }, "NO_RESULTS"],
    [200, { search_metadata: { id: "x", status: "Success" }, properties: [{ bad: true }] }, "INVALID_PROVIDER_RESPONSE"],
  ])("maps status %s to %s", async (status, body, reason) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body, status)) as typeof fetch;
    await expect(provider(fetchImpl).searchHotels(request)).resolves.toEqual({ outcome: "UNAVAILABLE", reason });
  });

  it("fails closed for multi-room prices the upstream contract cannot represent", async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(provider(fetchImpl).searchHotels({ ...request, roomCount: 2, adultsPerRoom: [2, 2] })).resolves.toEqual({
      outcome: "UNAVAILABLE", reason: "SEARCH_CONSTRAINTS_INCOMPLETE",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drops properties outside the destination radius instead of returning a wrong city", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      search_metadata: { id: "search-1", status: "Success" },
      properties: [{
        type: "hotel", name: "Hotel Paris Elsewhere", property_token: "far-away",
        total_rate: { extracted_lowest: 300 },
        gps_coordinates: { latitude: 33.66, longitude: -95.55 },
      }],
    })) as typeof fetch;
    await expect(provider(fetchImpl).searchHotels(request)).resolves.toEqual({ outcome: "UNAVAILABLE", reason: "NO_RESULTS" });
  });

  it("filters wrong-city names before applying the ten-result cap", async () => {
    const wrongCityProperties = Array.from({ length: 10 }, (_, index) => ({
      type: "hotel",
      name: `Hotel Paris Elsewhere ${index}`,
      property_token: `far-away-${index}`,
      total_rate: { extracted_lowest: 300 + index },
      gps_coordinates: { latitude: 33.66, longitude: -95.55 },
    }));
    const fetchImpl = vi.fn(async () => jsonResponse({
      search_metadata: { id: "search-1", status: "Success" },
      properties: [
        ...wrongCityProperties,
        {
          type: "hotel",
          name: "Paris Centre Hotel",
          property_token: "nearby",
          total_rate: { extracted_lowest: 420 },
          gps_coordinates: { latitude: 48.857, longitude: 2.351 },
        },
      ],
    })) as typeof fetch;

    const result = await provider(fetchImpl).searchHotels(request);
    expect(result).toMatchObject({
      outcome: "LIVE",
      data: [{ propertyName: "Paris Centre Hotel" }],
    });
  });
});

describe("readSerpApiHotelConfiguration", () => {
  it("is opt-in and fail-closed without a key", () => {
    expect(readSerpApiHotelConfiguration({})).toBeNull();
    expect(readSerpApiHotelConfiguration({ SERPAPI_HOTEL_ENABLED: "true" })).toBeNull();
    expect(readSerpApiHotelConfiguration({ SERPAPI_HOTEL_ENABLED: "true", SERPAPI_API_KEY: "key" })).toMatchObject({
      apiKey: "key", timeoutMs: 10_000, maxRetries: 1, maxDistanceKm: 75,
    });
  });
});

function provider(fetchImpl: typeof fetch) {
  return new SerpApiHotelProvider({ apiKey: "secret", timeoutMs: 500, maxRetries: 0, fetchImpl, now: () => fixedNow });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
