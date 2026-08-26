import { render, waitFor } from "@testing-library/react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CountryBoundaryOverlay } from "./country-boundary-overlay";

const collection: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[1, 2], [3, 4], [1, 2]]] },
  }],
};

describe("CountryBoundaryOverlay fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("only renders fallback strokes when requested", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => collection,
    }));
    const map = {
      getContainer: () => ({ clientWidth: 400, clientHeight: 300 }),
      getCenter: () => ({ lng: 0, lat: 0 }),
      getZoom: () => 2.25,
      project: ([longitude, latitude]: [number, number]) => ({ x: longitude * 10, y: latitude * 10 }),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as MapLibreMap;

    const view = render(<CountryBoundaryOverlay map={map} visible={false} />);

    expect(view.container.querySelector("[data-wanderly-country-boundaries='true']")).toBeNull();

    view.rerender(<CountryBoundaryOverlay map={map} visible />);
    await waitFor(() => expect(view.container.querySelector("path[stroke='#073d50']")).not.toBeNull());
    await waitFor(() => expect(map.on).toHaveBeenCalledWith("render", expect.any(Function)));
    expect(map.on).not.toHaveBeenCalledWith("move", expect.any(Function));
    expect(fetch).toHaveBeenCalledWith("/map-data/country-borders-lod0.geojson");
    expect(fetch).toHaveBeenCalledWith("/map-data/china-maritime-line.geojson");
  });

  it("does not request full-fidelity tiles while zoomed out", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => collection });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<CountryBoundaryOverlay map={closeUpMap(2.25)} visible />);

    await waitFor(() => expect(view.container.querySelector("path[stroke='#073d50']")).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalledWith("/map-data/country-borders-lod3/index.json");
  });

  it("fetches only the viewport's tiles when zoomed in", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: async () => (url.endsWith("index.json")
        ? { schemaVersion: 1, minZoom: 5.5, tileSizeDegrees: 20, tiles: [{ key: "100_0" }, { key: "0_40" }] }
        : collection),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<CountryBoundaryOverlay map={closeUpMap(9)} visible />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/map-data/country-borders-lod3/100_0.geojson"));
    expect(fetchMock).not.toHaveBeenCalledWith("/map-data/country-borders-lod3/0_40.geojson");
    expect(view.container.querySelector("path[stroke='#073d50']")).not.toBeNull();
  });

  it("keeps drawing the simplified mesh when the tile index is unavailable", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => (url.endsWith("index.json")
      ? Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
      : Promise.resolve({ ok: true, json: async () => collection })));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<CountryBoundaryOverlay map={closeUpMap(9)} visible />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/map-data/country-borders-lod3/index.json"));
    await waitFor(() => expect(view.container.querySelector("path[stroke='#073d50']")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith("/map-data/country-borders-lod1.geojson");
  });
});

function closeUpMap(zoom: number) {
  return {
    getContainer: () => ({ clientWidth: 400, clientHeight: 300 }),
    getCenter: () => ({ lng: 103.85, lat: 1.35 }),
    getZoom: () => zoom,
    getBounds: () => ({ getWest: () => 103.6, getSouth: () => 1.2, getEast: () => 104.1, getNorth: () => 1.5 }),
    project: ([longitude, latitude]: [number, number]) => ({ x: longitude * 10, y: latitude * 10 }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as MapLibreMap;
}
