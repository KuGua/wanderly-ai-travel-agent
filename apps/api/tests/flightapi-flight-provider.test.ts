import { describe, expect, it } from "vitest";
import { FlightApiProvider, readFlightApiConfiguration } from "../src/providers/flightapi-flight-provider.js";
import { createFlightProvider } from "../src/providers/live-provider-factory.js";
import { AmadeusFlightProvider } from "../src/providers/amadeus-flight-provider.js";

const request = {
  origin: "SFO", destination: "NRT", dateStart: "2026-10-01", dateEnd: "2026-10-10",
  snapshotId: "00000000-0000-4000-8000-000000000001", adults: 2, cabin: "PREMIUM_ECONOMY" as const, currency: "USD",
};

const validPayload = {
  itineraries: [{ id: "itinerary-1", leg_ids: ["leg-1"], cheapest_price: { amount: 850.5 } }],
  legs: [{ id: "leg-1", origin_place_id: "sfo", destination_place_id: "nrt", departure: "2026-10-01T08:00:00Z", arrival: "2026-10-01T20:00:00Z", duration: 720, segment_ids: ["segment-1"] }],
  segments: [{ id: "segment-1", origin_place_id: "sfo", destination_place_id: "nrt", departure: "2026-10-01T08:00:00Z", arrival: "2026-10-01T20:00:00Z", duration: 720, marketing_flight_number: "7", marketing_carrier_id: "NH", mode: "flight" }],
  places: [{ id: "sfo", iata_code: "SFO" }, { id: "nrt", iata_code: "NRT" }],
};

function provider(fetchImpl: typeof fetch): FlightApiProvider {
  return new FlightApiProvider({ apiKey: "test-only-key", timeoutMs: 500, fetch: fetchImpl, now: () => new Date("2026-08-27T00:00:00Z") });
}

describe("FlightApiProvider", () => {
  it("maps a one-way request and normalizes validated offers without exposing the key", async () => {
    let requestedUrl = "";
    const result = await provider(async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(validPayload), { status: 200 });
    }).searchFlights({ ...request, tripType: "ONE_WAY" });
    expect(requestedUrl).toContain("/onewaytrip/test-only-key/SFO/NRT/2026-10-01/2/0/0/Premium_Economy/USD");
    expect(result).toMatchObject({ outcome: "LIVE", source: "FlightAPI Flight Price API" });
    expect(JSON.stringify(result)).not.toContain("test-only-key");
    if (result.outcome === "LIVE") expect(result.data[0]).toMatchObject({ providerName: "flightapi", origin: "SFO", destination: "NRT", totalPrice: 850.5, cabin: "PREMIUM_ECONOMY" });
  });

  it("maps a round-trip request, while normalizing the outbound leg as the searched route", async () => {
    let requestedUrl = "";
    const result = await provider(async (input) => { requestedUrl = String(input); return new Response(JSON.stringify(validPayload), { status: 200 }); })
      .searchFlights({ ...request, tripType: "ROUND_TRIP" });
    expect(requestedUrl).toContain("/roundtrip/test-only-key/SFO/NRT/2026-10-01/2026-10-10/2/0/0/Premium_Economy/USD");
    expect(result).toMatchObject({ outcome: "LIVE" });
  });

  it("accepts FlightAPI's documented airport-local date-times without inventing a timezone", async () => {
    const localPayload = structuredClone(validPayload);
    localPayload.legs[0].departure = "2026-10-01T08:00:00";
    localPayload.legs[0].arrival = "2026-10-01T20:00:00";
    localPayload.segments[0].departure = "2026-10-01T08:00:00";
    localPayload.segments[0].arrival = "2026-10-01T20:00:00";
    const result = await provider(async () => new Response(JSON.stringify(localPayload), { status: 200 })).searchFlights(request);
    expect(result).toMatchObject({ outcome: "LIVE" });
    if (result.outcome === "LIVE") expect(result.data[0]?.segments[0]?.departureAt).toBe("2026-10-01T08:00:00");
  });

  it("normalizes FlightAPI's live mode casing while rejecting non-flight modes", async () => {
    const liveCasingPayload = structuredClone(validPayload);
    liveCasingPayload.segments[0].mode = "FLIGHT";
    const result = await provider(async () => new Response(JSON.stringify(liveCasingPayload), { status: 200 })).searchFlights(request);
    expect(result).toMatchObject({ outcome: "LIVE" });
    const nonFlightPayload = structuredClone(validPayload);
    nonFlightPayload.segments[0].mode = "train";
    const rejected = await provider(async () => new Response(JSON.stringify(nonFlightPayload), { status: 200 })).searchFlights(request);
    expect(rejected).toEqual({ outcome: "UNAVAILABLE", reason: "INVALID_PROVIDER_RESPONSE" });
  });

  it("accepts FlightAPI's current live wire names without weakening transport or IATA validation", async () => {
    const livePayload = structuredClone(validPayload);
    delete (livePayload.segments[0] as { mode?: string }).mode;
    (livePayload.segments[0] as { transport_mode?: string }).transport_mode = "flight";
    delete (livePayload.places[0] as { iata_code?: string }).iata_code;
    delete (livePayload.places[1] as { iata_code?: string }).iata_code;
    (livePayload.places[0] as { display_code?: string }).display_code = "SFO";
    (livePayload.places[1] as { display_code?: string }).display_code = "NRT";

    const result = await provider(async () => new Response(JSON.stringify(livePayload), { status: 200 })).searchFlights(request);

    expect(result).toMatchObject({ outcome: "LIVE" });
    if (result.outcome === "LIVE") expect(result.data[0]).toMatchObject({ origin: "SFO", destination: "NRT" });
  });

  it("keeps usable offers when FlightAPI includes an unpriced optional OTA option", async () => {
    const mixedPayload = structuredClone(validPayload);
    mixedPayload.itineraries[0].pricing_options = [
      { id: "unpriced", price: { amount: null } },
      { id: "priced", price: { amount: "850.50" } },
    ];
    delete mixedPayload.itineraries[0].cheapest_price;
    const result = await provider(async () => new Response(JSON.stringify(mixedPayload), { status: 200 })).searchFlights(request);
    expect(result).toMatchObject({ outcome: "LIVE" });
    if (result.outcome === "LIVE") expect(result.data[0]?.totalPrice).toBe(850.5);
  });

  it("rejects a structurally valid response when no itinerary has a usable price", async () => {
    const unpricedPayload = structuredClone(validPayload);
    delete unpricedPayload.itineraries[0].cheapest_price;
    unpricedPayload.itineraries[0].pricing_options = [{ id: "unpriced", price: { amount: null } }];
    const result = await provider(async () => new Response(JSON.stringify(unpricedPayload), { status: 200 })).searchFlights(request);
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "NO_RESULTS" });
  });

  it.each([
    [200, { ...validPayload, itineraries: [] }, "NO_RESULTS"],
    [200, { bad: true }, "INVALID_PROVIDER_RESPONSE"],
    [401, {}, "PROVIDER_NOT_APPROVED"],
    [403, {}, "PROVIDER_NOT_APPROVED"],
    [429, {}, "RATE_LIMITED"],
    [503, {}, "UPSTREAM_FAILURE"],
  ])("fails closed for response %s", async (status, body, reason) => {
    const result = await provider(async () => new Response(JSON.stringify(body), { status })).searchFlights(request);
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason });
  });

  it("propagates aborts as a bounded unavailable result", async () => {
    const result = await provider(async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; }).searchFlights(request);
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "UPSTREAM_TIMEOUT" });
  });

  it("validates configuration and factory selection without a fallback", () => {
    expect(() => readFlightApiConfiguration({})).toThrow("FLIGHTAPI_API_KEY");
    expect(createFlightProvider({ FLIGHT_PROVIDER: "flightapi", FLIGHTAPI_API_KEY: "test-only-key" })).toBeInstanceOf(FlightApiProvider);
    expect(createFlightProvider({ FLIGHT_PROVIDER: "amadeus", AMADEUS_ENVIRONMENT: "test", NODE_ENV: "test", AMADEUS_CLIENT_ID: "id", AMADEUS_CLIENT_SECRET: "secret" })).toBeInstanceOf(AmadeusFlightProvider);
    expect(() => createFlightProvider({ FLIGHT_PROVIDER: "other" })).toThrow("FLIGHT_PROVIDER");
    expect(() => createFlightProvider({ FLIGHT_PROVIDER: "flightapi" })).toThrow("FLIGHTAPI_API_KEY");
  });
});
