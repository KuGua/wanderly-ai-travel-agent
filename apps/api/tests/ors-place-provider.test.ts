import { describe, expect, it, vi } from "vitest";
import { ORS_ATTRIBUTION, OrsPlaceProvider } from "../src/providers/ors-place-provider.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const baseOptions = {
  apiKey: "test-key",
  baseUrl: "https://ors.test",
  timeoutMs: 1000,
};
const destination = {
  destinationId: "tokyo",
  cityName: "Tokyo",
  countryCode: "JP",
  latitude: 35.6812,
  longitude: 139.7671,
};

describe("OrsPlaceProvider", () => {
  it("ORS_ATTRIBUTION string is the required ToS line", () => {
    expect(ORS_ATTRIBUTION).toBe("© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors");
  });

  it("maps upstream 5xx to UPSTREAM_FAILURE", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "down" }));
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchPlaces({
      destination,
      keyword: "ramen",
      category: "RESTAURANT",
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("UPSTREAM_FAILURE");
  });

  it("maps 429 to RATE_LIMITED", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: "rate" }));
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchPlaces({
      destination,
      keyword: "ramen",
      category: "RESTAURANT",
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("RATE_LIMITED");
  });

  it("normalizes a live geocoding response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [139.69, 35.68] },
          properties: {
            layer: "food",
            name: "Sushi Saito",
            country_a: "JP",
            region_a: "Tokyo",
            locality: "Tokyo",
            confidence: 0.93,
            match_type: "exact",
          },
        },
      ],
    }));
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchPlaces({
      destination,
      keyword: "sushi",
      category: "RESTAURANT",
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.outcome).toBe("LIVE");
    if (result.outcome === "LIVE") {
      expect(result.data).toHaveLength(1);
      const [first] = result.data;
      expect(first.displayName).toBe("Sushi Saito");
      expect(first.kind).toBe("RESTAURANT");
      expect(first.countryCode).toBe("JP");
      expect(first.cityName).toBe("Tokyo");
      expect(first.confidence).toBe(0.93);
      expect(first.needsUserConfirmation).toBe(false);
    }
  });

  it("flags low-confidence candidates as needsUserConfirmation", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [139.69, 35.68] },
            properties: { layer: "venue", name: "Maybe", country_a: "JP", confidence: 0.4 },
        },
      ],
    }));
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchPlaces({
      destination,
      keyword: "tower",
      category: "ATTRACTION",
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });
    if (result.outcome === "LIVE") {
      expect(result.data[0].needsUserConfirmation).toBe(true);
    } else {
      throw new Error("expected LIVE outcome");
    }
  });

  it("returns NO_RESULTS when no candidates are usable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      type: "FeatureCollection",
      features: [],
    }));
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchPlaces({
      destination,
      keyword: "nothing",
      category: "ATTRACTION",
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("NO_RESULTS");
  });

  it("maps parse failures to INVALID_PROVIDER_RESPONSE", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { type: "Unexpected" }));
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchPlaces({
      destination,
      keyword: "ramen",
      category: "RESTAURANT",
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("INVALID_PROVIDER_RESPONSE");
  });

  it("uses only valid venue layers and the resolved ISO country boundary", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("layers")).toBe("venue");
      expect(url.searchParams.get("boundary.country")).toBe("JP");
      return jsonResponse(200, { type: "FeatureCollection", features: [] });
    });
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    await provider.searchPlaces({ destination, keyword: "hotel", category: "HOTEL", snapshotId: "11111111-1111-4111-8111-111111111111" });
  });
});
