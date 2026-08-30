import { describe, expect, it } from "vitest";
import { SerpApiFlightProvider, readSerpApiConfiguration } from "../src/providers/serpapi-flight-provider.js";
import { createFlightProvider } from "../src/providers/live-provider-factory.js";

const request = {
  origin: "SIN", destination: "NRT", dateStart: "2026-10-01", dateEnd: "2026-10-10",
  snapshotId: "00000000-0000-4000-8000-000000000001", adults: 2, cabin: "PREMIUM_ECONOMY" as const, currency: "USD",
};

const validPayload = {
  search_metadata: { id: "supplier-search-id", status: "Success", raw_html_file: "https://supplier.invalid/raw" },
  best_flights: [{
    flights: [{
      departure_airport: { id: "SIN", time: "2026-10-01 08:00" },
      arrival_airport: { id: "NRT", time: "2026-10-01 16:30" },
      duration: 390, airline: "Example Air", flight_number: "EX 123", travel_class: "Premium economy",
      extensions: ["Carry-on bag included", "Wi-Fi"],
    }],
    total_duration: 390, price: 321, type: "Round trip", departure_token: "private-supplier-token",
  }],
  other_flights: [],
};

function provider(fetchImpl: typeof fetch): SerpApiFlightProvider {
  return new SerpApiFlightProvider({
    apiKey: "test-only-key", timeoutMs: 500, country: "us", language: "en", fetch: fetchImpl,
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
}

describe("SerpApiFlightProvider", () => {
  it("maps controlled search fields and normalizes only safe evidence", async () => {
    let requestedUrl = "";
    const result = await provider(async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(validPayload), { status: 200 });
    }).searchFlights(request);

    const url = new URL(requestedUrl);
    expect(url.origin + url.pathname).toBe("https://serpapi.com/search.json");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      engine: "google_flights", departure_id: "SIN", arrival_id: "NRT", outbound_date: "2026-10-01",
      return_date: "2026-10-10", type: "1", travel_class: "2", adults: "2", currency: "USD", gl: "us", hl: "en",
    });
    expect(result).toMatchObject({ outcome: "LIVE", source: "SerpAPI Google Flights" });
    expect(JSON.stringify(result)).not.toContain("test-only-key");
    expect(JSON.stringify(result)).not.toContain("private-supplier-token");
    expect(JSON.stringify(result)).not.toContain("supplier.invalid/raw");
    if (result.outcome === "LIVE") {
      expect(result.data[0]).toMatchObject({
        providerName: "serpapi", origin: "SIN", destination: "NRT", totalPrice: 321,
        totalDuration: "PT6H30M", cabin: "PREMIUM_ECONOMY", baggageSummary: "Carry-on bag included",
      });
      expect(result.data[0]?.segments[0]).toMatchObject({ carrierCode: "EX", flightNumber: "123", departureAt: "2026-10-01T08:00" });
    }
  });

  it("maps one-way constraints without a return date", async () => {
    let requestedUrl = "";
    const result = await provider(async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(validPayload), { status: 200 });
    }).searchFlights({ ...request, tripType: "ONE_WAY", dateEnd: "2026-10-01" });
    const url = new URL(requestedUrl);
    expect(url.searchParams.get("type")).toBe("2");
    expect(url.searchParams.has("return_date")).toBe(false);
    expect(result).toMatchObject({ outcome: "LIVE" });
  });

  it.each([
    [200, { search_metadata: { id: "x", status: "Success" }, best_flights: [] }, "NO_RESULTS"],
    [200, { search_metadata: { id: "x", status: "Error" } }, "UPSTREAM_FAILURE"],
    [200, { broken: true }, "INVALID_PROVIDER_RESPONSE"],
    [401, {}, "PROVIDER_NOT_APPROVED"],
    [403, {}, "PROVIDER_NOT_APPROVED"],
    [429, {}, "RATE_LIMITED"],
    [503, {}, "UPSTREAM_FAILURE"],
  ])("fails closed for response %s", async (status, body, reason) => {
    const result = await provider(async () => new Response(JSON.stringify(body), { status })).searchFlights(request);
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason });
  });

  it("fails closed on malformed route data, missing round-trip dates, and cancellation", async () => {
    const invalidRoute = structuredClone(validPayload);
    invalidRoute.best_flights[0].flights[0].arrival_airport.id = "LIS";
    await expect(provider(async () => new Response(JSON.stringify(invalidRoute), { status: 200 })).searchFlights(request))
      .resolves.toEqual({ outcome: "UNAVAILABLE", reason: "NO_RESULTS" });
    await expect(provider(async () => new Response("{}", { status: 200 })).searchFlights({ ...request, dateEnd: "" }))
      .resolves.toEqual({ outcome: "UNAVAILABLE", reason: "SEARCH_CONSTRAINTS_INCOMPLETE" });
    await expect(provider(async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; }).searchFlights(request))
      .resolves.toEqual({ outcome: "UNAVAILABLE", reason: "UPSTREAM_TIMEOUT" });
  });

  it("validates configuration and selects SerpAPI without a fallback", () => {
    expect(() => readSerpApiConfiguration({})).toThrow("SERPAPI_API_KEY");
    expect(() => readSerpApiConfiguration({ SERPAPI_API_KEY: "test", SERPAPI_GOOGLE_FLIGHTS_GL: "usa" })).toThrow("SERPAPI_GOOGLE_FLIGHTS_GL");
    expect(createFlightProvider({ FLIGHT_PROVIDER: "serpapi", SERPAPI_API_KEY: "test-only-key" })).toBeInstanceOf(SerpApiFlightProvider);
    expect(() => createFlightProvider({ FLIGHT_PROVIDER: "serpapi" })).toThrow("SERPAPI_API_KEY");
  });
});
