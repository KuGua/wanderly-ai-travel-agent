import { describe, expect, it } from "vitest";
import { LocationReferenceResolver } from "../src/location-reference/location-reference-resolver.js";

const resolver = new LocationReferenceResolver([
  {
    properties: { ADMIN: "Testland", ISO_A2: "TL" },
    geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
  },
], [
  { name: "Example City", countryCode: "TL", latitude: 5, longitude: 5 },
], [
  {
    properties: { name: "Test Province", iso_3166_2: "TL-TP", iso_a2: "TL" },
    geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
  },
], { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" });

describe("LocationReferenceResolver", () => {
  it("returns a country and nearby city as a non-travel reference", () => {
    expect(resolver.resolve(5, 5)).toEqual({
      outcome: "REFERENCE",
      country: "Testland",
      countryCode: "TL",
      admin1: "Test Province",
      admin1Code: "TL-TP",
      nearestCity: "Example City",
      nearestCityCoordinates: { latitude: 5, longitude: 5 },
      distanceKm: 0,
      source: "Natural Earth + GeoNames",
      datasetVersion: "test.1",
      checkedAt: "2026-08-25T00:00:00.000Z",
      isTravelFact: false,
    });
  });

  it("does not fabricate a city when the closest indexed city is too distant", () => {
    const reference = resolver.resolve(0.1, 0.1);
    expect(reference).toMatchObject({
      outcome: "REFERENCE",
      country: "Testland",
      nearestCity: null,
      nearestCityCoordinates: null,
      distanceKm: null,
    });
  });

  it("returns no reference for a coordinate outside a country boundary", () => {
    expect(resolver.resolve(-5, -5)).toMatchObject({ outcome: "NO_REFERENCE", isTravelFact: false });
  });

});
