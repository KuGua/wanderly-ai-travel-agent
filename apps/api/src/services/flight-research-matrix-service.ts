import { and, eq } from "drizzle-orm";
import { db, type DB } from "../db/database.js";
import { providerSearchRuns } from "../db/schema.js";

/**
 * Both the root Drizzle client and its transaction client implement this
 * read-only surface.  Accepting it here keeps the completion decision on the
 * caller's transaction when that decision guards an authoritative write.
 */
export type FlightResearchReadClient = Pick<DB, "select">;

/**
 * Per-cell outcome of the flight research matrix.
 *
 * - `LIVE`       — at least one provider call returned real, capturable evidence.
 * - `UNAVAILABLE`— the cell was searched but every attempt failed. It is
 *                  auditable but not sufficient to synthesize a final plan
 *                  for that origin × destination pair; it surfaces as a
 *                  `service_gap`.
 * - `MISSING`    — the tool loop never tried this cell. This is a planner
 *                  defect (it skipped a required pair), not a provider
 *                  failure, and is the only outcome that still triggers the
 *                  non-retryable `FlightResearchIncompleteError`.
 */
export type FlightResearchOutcome = "LIVE" | "UNAVAILABLE" | "MISSING";

export type FlightResearchCell = {
  originId: string;
  destinationId: string;
  outcome: FlightResearchOutcome;
};

/**
 * Evaluate the flight research matrix for one snapshot/run pair.
 *
 * Completeness is the "did the loop cover the cell" gate: it requires every
 * authorized origin × destination pair to have been *attempted* (i.e. not
 * `MISSING`). A `UNAVAILABLE` cell is still complete — the loop tried it and
 * the answer was "no". Whether that answer is sufficient to *synthesize* a
 * commercial plan is a separate question, owned by
 * `hasCommercialFlightAuthority` (Gate B in §1.3 of the planner-resilience
 * design).
 */
export async function evaluateFlightResearchCompleteness(params: {
  snapshotId: string;
  agentTaskRunId: string;
  departureCities: string[];
  destinationCandidates: string[];
  client?: FlightResearchReadClient;
}): Promise<{ complete: boolean; cells: FlightResearchCell[] }> {
  const client = params.client ?? db;
  const runs = await client.select({
    originId: providerSearchRuns.originId,
    destinationId: providerSearchRuns.destinationId,
    outcome: providerSearchRuns.outcome,
  }).from(providerSearchRuns).where(and(
    eq(providerSearchRuns.snapshotId, params.snapshotId),
    eq(providerSearchRuns.agentTaskRunId, params.agentTaskRunId),
    eq(providerSearchRuns.category, "flight"),
  ));
  const cells = params.departureCities.flatMap((originId) => params.destinationCandidates.map((destinationId) => {
    const matching = runs.filter((run) => run.originId === originId && run.destinationId === destinationId);
    const outcome: FlightResearchOutcome = matching.some((run) => run.outcome === "LIVE")
      ? "LIVE" : matching.some((run) => run.outcome === "UNAVAILABLE") ? "UNAVAILABLE" : "MISSING";
    return { originId, destinationId, outcome };
  }));
  return { complete: cells.every((cell) => cell.outcome !== "MISSING"), cells };
}

/**
 * Commercial authority gate for the flight capability. Research completeness
 * only says the loop covered every cell; whether a destination can carry a
 * commercial plan assertion requires at least one `LIVE` evidence cell for
 * that destination. Without it, the planner must produce a research summary
 * (no plan), per §1.3 of the planner-resilience design.
 */
export function hasCommercialFlightAuthority(
  cells: ReadonlyArray<FlightResearchCell>,
  destinationId: string,
): boolean {
  return cells.some((cell) =>
    cell.destinationId === destinationId && cell.outcome === "LIVE",
  );
}

/**
 * Phase 4 outcome matrix helper. Translates the cell matrix into a bounded
 * `serviceGaps` array the planner persists on `planning_research_results`.
 * MISSING cells are *not* surfaced here — the planner must already have
 * failed earlier with `FlightResearchIncompleteError` if any cell is MISSING.
 * Pre-P0 the `complete` semantic required every cell to be `LIVE`, which
 * starved this helper on the plan path; once `complete` only requires the
 * cell to have been attempted (per §1.3 of the planner-resilience design),
 * UNAVAILABLE cells flow through and become gaps.
 */
export function flightMatrixToGaps(cells: ReadonlyArray<FlightResearchCell>): Array<{ capability: "flight"; code: "NO_RESULTS" | "UPSTREAM_FAILURE"; originId: string; destinationId: string }> {
  const gaps: Array<{ capability: "flight"; code: "NO_RESULTS" | "UPSTREAM_FAILURE"; originId: string; destinationId: string }> = [];
  for (const cell of cells) {
    if (cell.outcome !== "UNAVAILABLE") continue;
    gaps.push({
      capability: "flight",
      code: "UPSTREAM_FAILURE",
      originId: cell.originId,
      destinationId: cell.destinationId,
    });
  }
  return gaps;
}

export class FlightResearchIncompleteError extends Error {
  readonly code = "PLANNING_DATA_UNAVAILABLE";
  constructor(readonly cells: FlightResearchCell[]) {
    super("Required flight research is incomplete");
  }
}
