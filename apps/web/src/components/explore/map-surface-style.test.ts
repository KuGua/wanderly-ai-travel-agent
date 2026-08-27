import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { CHINA_MARITIME_LINE_DATA_URL, COUNTRY_BOUNDARY_LOD_DATA_URLS, COUNTRY_BOUNDARY_TILE_INDEX_URL, countryBoundaryTileUrl, GEBCO_LAYER_ID, GEBCO_MAX_ZOOM, GEBCO_MIN_ZOOM, GEBCO_SOURCE_ID, GEBCO_SOURCE_MIN_ZOOM, GEBCO_TILE_SIZE, GEBCO_WMS_TILE_URL, solidifyGlobeStyle, WANDERLY_OCEAN_COLOR } from "./map-surface-style";

describe("country boundary assets", () => {
  it("uses only local versioned boundary URLs", () => {
    expect(COUNTRY_BOUNDARY_LOD_DATA_URLS).toEqual({
      lod0: "/map-data/country-borders-lod0.geojson",
      lod1: "/map-data/country-borders-lod1.geojson",
    });
    expect(CHINA_MARITIME_LINE_DATA_URL).toBe("/map-data/china-maritime-line.geojson");
    expect(COUNTRY_BOUNDARY_TILE_INDEX_URL).toBe("/map-data/country-borders-lod3/index.json");
    expect(countryBoundaryTileUrl("100_0")).toBe("/map-data/country-borders-lod3/100_0.geojson");
  });
});

describe("solidifyGlobeStyle", () => {
  it("keeps a continuous GEBCO-enhanced globe while bounding WMS request fan-out", () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: "background", type: "background", paint: { "background-color": "#fff" } },
        { id: "natural_earth", type: "raster", source: "earth", paint: { "raster-opacity": 0.1 } },
        { id: "renamed-ocean", type: "fill", source: "tiles", "source-layer": "water", paint: { "fill-color": "#fff", "fill-opacity": 0.4 } },
      ],
    } as StyleSpecification;

    const result = solidifyGlobeStyle(style);

    expect(result.layers[0]).toMatchObject({
      paint: { "background-color": WANDERLY_OCEAN_COLOR, "background-opacity": 1 },
    });
    expect(result.layers[1]).toMatchObject({
      layout: { visibility: "visible" },
      paint: {
        "raster-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.78, 3, 0.7, 6, 0.5],
        "raster-brightness-min": 0.04,
        "raster-brightness-max": 0.95,
        "raster-saturation": 0.35,
        "raster-contrast": 0.18,
      },
    });
    expect(result.layers[2]).toMatchObject({
      id: GEBCO_LAYER_ID,
      type: "raster",
      source: GEBCO_SOURCE_ID,
      paint: {
        "raster-opacity": ["interpolate", ["linear"], ["zoom"], 2.25, 1, 6, 1],
      },
    });
    expect(result.layers[3]).toMatchObject({
      paint: { "fill-color": WANDERLY_OCEAN_COLOR, "fill-opacity": 1 },
    });
    expect(result.sources[GEBCO_SOURCE_ID]).toMatchObject({
      type: "raster",
      tiles: [GEBCO_WMS_TILE_URL],
      minzoom: GEBCO_SOURCE_MIN_ZOOM,
      maxzoom: GEBCO_MAX_ZOOM,
      tileSize: GEBCO_TILE_SIZE,
    });
    expect(GEBCO_MIN_ZOOM).toBe(2.25);
    expect(GEBCO_SOURCE_MIN_ZOOM).toBe(1);
    expect(GEBCO_TILE_SIZE).toBe(1024);
    expect(result.layers[1]).not.toHaveProperty("maxzoom");
  });

  it("does not disable unrelated raster layers", () => {
    const style = {
      version: 8,
      sources: {},
      layers: [{ id: "satellite", type: "raster", source: "satellite" }],
    } as StyleSpecification;

    expect(solidifyGlobeStyle(style).layers[0]).toEqual(style.layers[0]);
  });
});
