import { describe, expect, it, vi } from "vitest";
import { AMADEUS_TRANSFER_ATTRIBUTION, AmadeusTransferProvider } from "../src/providers/amadeus-transfer-provider.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const TOKEN_RESPONSE = { access_token: "test-token", expires_in: 1800 };

const baseOptions = {
  environment: "test" as const,
  clientId: "test-id",
  clientSecret: "test-secret",
  timeoutMs: 1_000,
};

function tokenThenSearch(searchBody: unknown) {
  let called = 0;
  const fn = vi.fn(async () => {
    called += 1;
    if (called === 1) return jsonResponse(200, TOKEN_RESPONSE);
    return jsonResponse(200, searchBody);
  });
  return fn;
}

describe("AmadeusTransferProvider", () => {
  it("AMADEUS_TRANSFER_ATTRIBUTION is the human-readable label", () => {
    expect(AMADEUS_TRANSFER_ATTRIBUTION).toBe("Amadeus Transfer Search");
  });

  it("maps upstream 5xx to UPSTREAM_FAILURE", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "down" }));
    const provider = new AmadeusTransferProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchOffers({
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      passengers: 2,
      departureAt: "2026-09-01T10:00:00Z",
      serviceType: "TAXI",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("UPSTREAM_FAILURE");
  });

  it("maps 429 to RATE_LIMITED", async () => {
    let called = false;
    const fetchImpl = vi.fn(async () => {
      if (!called) { called = true; return jsonResponse(200, TOKEN_RESPONSE); }
      return jsonResponse(429, { error: "rate" });
    });
    const provider = new AmadeusTransferProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchOffers({
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      passengers: 2,
      departureAt: "2026-09-01T10:00:00Z",
      serviceType: "TRANSFER",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("RATE_LIMITED");
  });

  it("normalizes a live transfer response and drops bookingUrl", async () => {
    const fetchImpl = tokenThenSearch({
      data: [{
        id: "offer-1",
        serviceType: "TAXI",
        passengers: 2,
        departureAt: "2026-09-01T10:00:00.000Z",
        estimatedPrice: 45.5,
        currency: "USD",
        vehicleClass: "Sedan",
        estimated: true,
        expiresAt: "2026-09-01T11:00:00.000Z",
        bookingUrl: "https://attacker.example/book/offer-1",
      }],
    });
    const provider = new AmadeusTransferProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchOffers({
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      passengers: 2,
      departureAt: "2026-09-01T10:00:00Z",
      serviceType: "TAXI",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.outcome).toBe("LIVE");
    if (result.outcome === "LIVE") {
      expect(result.data).toHaveLength(1);
      const offer = result.data[0];
      expect(offer.estimated).toBe(true);
      expect(offer.estimatedPrice).toBe(45.5);
      expect(offer.currency).toBe("USD");
      expect(offer.serviceType).toBe("TAXI");
      // The normalized shape MUST NOT carry bookingUrl even if the
      // upstream payload did.
      expect("bookingUrl" in offer).toBe(false);
    }
  });

  it("returns NO_RESULTS when no offers are returned", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      const idx = calls.length;
      calls.push({ url, method: init.method ?? "GET", body: init.body });
      if (idx === 0) return jsonResponse(200, TOKEN_RESPONSE);
      return jsonResponse(200, { data: [] });
    });
    const provider = new AmadeusTransferProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchOffers({
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      passengers: 2,
      departureAt: "2026-09-01T10:00:00Z",
      serviceType: "CHARTER",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    if (result.outcome === "UNAVAILABLE" && result.reason !== "NO_RESULTS") {
      console.error("[test-debug] calls:", calls);
      console.error("[test-debug] result:", result);
    }
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("NO_RESULTS");
  });

  it("maps parse failures to INVALID_PROVIDER_RESPONSE", async () => {
    const fetchImpl = tokenThenSearch({ data: [{ bogus: "shape" }] });
    const provider = new AmadeusTransferProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchOffers({
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      passengers: 2,
      departureAt: "2026-09-01T10:00:00Z",
      serviceType: "RENTAL",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("INVALID_PROVIDER_RESPONSE");
  });
});
