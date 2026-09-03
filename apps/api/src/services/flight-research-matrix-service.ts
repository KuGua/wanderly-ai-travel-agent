import { and, eq } from "drizzle-orm";
import { db, type DB } from "../db/database.js";
import { providerSearchRuns } from "../db/schema.js";

/**
 * Both the root Drizzle client and its transaction client implement this
 * read-only surface.  Accepting it here keeps the completion decision on the
 * caller's transaction when that decision guards an authoritative write.
 */
export type FlightResearchReadClient = Pick<DB, "select">;

export type FlightResearchCell = {
  originId: string;
  destinationId: string;
  outcome: "LIVE" | "UNAVAILABLE" | "MISSING";
};

/**
 * Research completeness answers only whether every authorized
 * origin × destination cell was attempted. An explicit UNAVAILABLE outcome is
 * auditable coverage and later becomes a service gap; only MISSING means the
 * planner failed to run a required search.
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
    const outcome: FlightResearchCell["outcome"] = matching.some((run) => run.outcome === "LIVE")
      ? "LIVE" : matching.some((run) => run.outcome === "UNAVAILABLE") ? "UNAVAILABLE" : "MISSING";
    return { originId, destinationId, outcome };
  }));
  return { complete: cells.every((cell) => cell.outcome !== "MISSING"), cells };
}

/**
 * Commercial evidence is a separate gate from research completeness. A plan
 * may tolerate individual unavailable cells, but it must not recommend a
 * destination for which no controlled flight search produced LIVE evidence.
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
