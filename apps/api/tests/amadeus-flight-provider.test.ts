import { describe, expect, it } from "vitest";
import { AmadeusFlightProvider, readAmadeusConfiguration } from "../src/providers/amadeus-flight-provider.js";

const token = { access_token: "token-value", expires_in: 3600 };
const offer = {
  data: [{
    id: "1", itineraries: [{ duration: "PT12H", segments: [{
      departure: { iataCode: "SFO", at: "2026-10-01T08:00:00Z" },
      arrival: { iataCode: "NRT", at: "2026-10-01T20:00:00Z" },
      carrierCode: "NH", number: "7", duration: "PT12H",
    }] }], price: { total: "850.50", currency: "USD" },
    travelerPricings: [{ fareDetailsBySegment: [{ cabin: "ECONOMY", includedCheckedBags: { quantity: 1 } }] }],
    lastTicketingDate: "2026-09-01",
  }],
};

function provider(responses: Response[]) {
  return new AmadeusFlightProvider({
    environment: "test", clientId: "id", clientSecret: "secret", timeoutMs: 500,
    fetch: async () => responses.shift()!, now: () => new Date("2026-08-27T00:00:00Z"),
  });
}

const request = { origin: "SFO", destination: "NRT", dateStart: "2026-10-01", dateEnd: "2026-10-10", snapshotId: "00000000-0000-4000-8000-000000000001" };

describe("AmadeusFlightProvider", () => {
  it("acquires OAuth and returns normalized offers without raw payload", async () => {
    const result = await provider([
      new Response(JSON.stringify(token), { status: 200 }),
      new Response(JSON.stringify(offer), { status: 200 }),
    ]).searchFlights({ ...request, adults: 2, cabin: "ECONOMY", currency: "USD" });
    expect(result).toMatchObject({ outcome: "LIVE", source: "Amadeus Flight Offers Search" });
    if (result.outcome === "LIVE") expect(result.data[0]).toMatchObject({
      providerOfferId: "1", origin: "SFO", destination: "NRT", totalPrice: 850.5, currency: "USD", adults: 2,
      baggageSummary: "1 checked bag(s) included",
    });
  });

  it.each([
    [200, { data: [] }, "NO_RESULTS"],
    [429, {}, "RATE_LIMITED"],
    [503, {}, "UPSTREAM_FAILURE"],
    [200, { data: [{ bad: true }] }, "INVALID_PROVIDER_RESPONSE"],
  ])("maps response %s to %s", async (status, body, reason) => {
    const result = await provider([
      new Response(JSON.stringify(token), { status: 200 }), new Response(JSON.stringify(body), { status }),
    ]).searchFlights(request);
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason });
  });

  it("maps abort and timeout failures to UPSTREAM_TIMEOUT", async () => {
    const result = await new AmadeusFlightProvider({
      environment: "test", clientId: "id", clientSecret: "secret", timeoutMs: 1,
      fetch: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; },
    }).searchFlights(request);
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "UPSTREAM_TIMEOUT" });
  });

  it("rejects test configuration outside development/test and incomplete production configuration", () => {
    expect(() => readAmadeusConfiguration({ AMADEUS_ENVIRONMENT: "test", NODE_ENV: "production", AMADEUS_CLIENT_ID: "id", AMADEUS_CLIENT_SECRET: "secret" })).toThrow("only in development or test");
    expect(() => readAmadeusConfiguration({ AMADEUS_ENVIRONMENT: "production" })).toThrow("credentials");
  });
});
