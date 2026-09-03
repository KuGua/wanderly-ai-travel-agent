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
      // A real lastTicketingDate is a genuine supplier commitment — the
      // freshness guard (flight-offer-freshness-service.ts) only trusts
      // offers persisted with this exact provenance value.
      expiryProvenance: "PROVIDER_VERIFIED",
      expiresAt: "2026-09-01T23:59:59.999Z",
    });
  });

  it("falls back to a SYNTHETIC (not PROVIDER_VERIFIED) expiry when lastTicketingDate is absent", async () => {
    const offerWithoutTicketingDate = {
      data: [{ ...offer.data[0], lastTicketingDate: undefined }],
    };
    const result = await provider([
      new Response(JSON.stringify(token), { status: 200 }),
      new Response(JSON.stringify(offerWithoutTicketingDate), { status: 200 }),
    ]).searchFlights({ ...request, adults: 2, cabin: "ECONOMY", currency: "USD" });
    expect(result).toMatchObject({ outcome: "LIVE" });
    if (result.outcome === "LIVE") expect(result.data[0]).toMatchObject({
      // No real supplier commitment exists for this offer — this is only a
      // local cache-freshness heuristic and must never be treated as
      // booking-eligible, regardless of provider name.
      expiryProvenance: "SYNTHETIC",
      expiresAt: "2026-08-27T00:15:00.000Z",
    });
  });

  // P1-B: the provider now retries transient upstream failures under the
  // unified resilience-policy loop. The tests therefore must provide
  // enough mock responses to cover the retry budget (maxAttempts = 2 by
  // default for the `flight` capability) before the request can be
  // classified. Each `transient` case below provides two 429/503
  // responses (token + flight-offers) and the test asserts the *final*
  // outcome — the intermediate retries are an implementation detail
  // validated by the smoke tests, not by this unit surface.
  it.each([
    [200, { data: [] }, "NO_RESULTS"],
    [429, {}, "RATE_LIMITED"],
    [503, {}, "UPSTREAM_FAILURE"],
    [200, { data: [{ bad: true }] }, "INVALID_PROVIDER_RESPONSE"],
  ])("maps response %s to %s", async (status, body, reason) => {
    const isTransient = status === 429 || status >= 500;
    const flightResponse = isTransient
      // Two copies of the transient response so the retry budget
      // (maxAttempts = 2) can exhaust without the mock falling through to
      // an undefined return. The 20s rate-limited backoff is overridden
      // below via env so the test does not sleep 20s.
      ? [new Response(JSON.stringify(body), { status }), new Response(JSON.stringify(body), { status })]
      : [new Response(JSON.stringify(body), { status })];
    const previous = process.env.AMADEUS_FLIGHT_RETRY_BACKOFF_MS;
    process.env.AMADEUS_FLIGHT_RETRY_BACKOFF_MS = "1";
    try {
      const result = await provider([
        new Response(JSON.stringify(token), { status: 200 }),
        ...flightResponse,
      ]).searchFlights(request);
      expect(result).toEqual({ outcome: "UNAVAILABLE", reason });
    } finally {
      if (previous === undefined) delete process.env.AMADEUS_FLIGHT_RETRY_BACKOFF_MS;
      else process.env.AMADEUS_FLIGHT_RETRY_BACKOFF_MS = previous;
    }
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
