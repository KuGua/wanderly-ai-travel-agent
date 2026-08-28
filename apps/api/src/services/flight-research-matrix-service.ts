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

/** The required matrix is deliberately only origin × candidate destination.
 * A LIVE persisted search is the sole completion state; UNAVAILABLE is an
 * auditable attempted search but fails the planning round closed. */
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
  return { complete: cells.every((cell) => cell.outcome === "LIVE"), cells };
}

export class FlightResearchIncompleteError extends Error {
  readonly code = "PLANNING_DATA_UNAVAILABLE";
  constructor(readonly cells: FlightResearchCell[]) {
    super("Required flight research is incomplete");
  }
}
