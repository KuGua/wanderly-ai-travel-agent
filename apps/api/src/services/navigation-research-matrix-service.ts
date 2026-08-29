import { and, eq } from "drizzle-orm";
import { db, type DB } from "../db/database.js";
import { providerSearchRuns } from "../db/schema.js";

/**
 * Spec §4.3 — Navigation research matrix.
 *
 * Mirrors `flight-research-matrix-service` so the planner can independently
 * assess the navigation capability. The matrix is keyed on the (originPlaceId,
 * destinationPlaceId, mode) triple; UNAVAILABLE is an auditable attempt that
 * Phase 4 outcome matrix treats as a *gap* rather than a fatal condition.
 *
 * The `complete` predicate is intentionally weaker than the flight matrix:
 * `UNAVAILABLE` counts as completed research (we tried, we recorded why).
 * The planner's task terminator is the one that decides whether the absence
 * of LIVE navigation research is a gap or an acceptable state for the
 * current trip configuration (e.g. a Trip with no `TripPlace` rows yet).
 */
export type NavigationResearchReadClient = Pick<DB, "select">;

export type NavigationResearchCell = {
  originPlaceId: string;
  destinationPlaceId: string;
  mode: "WALK" | "DRIVE" | "CYCLE";
  outcome: "LIVE" | "UNAVAILABLE" | "MISSING";
};

export async function evaluateNavigationResearchCompleteness(params: {
  snapshotId: string;
  agentTaskRunId: string;
  originPlaceIds: string[];
  destinationPlaceIds: string[];
  modes?: ReadonlyArray<"WALK" | "DRIVE" | "CYCLE">;
  client?: NavigationResearchReadClient;
}): Promise<{ complete: boolean; cells: NavigationResearchCell[] }> {
  const client = params.client ?? db;
  const modes = params.modes ?? (["WALK", "DRIVE", "CYCLE"] as const);
  const runs = await client.select({
    originId: providerSearchRuns.originId,
    destinationId: providerSearchRuns.destinationId,
    outcome: providerSearchRuns.outcome,
  }).from(providerSearchRuns).where(and(
    eq(providerSearchRuns.snapshotId, params.snapshotId),
    eq(providerSearchRuns.agentTaskRunId, params.agentTaskRunId),
    eq(providerSearchRuns.category, "navigation"),
  ));
  const cells = params.originPlaceIds.flatMap((originPlaceId) =>
    params.destinationPlaceIds.flatMap((destinationPlaceId) =>
      modes.map((mode) => {
        const matching = runs.filter((run) => run.originId === originPlaceId && run.destinationId === destinationPlaceId);
        const outcome: NavigationResearchCell["outcome"] = matching.some((run) => run.outcome === "LIVE")
          ? "LIVE"
          : matching.some((run) => run.outcome === "UNAVAILABLE")
          ? "UNAVAILABLE"
          : "MISSING";
        return { originPlaceId, destinationPlaceId, mode, outcome };
      })
    )
  );
  return { complete: cells.every((cell) => cell.outcome !== "MISSING"), cells };
}