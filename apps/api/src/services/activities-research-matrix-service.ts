import { and, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { providerSearchRuns } from "../db/schema.js";
import type { ProviderUnavailableCode } from "../types/domain.js";

type DbClient = Pick<typeof db, "select">;

export interface ActivityResearchCell {
  destinationId: string;
  outcome: "LIVE" | "UNAVAILABLE" | "MISSING";
  code?: ProviderUnavailableCode;
}

export async function evaluateActivitiesResearchCompleteness(params: {
  snapshotId: string;
  agentTaskRunId: string;
  destinationCandidates: string[];
  client?: DbClient;
}): Promise<{ complete: boolean; cells: ActivityResearchCell[] }> {
  const client = params.client ?? db;
  const rows = await client.select({
    destinationId: providerSearchRuns.destinationId,
    outcome: providerSearchRuns.outcome,
    errorCode: providerSearchRuns.errorCode,
  }).from(providerSearchRuns).where(and(
    eq(providerSearchRuns.snapshotId, params.snapshotId),
    eq(providerSearchRuns.agentTaskRunId, params.agentTaskRunId),
    eq(providerSearchRuns.category, "activity"),
  ));

  const cells = params.destinationCandidates.map((destinationId) => {
    const matching = rows.filter((row) => row.destinationId === destinationId);
    if (matching.some((row) => row.outcome === "LIVE")) {
      return { destinationId, outcome: "LIVE" } satisfies ActivityResearchCell;
    }
    const unavailable = matching.find((row) => row.outcome === "UNAVAILABLE");
    if (unavailable) {
      return {
        destinationId,
        outcome: "UNAVAILABLE",
        code: isProviderUnavailableCode(unavailable.errorCode)
          ? unavailable.errorCode
          : "UPSTREAM_FAILURE",
      } satisfies ActivityResearchCell;
    }
    return { destinationId, outcome: "MISSING" } satisfies ActivityResearchCell;
  });
  return { complete: cells.every((cell) => cell.outcome !== "MISSING"), cells };
}

export function activitiesMatrixToGaps(
  cells: ReadonlyArray<ActivityResearchCell>,
): Array<{ capability: "activities"; code: ProviderUnavailableCode; destinationId: string }> {
  return cells.flatMap((cell) => cell.outcome === "UNAVAILABLE"
    ? [{ capability: "activities" as const, code: cell.code ?? "UPSTREAM_FAILURE", destinationId: cell.destinationId }]
    : []);
}

function isProviderUnavailableCode(value: string | null): value is ProviderUnavailableCode {
  return [
    "NOT_CONFIGURED",
    "SEARCH_CONSTRAINTS_INCOMPLETE",
    "NO_RESULTS",
    "RATE_LIMITED",
    "UPSTREAM_TIMEOUT",
    "UPSTREAM_FAILURE",
    "INVALID_PROVIDER_RESPONSE",
    "PROVIDER_NOT_APPROVED",
    "PROVIDER_REQUEST_REJECTED",
  ].includes(value ?? "");
}

export class ActivitiesResearchIncompleteError extends Error {
  readonly code = "PLANNING_DATA_UNAVAILABLE";

  constructor(readonly cells: ActivityResearchCell[]) {
    super("Activities research is incomplete for one or more destinations");
    this.name = "ActivitiesResearchIncompleteError";
  }
}
