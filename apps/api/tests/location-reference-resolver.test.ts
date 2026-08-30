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

  it("resolves a city label into a provider-safe destination reference", () => {
    expect(resolver.resolveDestinationReference({
      destinationId: "candidate-1",
      cityName: "Example City",
      countryHint: "TL",
    })).toEqual({
      destinationId: "candidate-1",
      cityName: "Example City",
      countryCode: "TL",
      latitude: 5,
      longitude: 5,
    });
  });

  it("fails closed when a city label is ambiguous across countries", () => {
    const ambiguous = new LocationReferenceResolver([
      { properties: { ADMIN: "One", ISO_A2: "AA" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } },
      { properties: { ADMIN: "Two", ISO_A2: "BB" }, geometry: { type: "Polygon", coordinates: [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]] } },
    ], [
      { name: "Springfield", countryCode: "AA", latitude: 0.5, longitude: 0.5 },
      { name: "Springfield", countryCode: "BB", latitude: 0.5, longitude: 2.5 },
    ], [], { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" });
    expect(ambiguous.resolveDestinationReference({ destinationId: "springfield", cityName: "Springfield" })).toBeNull();
    expect(ambiguous.resolveDestinationReference({
      destinationId: "springfield-aa", cityName: "Springfield", countryHint: "AA",
    })).toMatchObject({ countryCode: "AA", longitude: 0.5 });
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

  it("falls back to the nearest coast for offshore land the dataset omits", () => {
    // 1 km south of the polygon edge: an islet Natural Earth Admin 0 does not carry.
    expect(resolver.resolve(-0.009, 5)).toMatchObject({
      outcome: "REFERENCE",
      country: "Testland",
      countryCode: "TL",
      nearestCity: null,
    });
  });

  it("returns no reference beyond the coastal tolerance", () => {
    // ~22 km south of the polygon edge: open water, not omitted land.
    expect(resolver.resolve(-0.2, 5)).toMatchObject({ outcome: "NO_REFERENCE", isTravelFact: false });
  });

  it("projects districts and neighborhoods to city level without collapsing distinct cities", () => {
    const chinaResolver = new LocationReferenceResolver([
      {
        properties: { ADMIN: "China", ISO_A2: "CN" },
        geometry: { type: "Polygon", coordinates: [[[115, 28], [125, 28], [125, 34], [115, 34], [115, 28]]] },
      },
    ], [
      { name: "Shanghai", countryCode: "CN", latitude: 31.22222, longitude: 121.45806, featureCode: "PPLA", admin1Code: "23", admin2Code: "12324204" },
      { name: "Huangpu", countryCode: "CN", latitude: 31.23359, longitude: 121.479, featureCode: "PPL", admin1Code: "23", admin2Code: "12324204" },
      { name: "Pudong", countryCode: "CN", latitude: 31.23969, longitude: 121.49976, featureCode: "PPLA4", admin1Code: "23", admin2Code: "12324204" },
      { name: "Chongming", countryCode: "CN", latitude: 31.6229, longitude: 121.3972, featureCode: "PPLA3" },
      { name: "Luojing", countryCode: "CN", latitude: 31.4782, longitude: 121.33907, featureCode: "PPL", admin1Code: "23" },
      { name: "Nanjing", countryCode: "CN", latitude: 32.06167, longitude: 118.77778, featureCode: "PPLA", admin1Code: "04", admin2Code: "3201" },
      { name: "Suzhou", countryCode: "CN", latitude: 31.30408, longitude: 120.59538, featureCode: "PPLA2", admin1Code: "04", admin2Code: "3205" },
    ], [], { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" });

    expect(chinaResolver.resolve(31.23359, 121.479)).toMatchObject({
      nearestCity: "Shanghai",
      nearestCityCoordinates: { latitude: 31.22222, longitude: 121.45806 },
    });
    expect(chinaResolver.resolve(31.6229, 121.3972)).toMatchObject({ nearestCity: "Shanghai" });
    expect(chinaResolver.resolve(31.30408, 120.59538)).toMatchObject({ nearestCity: "Suzhou" });
  });

});
