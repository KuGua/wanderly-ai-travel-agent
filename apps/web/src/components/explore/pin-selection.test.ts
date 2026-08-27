import { describe, expect, it } from "vitest";

import { administrativeCentersFromFeatures, pinGranularityForZoom, pinSelectionForReference } from "./pin-selection";

const reference = {
  outcome: "REFERENCE" as const,
  country: "China",
  countryCode: "CN",
  admin1: "Zhejiang",
  admin1Code: "CN-ZJ",
  nearestCity: "Hangzhou",
  nearestCityCoordinates: { longitude: 120.1551, latitude: 30.2741 },
  distanceKm: 1,
  source: "Natural Earth + GeoNames" as const,
  datasetVersion: "test",
  checkedAt: "2026-08-27T00:00:00.000Z",
  isTravelFact: false as const,
};

const centers = administrativeCentersFromFeatures([
  point("country", "China", "中国", [104, 35]),
  point("region", "Zhejiang", "浙江", [120.1, 29.2]),
], "zh");

describe("zoom-aware pin selection", () => {
  it("maps zoom bands to country, province/state, and city clicks", () => {
    expect(pinGranularityForZoom(2.25)).toBe("country");
    expect(pinGranularityForZoom(4.5)).toBe("region");
    expect(pinGranularityForZoom(6.5)).toBe("city");
  });

  it("classifies the entity while retaining the exact manual click coordinate", () => {
    expect(pinSelectionForReference("country", reference, [120.2, 30.3], centers)).toEqual({
      granularity: "country",
      key: "country:CN",
      name: "中国",
      coordinates: [120.2, 30.3],
    });
    expect(pinSelectionForReference("region", reference, [120.2, 30.3], centers)).toEqual({
      granularity: "region",
      key: "region:CN:CN-ZJ",
      name: "浙江",
      coordinates: [120.2, 30.3],
    });
    expect(pinSelectionForReference("city", reference, [120.2, 30.3], centers)).toEqual({
      granularity: "city",
      key: "city:CN:hangzhou",
      name: "Hangzhou",
      coordinates: [120.2, 30.3],
      cityName: "Hangzhou",
    });
  });

  it("falls back from an unavailable city to the containing province", () => {
    expect(pinSelectionForReference("city", { ...reference, nearestCity: null, nearestCityCoordinates: null }, [120.2, 30.3], centers).granularity).toBe("region");
  });
});

function point(className: string, name: string, chineseName: string, coordinates: [number, number]): GeoJSON.Feature<GeoJSON.Point> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: { class: className, name, name_en: name, name_zh: chineseName },
  };
}
