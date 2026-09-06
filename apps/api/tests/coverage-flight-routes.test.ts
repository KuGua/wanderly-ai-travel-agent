import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { researchCoverageForSnapshot, type PlanningDependencies } from "../src/services/planning-service.js";
import { testPlanningDependencies } from "./helpers/planning.js";

/**
 * SerpApi named the defect itself when a rejected request finally got logged:
 * `departure_id` ("Singapore") should either be an uppercase 3-letter code or
 * start with "/m" or "/g". Coverage research passed the snapshot's city names
 * straight to the adapter and every cell 400'd, while the model's own tool
 * loop — which resolves airports first — got 200 and 28 offers for the same
 * route on the same run.
 */
describe("coverage flight fan-out", () => {
  function recordingDeps(): { deps: PlanningDependencies; asked: Array<{ origin: string; destination: string }> } {
    const asked: Array<{ origin: string; destination: string }> = [];
    return {
      asked,
      deps: {
        ...testPlanningDependencies,
        flightProvider: {
          async searchFlights(params) {
            asked.push({ origin: params.origin, destination: params.destination });
            return { outcome: "UNAVAILABLE", reason: "NO_RESULTS" };
          },
        },
      },
    };
  }

  it("asks the adapter for controlled airport ids, not city names", async () => {
    const { deps, asked } = recordingDeps();
    await researchCoverageForSnapshot({
      snapshotId: randomUUID(),
      tripId: randomUUID(),
      departureCities: ["新加坡"],
      destinationCandidates: ["Shanghai"],
      travelDateStart: "2026-12-04",
      travelDateEnd: "2026-12-08",
      providerOverride: deps,
    });
    expect(asked.length).toBeGreaterThan(0);
    // 新加坡 → SIN; Shanghai → PVG, SHA. Chinese and English resolve alike.
    expect(new Set(asked.map((a) => a.origin))).toEqual(new Set(["SIN"]));
    expect(new Set(asked.map((a) => a.destination))).toEqual(new Set(["PVG", "SHA"]));
    for (const { origin, destination } of asked) {
      expect(origin).toMatch(/^[A-Z]{3}$/);
      expect(destination).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("asks for nothing when a city has no controlled airport, and does not guess a neighbour", async () => {
    const { deps, asked } = recordingDeps();
    const result = await researchCoverageForSnapshot({
      snapshotId: randomUUID(),
      tripId: randomUUID(),
      departureCities: ["Singapore"],
      // Kyoto is deliberately absent from the controlled list: it is served by
      // KIX, which is Osaka's airport, and inventing that link would make
      // `resolveAirportReference("KIX").city` disagree with the brief (§#22).
      destinationCandidates: ["Kyoto"],
      travelDateStart: "2026-12-04",
      travelDateEnd: "2026-12-08",
      providerOverride: deps,
    });
    expect(asked).toHaveLength(0);
    expect(result.allFlights).toHaveLength(0);
  });

  it("keeps evaluatedDestinations keyed by the snapshot's city, not the airport", async () => {
    const asked: Array<{ origin: string; destination: string }> = [];
    const deps: PlanningDependencies = {
      ...testPlanningDependencies,
      flightProvider: {
        async searchFlights(params) {
          asked.push({ origin: params.origin, destination: params.destination });
          return {
            outcome: "LIVE",
            source: "Test flight provider",
            capturedAt: "2026-08-25T00:00:00.000Z",
            // The city-keying assertion only needs a non-empty evidence cell;
            // the normalized offer contract itself is covered elsewhere.
            data: [{} as never],
          };
        },
      },
    };
    const result = await researchCoverageForSnapshot({
      snapshotId: randomUUID(),
      tripId: randomUUID(),
      departureCities: ["Singapore"],
      destinationCandidates: ["Shanghai"],
      travelDateStart: "2026-12-04",
      travelDateEnd: "2026-12-08",
      providerOverride: deps,
    });
    // Every downstream consumer filters `destinationCandidates` by this set.
    expect(result.evaluatedDestinations).toContain("Shanghai");
    expect(result.evaluatedDestinations).not.toContain("PVG");
  });

  it("fails closed when a provider labels an empty offer list LIVE", async () => {
    const deps: PlanningDependencies = {
      ...testPlanningDependencies,
      accommodationDiscoveryProvider: undefined,
      flightProvider: {
        async searchFlights() {
          return {
            outcome: "LIVE",
            source: "Test flight provider",
            capturedAt: "2026-08-25T00:00:00.000Z",
            data: [],
          };
        },
      },
    };
    const result = await researchCoverageForSnapshot({
      snapshotId: randomUUID(),
      tripId: randomUUID(),
      departureCities: ["Singapore"],
      destinationCandidates: ["Shanghai"],
      travelDateStart: "2026-12-04",
      travelDateEnd: "2026-12-08",
      providerOverride: deps,
    });

    expect(result.allFlights).toHaveLength(0);
    expect(result.evaluatedDestinations).not.toContain("Shanghai");
  });
});
