import { describe, expect, it } from "vitest";

import { routeLegs, type CountryPin } from "./trip-mini-globe";

function pin(key: string, name: string, coordinates: [number, number]): CountryPin {
  return { key, name, coordinates, places: [name] };
}

const SINGAPORE = pin("country:SG", "Singapore", [103.8, 1.35]);
const NEW_YORK = pin("country:US", "United States", [-74.0, 40.7]);
const TOKYO = pin("country:JP", "Japan", [139.7, 35.7]);

describe("routeLegs", () => {
  it("chains the pins in the order they were given", () => {
    const legs = routeLegs([SINGAPORE, TOKYO, NEW_YORK]);
    expect(legs.map((leg) => [leg.fromName, leg.toName])).toEqual([
      ["Singapore", "Japan"],
      ["Japan", "United States"],
    ]);
  });

  it("draws nothing without two places to join", () => {
    expect(routeLegs([])).toEqual([]);
    expect(routeLegs([SINGAPORE])).toEqual([]);
  });

  it("crosses the antimeridian rather than doubling back across the map", () => {
    // Tokyo (139.7E) to New York (74W) is 146° going east over the Pacific.
    // Left as given it is 213° the other way, which draws straight through
    // Europe — the wrong half of the world.
    const [leg] = routeLegs([TOKYO, NEW_YORK]);
    expect(leg.to[0]).toBeCloseTo(286, 5);
    expect(Math.abs(leg.to[0] - leg.from[0])).toBeLessThanOrEqual(180);
    expect(leg.midpoint[0]).toBeCloseTo(212.85, 2);
  });

  it("puts the plane at the midpoint of the leg it belongs to", () => {
    const [leg] = routeLegs([SINGAPORE, TOKYO]);
    expect(leg.midpoint[0]).toBeCloseTo((103.8 + 139.7) / 2, 5);
    expect(leg.midpoint[1]).toBeCloseTo((1.35 + 35.7) / 2, 5);
  });

  it("points the plane along the leg, clockwise from north", () => {
    // Due east: straight to the right of the screen is a quarter turn.
    const [east] = routeLegs([pin("a", "A", [0, 0]), pin("b", "B", [40, 0])]);
    expect(east.bearingDeg).toBeCloseTo(90, 5);

    // Due north: no rotation at all.
    const [north] = routeLegs([pin("a", "A", [0, 0]), pin("b", "B", [0, 40])]);
    expect(north.bearingDeg).toBeCloseTo(0, 5);

    // Due west reads as a quarter turn the other way.
    const [west] = routeLegs([pin("a", "A", [0, 0]), pin("b", "B", [-40, 0])]);
    expect(west.bearingDeg).toBeCloseTo(-90, 5);
  });

  it("gives two pins at the same point a defined angle instead of NaN", () => {
    const [leg] = routeLegs([pin("a", "A", [10, 10]), pin("b", "B", [10, 10])]);
    expect(leg.bearingDeg).toBe(0);
  });
});
