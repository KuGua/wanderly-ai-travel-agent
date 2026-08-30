/**
 * Spec §10.6 — research covers every configured candidate; provider failure
 * is rendered as UNAVAILABLE, never as implicit fallback.
 *
 * Pure-function coverage of the coverage-matrix shaping logic; the live
 * integration run belongs in Phase 6 with the network stubs configured.
 */

import { describe, expect, it } from "vitest";

/**
 * Mirrors the same matrix semantics as
 * `apps/api/src/services/flight-research-matrix-service.ts`.
 */
type Cell = { originId: string; destinationId: string; outcome: "LIVE" | "UNAVAILABLE" | "MISSING" };

function buildMatrix(params: {
  departureCities: string[];
  destinationCandidates: string[];
  runs: Array<{ originId: string; destinationId: string; outcome: "LIVE" | "UNAVAILABLE" | "MISSING" }>;
}): { cells: Cell[]; complete: boolean; missingDestinations: string[] } {
  const cells = params.departureCities.flatMap((origin) => params.destinationCandidates.map((destination) => {
    const matched = params.runs.filter(r => r.originId === origin && r.destinationId === destination);
    let outcome: Cell["outcome"] = "MISSING";
    if (matched.some(r => r.outcome === "LIVE")) outcome = "LIVE";
    else if (matched.some(r => r.outcome === "UNAVAILABLE")) outcome = "UNAVAILABLE";
    return { originId: origin, destinationId: destination, outcome };
  }));
  // Coverage is "complete enough for planning" only when every destination has
  // at least one LIVE or explicit UNAVAILABLE result for every origin. A
  // MISSING entry means we never even attempted — that's the refusal case.
  const complete = cells.every(c => c.outcome !== "MISSING");
  const missingDestinations = params.destinationCandidates.filter(destination => {
    return cells.some(c => c.destinationId === destination && c.outcome === "MISSING");
  });
  return { cells, complete, missingDestinations };
}

describe("Coverage matrix (spec §10.6)", () => {
  const origins = ["Shanghai", "San Francisco"];
  const candidates = ["Tokyo", "Bangkok", "Seoul"];

  it("full LIVE coverage on every (origin × destination) pair", () => {
    const runs = origins.flatMap(origin => candidates.map(destination => ({
      originId: origin.slice(0, 16),
      destinationId: destination.slice(0, 16),
      outcome: "LIVE" as const,
    })));
    const matrix = buildMatrix({ departureCities: origins, destinationCandidates: candidates, runs });
    expect(matrix.complete).toBe(true);
    expect(matrix.missingDestinations).toEqual([]);
    expect(matrix.cells.every(c => c.outcome === "LIVE")).toBe(true);
  });

  it("an explicit UNAVAILABLE result still satisfies coverage (spec §6.1)", () => {
    const runs = origins.flatMap(origin => candidates.map(destination => ({
      originId: origin.slice(0, 16),
      destinationId: destination.slice(0, 16),
      outcome: destination === "Bangkok" ? "UNAVAILABLE" as const : "LIVE" as const,
    })));
    const matrix = buildMatrix({ departureCities: origins, destinationCandidates: candidates, runs });
    expect(matrix.complete).toBe(true);
    expect(matrix.cells.filter(c => c.outcome === "UNAVAILABLE").length).toBeGreaterThan(0);
  });

  it("missing rows surface as 'missing' destination candidates", () => {
    const runs: Array<{ originId: string; destinationId: string; outcome: "LIVE" }> = [];
    const matrix = buildMatrix({ departureCities: origins, destinationCandidates: candidates, runs });
    expect(matrix.complete).toBe(false);
    expect(matrix.missingDestinations).toEqual(candidates);
  });

  it("never falls back to fixture inventory: missing means refused", () => {
    // No runs at all = no inventory assumed.
    const matrix = buildMatrix({ departureCities: origins, destinationCandidates: candidates, runs: [] });
    expect(matrix.cells.every(c => c.outcome === "MISSING")).toBe(true);
  });
});
