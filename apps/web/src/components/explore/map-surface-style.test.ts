import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { GEBCO_LAYER_ID, GEBCO_SOURCE_ID, GEBCO_WMS_TILE_URL, solidifyGlobeStyle, WANDERLY_OCEAN_COLOR } from "./map-surface-style";

describe("solidifyGlobeStyle", () => {
  it("adds opaque GEBCO relief above the tuned Natural Earth fallback", () => {
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
        "raster-brightness-min": 0.03,
        "raster-brightness-max": 0.92,
        "raster-saturation": 0.05,
        "raster-contrast": 0.25,
      },
    });
    expect(result.layers[2]).toMatchObject({
      id: GEBCO_LAYER_ID,
      type: "raster",
      source: GEBCO_SOURCE_ID,
      paint: { "raster-opacity": 1 },
    });
    expect(result.layers[3]).toMatchObject({
      paint: { "fill-color": WANDERLY_OCEAN_COLOR, "fill-opacity": 0.16 },
    });
    expect(result.sources[GEBCO_SOURCE_ID]).toMatchObject({
      type: "raster",
      tiles: [GEBCO_WMS_TILE_URL],
      maxzoom: 5,
    });
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
