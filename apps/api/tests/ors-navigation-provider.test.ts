import { describe, expect, it, vi } from "vitest";
import { ORS_ATTRIBUTION, OrsNavigationProvider } from "../src/providers/ors-navigation-provider.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const baseOptions = {
  apiKey: "test-key",
  baseUrl: "https://ors.test",
  timeoutMs: 1_000,
};

describe("OrsNavigationProvider", () => {
  it("ORS_ATTRIBUTION string is the required ToS line", () => {
    expect(ORS_ATTRIBUTION).toBe("© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors");
  });

  it("maps upstream 5xx to UPSTREAM_FAILURE", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "down" }));
    const provider = new OrsNavigationProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchRoute({
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      originCoordinate: { longitude: 139.7671, latitude: 35.6812 },
      destinationCoordinate: { longitude: 139.7005, latitude: 35.6896 },
      mode: "WALK",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("UPSTREAM_FAILURE");
  });

  it("maps 429 to RATE_LIMITED", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: "rate" }));
    const provider = new OrsNavigationProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchRoute({
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      originCoordinate: { longitude: 139.7671, latitude: 35.6812 },
      destinationCoordinate: { longitude: 139.7005, latitude: 35.6896 },
      mode: "DRIVE",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("RATE_LIMITED");
  });

  it("normalizes a live directions response (LineString)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {
          summary: { distance: 1500, duration: 600 },
          segments: [{
            distance: 1500, duration: 600,
            steps: [
              { distance: 800, duration: 300, instruction: "Head north", name: "Main St" },
              { distance: 700, duration: 300, instruction: "Turn right", name: "Elm St" },
            ],
          }],
        },
        geometry: {
          type: "LineString",
          coordinates: [[0, 0], [0.01, 0], [0.01, 0.01]],
        },
      }],
      metadata: { attribution: "ORS" },
    }));
    const provider = new OrsNavigationProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchRoute({
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      originCoordinate: { longitude: 139.7671, latitude: 35.6812 },
      destinationCoordinate: { longitude: 139.7005, latitude: 35.6896 },
      mode: "WALK",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.outcome).toBe("LIVE");
    if (result.outcome === "LIVE") {
      expect(result.data.mode).toBe("WALK");
      expect(result.data.distanceMeters).toBe(1500);
      expect(result.data.durationSeconds).toBe(600);
      expect(result.data.steps).toHaveLength(2);
      expect(result.data.encodedGeometry.startsWith("[[")).toBe(true);
      expect(result.data.refreshAfter).toMatch(/T/);
    }
  });

  it("normalizes a live directions response (encoded_polyline)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { summary: { distance: 800, duration: 200 }, segments: [] },
        geometry: { type: "encoded_polyline", coordinates: "abCDeF" },
      }],
    }));
    const provider = new OrsNavigationProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchRoute({
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      originCoordinate: { longitude: 139.7671, latitude: 35.6812 },
      destinationCoordinate: { longitude: 139.7005, latitude: 35.6896 },
      mode: "CYCLE",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.outcome).toBe("LIVE");
    if (result.outcome === "LIVE") {
      expect(result.data.encodedGeometry).toBe("abCDeF");
      expect(result.data.steps).toHaveLength(0);
    }
  });

  it("maps parse failures to INVALID_PROVIDER_RESPONSE", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { type: "Unexpected" }));
    const provider = new OrsNavigationProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchRoute({
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      originCoordinate: { longitude: 139.7671, latitude: 35.6812 },
      destinationCoordinate: { longitude: 139.7005, latitude: 35.6896 },
      mode: "WALK",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome === "UNAVAILABLE") expect(result.reason).toBe("INVALID_PROVIDER_RESPONSE");
  });
});