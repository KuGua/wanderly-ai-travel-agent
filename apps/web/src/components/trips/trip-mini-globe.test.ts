import { describe, expect, it } from "vitest";

import type { CatalogCity } from "@/components/explore/city-catalog";

import { framingCamera, groupResolvedPlacesByCountry, resolvePlaceCoordinates } from "./trip-mini-globe";

function city(name: string, coordinates: [number, number]): CatalogCity {
  return { key: name.toLowerCase(), name, localizedName: name, coordinates, aliases: [name] };
}

const CITIES = [
  city("Tokyo", [139.69, 35.68]),
  city("Kyoto", [135.76, 35.01]),
  city("Osaka", [135.5, 34.69]),
  city("Shanghai", [121.47, 31.23]),
];

const JAPAN = { name: "Japan", code: "JP" };
const CHINA = { name: "China", code: "CN" };

describe("resolvePlaceCoordinates", () => {
  it("resolves names case-insensitively through the catalogue aliases", () => {
    expect(resolvePlaceCoordinates(["tokyo"], CITIES)).toHaveLength(1);
  });

  it("drops names the catalogue cannot resolve rather than inventing a pin", () => {
    expect(resolvePlaceCoordinates(["Atlantis"], CITIES)).toEqual([]);
  });
});

describe("groupResolvedPlacesByCountry", () => {
  it("merges every city in one country into a single country-labelled pin", () => {
    const resolved = resolvePlaceCoordinates(["Tokyo", "Kyoto", "Osaka"], CITIES)
      .map((entry) => ({ ...entry, country: JAPAN }));

    const pins = groupResolvedPlacesByCountry(resolved);

    expect(pins).toHaveLength(1);
    expect(pins[0].name).toBe("Japan");
    expect(pins[0].places).toEqual(["Tokyo", "Kyoto", "Osaka"]);
  });

  it("keeps separate countries apart", () => {
    const resolved = [
      ...resolvePlaceCoordinates(["Tokyo"], CITIES).map((e) => ({ ...e, country: JAPAN })),
      ...resolvePlaceCoordinates(["Shanghai"], CITIES).map((e) => ({ ...e, country: CHINA })),
    ];

    expect(groupResolvedPlacesByCountry(resolved).map((pin) => pin.name).sort())
      .toEqual(["China", "Japan"]);
  });

  it("anchors a merged pin between the cities it rolled up", () => {
    const resolved = resolvePlaceCoordinates(["Tokyo", "Osaka"], CITIES)
      .map((entry) => ({ ...entry, country: JAPAN }));

    const [pin] = groupResolvedPlacesByCountry(resolved);

    expect(pin.coordinates[0]).toBeGreaterThan(135.5);
    expect(pin.coordinates[0]).toBeLessThan(139.69);
  });

  it("falls back to the city name when the server reports no country", () => {
    // Never assert a country we were not told — a wrong country would
    // misstate where the trip goes.
    const resolved = resolvePlaceCoordinates(["Shanghai"], CITIES)
      .map((entry) => ({ ...entry, country: null }));

    expect(groupResolvedPlacesByCountry(resolved)[0].name).toBe("Shanghai");
  });
});

describe("framingCamera", () => {
  it("falls back to a whole-globe view when there is nothing to frame", () => {
    expect(framingCamera([]).zoom).toBeLessThan(0.5);
  });

  it("averages across the antimeridian instead of snapping to the middle", () => {
    const pins = [
      { key: "a", name: "A", coordinates: [175, 10] as [number, number], places: [] },
      { key: "b", name: "B", coordinates: [-175, 10] as [number, number], places: [] },
    ];

    expect(Math.abs(framingCamera(pins).center[0])).toBeGreaterThan(170);
  });
});
