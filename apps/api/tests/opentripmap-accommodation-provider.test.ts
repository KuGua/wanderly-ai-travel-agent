import { describe, expect, it, vi } from "vitest";

import {
  OpenTripMapAccommodationProvider,
  readOpenTripMapAccommodationConfiguration,
} from "../src/providers/opentripmap-accommodation-provider.js";
import { accommodationDiscoverySkill } from "../src/skills/shared/accommodation-discovery-skill.js";
import { accommodationDiscoveryOutputSchema } from "../src/skills/shared/accommodation-discovery-skill.js";
import { randomUUID } from "node:crypto";

const destination = {
  destinationId: "tokyo",
  cityName: "Tokyo",
  countryCode: "JP",
  latitude: 35.6812,
  longitude: 139.7671,
};

describe("OpenTripMapAccommodationProvider", () => {
  it("uses resolved coordinates and returns normalized non-price candidates", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("lat")).toBe(String(destination.latitude));
      expect(url.searchParams.get("lon")).toBe(String(destination.longitude));
      expect(url.searchParams.get("kinds")).toBe("accomodations");
      expect(url.searchParams.get("apikey")).toBe("secret");
      return jsonResponse([{
        xid: "N123", name: "Station Hotel", kinds: "hotels,accomodations",
        dist: 250, rate: 3, point: { lon: 139.769, lat: 35.682 },
        wikidata: "Q1", osm: "node/123",
      }]);
    }) as typeof fetch;
    const result = await provider(fetchImpl).discoverAccommodations({ destination, limit: 10 });
    expect(result).toMatchObject({
      outcome: "LIVE",
      source: "OpenTripMap",
      data: [{
        providerPlaceId: "N123",
        name: "Station Hotel",
        kind: "hotels",
        distanceMeters: 250,
        popularityTier: 3,
        attribution: "© OpenStreetMap contributors",
      }],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("wikidata");
  });

  /**
   * OpenTripMap rates 1–3 and reserves the upper band for cultural-heritage
   * listings, so a real Shanghai answer carries tiers 5, 6 and 7 alongside
   * 1–3. The evidence schema used to stop at 3. Because the skill registry
   * validates a skill's output *after* the handler has already persisted its
   * rows, the whole capability was reported to the traveller as a provider
   * outage for a search that had in fact returned sixteen live stays.
   */
  it("passes heritage-band ratings through to a valid skill output", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      [5, 6, 7].map((rate, index) => ({
        xid: `N${index}`, name: `Heritage stay ${index}`, kinds: "hotels,accomodations",
        dist: 100 + index, rate, point: { lon: 121.458, lat: 31.222 },
      })),
    )) as typeof fetch;
    const result = await provider(fetchImpl).discoverAccommodations({ destination, limit: 20 });
    expect(result.outcome).toBe("LIVE");
    if (result.outcome !== "LIVE") return;
    expect(result.data.map((item) => item.popularityTier)).toEqual([5, 6, 7]);

    // The registry parses exactly this shape; anything it rejects here is a
    // silent capability outage in production.
    const queryId = randomUUID();
    const parsed = accommodationDiscoveryOutputSchema.safeParse({
      outcome: "LIVE",
      queryId,
      accommodations: result.data.map((item) => ({
        ...item,
        id: randomUUID(),
        queryId,
        destinationId: destination.destinationId,
        expiresAt: new Date(Date.parse(item.capturedAt) + 86_400_000).toISOString(),
      })),
    });
    expect(accommodationDiscoverySkill.output).toBe(accommodationDiscoveryOutputSchema);
    expect(parsed.success).toBe(true);
  });

  it("fails closed on authentication, limits and schema drift", async () => {
    await expect(provider(vi.fn(async () => jsonResponse({}, 403)) as typeof fetch)
      .discoverAccommodations({ destination, limit: 10 }))
      .resolves.toEqual({ outcome: "UNAVAILABLE", reason: "PROVIDER_NOT_APPROVED" });
    await expect(provider(vi.fn(async () => jsonResponse({}, 429)) as typeof fetch)
      .discoverAccommodations({ destination, limit: 10 }))
      .resolves.toEqual({ outcome: "UNAVAILABLE", reason: "RATE_LIMITED" });
    await expect(provider(vi.fn(async () => jsonResponse([{ bad: true }])) as typeof fetch)
      .discoverAccommodations({ destination, limit: 10 }))
      .resolves.toEqual({ outcome: "UNAVAILABLE", reason: "INVALID_PROVIDER_RESPONSE" });
  });
});

describe("readOpenTripMapAccommodationConfiguration", () => {
  it("is opt-in and requires a key", () => {
    expect(readOpenTripMapAccommodationConfiguration({})).toBeNull();
    expect(readOpenTripMapAccommodationConfiguration({ OPENTRIPMAP_ACCOMMODATION_ENABLED: "true" })).toBeNull();
    expect(readOpenTripMapAccommodationConfiguration({
      OPENTRIPMAP_ACCOMMODATION_ENABLED: "true",
      OPENTRIPMAP_API_KEY: "key",
    })).toMatchObject({ timeoutMs: 8_000, radiusMeters: 10_000, maxResults: 20 });
  });
});

function provider(fetchImpl: typeof fetch) {
  return new OpenTripMapAccommodationProvider({
    apiKey: "secret",
    baseUrl: "https://opentripmap.test/0.1",
    timeoutMs: 1_000,
    radiusMeters: 10_000,
    maxResults: 20,
    fetchImpl,
    now: () => new Date("2026-08-30T10:00:00.000Z"),
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
