import { describe, expect, it } from "vitest";

import { resolveFlightRouteMatrix } from "../src/location-reference/airport-reference.js";

/**
 * One derivation, four readers. The model gateway's required-cell matrix, the
 * coverage fan-out, the database completeness check and the tool description
 * each translated cities to airports on their own, and disagreed: the gateway
 * demanded `Singapore → Shanghai` while every search the model was allowed to
 * run was `SIN → SHA` or `SIN → PVG`. Its matrix could never complete, so it
 * forced another `flight.search` on every turn until the budget was gone —
 * and the guards meant to stop that loop were all conditioned on the matrix
 * completing.
 */
describe("flight route matrix", () => {
  it("resolves cities to controlled airports and pairs them", () => {
    const matrix = resolveFlightRouteMatrix({
      departureCities: ["Singapore"],
      destinationCandidates: ["Shanghai"],
    });
    expect(matrix.originIds).toEqual(["SIN"]);
    expect(new Set(matrix.destinationIds)).toEqual(new Set(["PVG", "SHA"]));
    expect(matrix.cells).toHaveLength(2);
    for (const cell of matrix.cells) {
      expect(cell.originId).toMatch(/^[A-Z]{3}$/);
      expect(cell.destinationId).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("reads Chinese and English city names alike", () => {
    const zh = resolveFlightRouteMatrix({ departureCities: ["新加坡"], destinationCandidates: ["上海"] });
    const en = resolveFlightRouteMatrix({ departureCities: ["Singapore"], destinationCandidates: ["Shanghai"] });
    expect(zh.originIds).toEqual(en.originIds);
    expect(new Set(zh.destinationIds)).toEqual(new Set(en.destinationIds));
  });

  it("names the city an airport stands for, so a gap does not read '(PVG)'", () => {
    const matrix = resolveFlightRouteMatrix({
      departureCities: ["新加坡"],
      destinationCandidates: ["Shanghai"],
    });
    expect(matrix.cityFor("SIN")).toBe("新加坡");
    expect(matrix.cityFor("PVG")).toBe("Shanghai");
    expect(matrix.cityFor("CDG")).toBeNull();
  });

  it("accepts an entry that is already a controlled airport id", () => {
    const matrix = resolveFlightRouteMatrix({
      departureCities: ["SFO"],
      destinationCandidates: ["NRT"],
    });
    expect(matrix.cells).toEqual([{ originId: "SFO", destinationId: "NRT" }]);
    expect(matrix.citiesWithoutAirport).toEqual([]);
    expect(matrix.cityFor("NRT")).toBe("Tokyo");
  });

  it("contributes no route for a city with no controlled airport, and never guesses", () => {
    // Kyoto is deliberately absent: it is served by KIX, which is Osaka's
    // airport, and inventing that link would make the resolved city disagree
    // with the brief (§#22).
    const matrix = resolveFlightRouteMatrix({
      departureCities: ["Singapore"],
      destinationCandidates: ["Kyoto"],
    });
    expect(matrix.destinationIds).toEqual([]);
    expect(matrix.cells).toEqual([]);
    expect(matrix.citiesWithoutAirport).toContain("Kyoto");
  });
});
