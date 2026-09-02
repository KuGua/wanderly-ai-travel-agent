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

  it("keeps candidates whose alpha-3 country would truncate to another country", async () => {
    // ORS reports alpha-3. Cutting it to two characters is not a conversion:
    // CHN reads as CH (Switzerland), so every Chinese candidate used to fail
    // the alpha-2 comparison and be discarded. The country is taken from the
    // request instead, which is what `boundary.country` already filtered on.
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [121.47, 31.23] },
        properties: {
          layer: "venue", name: "Shanghai Museum", country_a: "CHN",
          locality: "Shanghai", confidence: 0.9,
        },
      }],
    }));
    const result = await new OrsPlaceProvider({ ...baseOptions, fetchImpl }).searchPlaces({
      destination: {
        destinationId: "shanghai", cityName: "Shanghai", countryCode: "CN",
        latitude: 31.2304, longitude: 121.4737,
      },
      keyword: "museum",
      category: "ATTRACTION",
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.outcome).toBe("LIVE");
    if (result.outcome !== "LIVE") return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0].countryCode).toBe("CN");
  });

  it("parses a response whose country code is alpha-3", async () => {
    // The schema required two characters, so every real response failed to
    // parse and the whole search became INVALID_PROVIDER_RESPONSE — a provider
    // that reads as unavailable rather than as broken.
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [139.69, 35.68] },
        properties: { layer: "venue", name: "Ohi Museum", country_a: "JPN", confidence: 1 },
      }],
    }));
    const result = await new OrsPlaceProvider({ ...baseOptions, fetchImpl }).searchPlaces({
      destination, keyword: "museum", category: "ATTRACTION",
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.outcome).toBe("LIVE");
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
            country_a: "JPN",
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
            properties: { layer: "venue", name: "Maybe", country_a: "JPN", confidence: 0.4 },
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

describe("OrsPlaceProvider: which question is being asked", () => {
  function feature(name: string, distance?: number) {
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [139.7967, 35.7148] },
      properties: { name, confidence: 0.9, ...(distance === undefined ? {} : { distance }) },
    };
  }
  function collection(...features: ReturnType<typeof feature>[]) {
    return jsonResponse(200, { type: "FeatureCollection", features });
  }

  it("asks what is nearby, rather than searching for the category name", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return collection(feature("Sensō Ji", 0.011));
    });
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchPlaces({
      destination, keyword: "", category: "ATTRACTION", radiusMeters: 1500,
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });

    expect(calls[0]).toContain("/geocode/reverse");
    expect(calls[0]).toContain("boundary.circle.radius=1.5");
    expect(calls[0]).not.toContain("text=");
    expect(result.outcome).toBe("LIVE");
    if (result.outcome === "LIVE") expect(result.data[0].displayName).toBe("Sensō Ji");
  });

  it("keeps a stated radius as a bound, not a preference", async () => {
    // ORS answers past the circle it was given; a place outside the radius is
    // a wrong answer however well its name matches.
    const fetchImpl = vi.fn(async () => collection(feature("Far Ramen", 3.2), feature("Near Ramen", 0.4)));
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchPlaces({
      destination, keyword: "ramen", category: "RESTAURANT", radiusMeters: 1000,
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.outcome).toBe("LIVE");
    if (result.outcome === "LIVE") {
      expect(result.data.map((candidate) => candidate.displayName)).toEqual(["Near Ramen"]);
      expect(result.data[0].distanceKm).toBe(0.4);
    }
  });

  it("answers a keyword that matches nothing with what is actually around the point", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return calls.length === 1 ? collection() : collection(feature("Asakusa Shrine", 0.07));
    });
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchPlaces({
      destination, keyword: "景点", category: "ATTRACTION", radiusMeters: 1500,
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });
    expect(calls[0]).toContain("/geocode/search");
    expect(calls[1]).toContain("/geocode/reverse");
    expect(result.outcome).toBe("LIVE");
  });

  it("does not offer a neighbour to a caller that asked where a named place is", async () => {
    // No radius means place adoption, where the answer has to be the place
    // that was named — anything else gets adopted as somewhere it is not.
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => { calls.push(String(url)); return collection(); });
    const provider = new OrsPlaceProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchPlaces({
      destination, keyword: "Hotel Gajoen", category: "HOTEL",
      snapshotId: "11111111-1111-4111-8111-111111111111",
    });
    expect(calls).toHaveLength(1);
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("NO_RESULTS");
  });
});
