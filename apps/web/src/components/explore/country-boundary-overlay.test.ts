import { describe, expect, it } from "vitest";

import { countryBoundaryLodForZoom, isCoordinateOnVisibleHemisphere, projectCountryBoundaryPaths } from "./country-boundary-overlay";

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

    expect(paths).toEqual(["M0.00 0.00 L90.00 0.00 M90.00 0.00 L10.00 0.00 L0.00 0.00 "]);
    expect(isCoordinateOnVisibleHemisphere([180, 0], [0, 0])).toBe(false);
  });

  it("clips crossing segments at the globe horizon instead of popping whole edges", () => {
    const paths = projectCountryBoundaryPaths({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[80, 0], [100, 0], [80, 0]]] },
      }],
    }, ([lng, lat]) => ({ x: lng, y: lat }), 400, (coordinates) => isCoordinateOnVisibleHemisphere(coordinates, [0, 0]));

    expect(paths).toEqual(["M80.00 0.00 L90.00 0.00 M90.00 0.00 L80.00 0.00 "]);
  });
});

describe("country boundary LODs", () => {
  it("selects one local mesh for each zoom band", () => {
    expect(countryBoundaryLodForZoom(0)).toBe("lod0");
    expect(countryBoundaryLodForZoom(3.4)).toBe("lod1");
    expect(countryBoundaryLodForZoom(5.5)).toBe("lod2");
  });

  it("projects a shared mesh line only once", () => {
    const paths = projectCountryBoundaryPaths({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { class: "country-boundary" },
        geometry: { type: "MultiLineString", coordinates: [[[1, 2], [3, 4]]] },
      }],
    }, ([lng, lat]) => ({ x: lng * 10, y: lat * 10 }), 400);

    expect(paths).toEqual(["M10.00 20.00 L30.00 40.00 "]);
  });
});
