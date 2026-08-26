import { describe, expect, it } from "vitest";

import { cityCatalogFromFeatures, findMentionedCities, findMentionedCity } from "./city-catalog";

const features = [
  {
    type: "Feature" as const,
    properties: { class: "capital", name: "Tokyo", name_en: "Tokyo", name_zh: "东京" },
    geometry: { type: "Point" as const, coordinates: [139.749462, 35.686963] },
  },
  {
    type: "Feature" as const,
    properties: { class: "capital", name: "Lisbon", name_en: "Lisbon", name_zh: "里斯本" },
    geometry: { type: "Point" as const, coordinates: [-9.146812, 38.724669] },
  },
];

describe("city catalog", () => {
  it("finds English and Chinese city mentions with their center coordinates", () => {
    const cities = cityCatalogFromFeatures(features, "zh");
    expect(findMentionedCity("Tell me about Lisbon", cities)).toMatchObject({
      name: "Lisbon",
      coordinates: [-9.146812, 38.724669],
    });
    expect(findMentionedCity("我想去东京看看", cities)).toMatchObject({
      name: "Tokyo",
      localizedName: "东京",
    });
  });

  it("does not match a city name inside a longer Latin word", () => {
    const cities = cityCatalogFromFeatures(features, "en");
    expect(findMentionedCity("Tokyology is not a destination", cities)).toBeNull();
  });

  it("returns each city mentioned in text order", () => {
    const cities = cityCatalogFromFeatures(features, "en");
    expect(findMentionedCities("Lisbon or Tokyo, then Lisbon again", cities).map((city) => city.name))
      .toEqual(["Lisbon", "Tokyo"]);
  });
});
