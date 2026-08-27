import { describe, expect, it } from "vitest";

import { geographyLabelsFromFeatures } from "./geography-label-overlay";

const visible = { countries: true, regions: true, cities: true };
const feature = (className: string, name: string, extras: Record<string, unknown> = {}) => ({
  type: "Feature" as const,
  geometry: { type: "Point" as const, coordinates: [100, 30] },
  properties: { class: className, name, "name:en": name, ...extras },
});

describe("geographyLabelsFromFeatures", () => {
  it("shows continents and leading countries before capitals enter at the next zoom tier", () => {
    const labels = geographyLabelsFromFeatures([
      feature("continent", "Asia", { "name:zh-Hans": "亚洲", rank: 1 }),
      feature("country", "China", { "name:zh-Hans": "中国", rank: 1 }),
      feature("country", "Small country", { rank: 4 }),
      feature("city", "Beijing", { "name:zh-Hans": "北京", rank: 1, capital: 2 }),
      feature("city", "Shanghai", { "name:zh-Hans": "上海", rank: 1, capital: 4 }),
      feature("state", "Zhejiang", { "name:zh-Hans": "浙江", rank: 2 }),
    ], 2.3, "zh", visible);

    expect(labels.map((label) => label.name)).toEqual(["亚洲", "中国"]);
  });

  it("uses exclusive country, region, and city selection tiers", () => {
    const features = [
      feature("country", "China", { rank: 1 }),
      feature("city", "Shanghai", { rank: 1, capital: 4 }),
      feature("state", "Zhejiang", { rank: 2 }),
    ];

    expect(geographyLabelsFromFeatures(features, 4.4, "en", visible).map((label) => label.kind)).toEqual(["country"]);
    expect(geographyLabelsFromFeatures(features, 5.0, "en", visible).map((label) => label.kind)).toEqual(["region"]);
    expect(geographyLabelsFromFeatures(features, 6.5, "en", visible).map((label) => label.kind)).toEqual(["city"]);
    expect(geographyLabelsFromFeatures(features, 6.0, "en", { countries: true, regions: false, cities: false })).toEqual([]);
  });
});
