import { describe, expect, it } from "vitest";

import { globalBoundariesWithoutChina, isCoordinateOnVisibleHemisphere, projectCountryBoundaryPaths } from "./country-boundary-overlay";

describe("projectCountryBoundaryPaths", () => {
  it("projects polygon rings into SVG paths without MapLibre GeoJSON sources", () => {
    const paths = projectCountryBoundaryPaths({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[1, 2], [3, 4], [1, 2]]] },
      }],
    }, ([lng, lat]) => ({ x: lng * 10, y: lat * 10 }), 400);

    expect(paths).toEqual(["M10.00 20.00 L30.00 40.00 L10.00 20.00 "]);
  });

  it("splits a path instead of drawing across the globe seam", () => {
    const paths = projectCountryBoundaryPaths({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[0, 0], [100, 0], [0, 0]]] },
      }],
    }, ([lng, lat]) => ({ x: lng, y: lat }), 100);

    expect(paths[0]).toContain("M0.00 0.00 M100.00 0.00 M0.00 0.00");
  });

  it("drops boundary vertices on the back hemisphere", () => {
    const paths = projectCountryBoundaryPaths({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[0, 0], [180, 0], [10, 0], [0, 0]]] },
      }],
    }, ([lng, lat]) => ({ x: lng, y: lat }), 400, (coordinates) => isCoordinateOnVisibleHemisphere(coordinates, [0, 0]));

    expect(paths).toEqual(["M0.00 0.00 M10.00 0.00 L0.00 0.00 "]);
    expect(isCoordinateOnVisibleHemisphere([180, 0], [0, 0])).toBe(false);
  });
});

describe("globalBoundariesWithoutChina", () => {
  it("lets the China-specific outline replace conflicting Natural Earth features", () => {
    const collection = globalBoundariesWithoutChina({
      type: "FeatureCollection",
      features: ["USA", "CHN", "TWN"].map((code) => ({
        type: "Feature" as const,
        properties: { ADM0_A3: code },
        geometry: { type: "Polygon" as const, coordinates: [] },
      })),
    });

    expect(collection.features.map((feature) => feature.properties?.ADM0_A3)).toEqual(["USA"]);
  });
});
