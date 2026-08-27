import { describe, expect, it } from "vitest";
import type { MapGeoJSONFeature } from "maplibre-gl";

import { geographyFeatureFrom } from "./map-geography-layers";

function featureWith(properties: Record<string, unknown>): MapGeoJSONFeature {
  return {
    properties,
    geometry: { type: "Point", coordinates: [0, 0] },
  } as unknown as MapGeoJSONFeature;
}

describe("geographyFeatureFrom", () => {
  it("returns null when the feature is missing", () => {
    expect(geographyFeatureFrom(undefined)).toBeNull();
  });

  it("returns null when the feature has no name", () => {
    expect(geographyFeatureFrom(featureWith({ class: "country" }))).toBeNull();
  });

  it("classifies a country label", () => {
    const result = geographyFeatureFrom(featureWith({ class: "country", name: "France" }));
    expect(result).toEqual({ name: "France", kind: "country" });
  });

  it("classifies a city label across the documented class values", () => {
    for (const className of ["city", "town", "village", "capital"]) {
      const result = geographyFeatureFrom(featureWith({ class: className, name: "Anywhere" }));
      expect(result).toEqual({ name: "Anywhere", kind: "city" });
    }
  });

  it("classifies a suburb as city so the click short-circuits without an API call", () => {
    // OpenMapTiles v3 renders sub-city admin areas (district / borough /
    // neighborhood) under class="suburb" inside the `label_city` layer at
    // high zoom. Without this branch the click would fall through to the
    // slow resolver and re-introduce the placeholder-name flash for every
    // district-level hit.
    const result = geographyFeatureFrom(featureWith({
      class: "suburb",
      "name:zh": "杨浦区",
      "name:en": "Yangpu",
    }));
    expect(result).toEqual({ name: "杨浦区", kind: "city" });
  });

  it("classifies state / province / region as administrative division", () => {
    for (const className of ["state", "province", "region"]) {
      const result = geographyFeatureFrom(featureWith({ class: className, name: "Anywhere" }));
      expect(result).toEqual({ name: "Anywhere", kind: "administrative division" });
    }
  });

  it("prefers the localized name when both zh and en are present", () => {
    expect(geographyFeatureFrom(featureWith({
      class: "suburb",
      "name:zh": "普陀区",
      "name:en": "Putuo",
    }))).toEqual({ name: "普陀区", kind: "city" });
    expect(geographyFeatureFrom(featureWith({
      class: "country",
      "name:zh": "中国",
      "name:en": "China",
    }))).toEqual({ name: "中国", kind: "country" });
  });

  it("falls back to the plain name field when no localized variant exists", () => {
    expect(geographyFeatureFrom(featureWith({ class: "country", name: "Brazil" })))
      .toEqual({ name: "Brazil", kind: "country" });
  });

  it("returns null for an unrecognized class so unknown layers fall through to the resolver", () => {
    expect(geographyFeatureFrom(featureWith({ class: "motorway_junction", name: "42" }))).toBeNull();
  });
});