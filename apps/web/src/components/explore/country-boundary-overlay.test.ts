import { describe, expect, it } from "vitest";

import { countryBoundaryLodForZoom, isCoordinateOnVisibleHemisphere, projectCountryBoundaryPaths, tileKeysForViewport, viewportBoundsFrom } from "./country-boundary-overlay";

const identityProjector = ([lng, lat]: [number, number]) => ({ x: lng, y: lat });

function meshOf(...lines: number[][][]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { class: "country-boundary" },
      geometry: { type: "MultiLineString", coordinates: lines },
    }],
  };
}

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

describe("viewport culling", () => {
  const singaporeView = viewportBoundsFrom({ west: 103.6, south: 1.2, east: 104.1, north: 1.5 }, 9);

  it("projects only the lines the camera can see", () => {
    const paths = projectCountryBoundaryPaths(
      meshOf([[103.7, 1.3], [103.9, 1.4]], [[2.2, 48.8], [2.4, 48.9]]),
      identityProjector,
      400,
      undefined,
      singaporeView,
    );

    expect(paths).toEqual(["M103.70 1.30 L103.90 1.40 "]);
  });

  it("keeps a line that crosses the viewport without ending inside it", () => {
    const paths = projectCountryBoundaryPaths(
      meshOf([[100, 1.35], [110, 1.35]]),
      identityProjector,
      400,
      undefined,
      singaporeView,
    );

    expect(paths).toHaveLength(1);
  });

  it("keeps both sides of a view that straddles the antimeridian", () => {
    const view = viewportBoundsFrom({ west: 178, south: -18, east: 182, north: -16 }, 9);
    const paths = projectCountryBoundaryPaths(
      meshOf([[179, -17], [179.5, -17.2]], [[-179, -17], [-178.5, -17.2]], [[0, -17], [1, -17.2]]),
      identityProjector,
      400,
      undefined,
      view,
    );

    expect(paths).toHaveLength(2);
  });

  it("does not cull while the camera still sees a hemisphere", () => {
    expect(viewportBoundsFrom({ west: -180, south: -85, east: 180, north: 85 }, 1)).toBeNull();
    expect(viewportBoundsFrom({ west: -180, south: -85, east: 180, north: 85 }, 6)).toBeNull();
  });

  it("draws every line when no viewport is supplied", () => {
    const paths = projectCountryBoundaryPaths(
      meshOf([[103.7, 1.3], [103.9, 1.4]], [[2.2, 48.8], [2.4, 48.9]]),
      identityProjector,
      400,
    );

    expect(paths).toHaveLength(2);
  });
});

describe("full-fidelity tile keys", () => {
  it("covers only the tiles the viewport touches", () => {
    const bounds = viewportBoundsFrom({ west: 103.6, south: 1.2, east: 104.1, north: 1.5 }, 9);

    expect(tileKeysForViewport(bounds!, 20)).toEqual(["100_0"]);
  });

  it("covers every tile a wider view spans, including the culling margin", () => {
    const bounds = viewportBoundsFrom({ west: 95, south: -5, east: 125, north: 25 }, 6);

    expect(tileKeysForViewport(bounds!, 20).sort()).toEqual(
      ["80_-20", "80_0", "80_20", "100_-20", "100_0", "100_20", "120_-20", "120_0", "120_20"].sort(),
    );
  });

  it("covers both sides of a view straddling the antimeridian", () => {
    const bounds = viewportBoundsFrom({ west: 178, south: -18, east: 182, north: -16 }, 9);

    expect(tileKeysForViewport(bounds!, 20).sort()).toEqual(["-180_-20", "160_-20"].sort());
  });

  it("clamps to the poles instead of inventing tiles beyond them", () => {
    const bounds = viewportBoundsFrom({ west: 10, south: 78, east: 20, north: 89 }, 6);

    expect(tileKeysForViewport(bounds!, 20).every((key) => Number(key.split("_")[1]) <= 80)).toBe(true);
  });
});

describe("country boundary LODs", () => {  it("selects one local mesh for each zoom band", () => {
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
