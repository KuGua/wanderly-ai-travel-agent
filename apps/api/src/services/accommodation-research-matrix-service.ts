import { and, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { providerSearchRuns } from "../db/schema.js";
import type { ProviderUnavailableCode } from "../types/domain.js";

type DbClient = Pick<typeof db, "select">;

export interface AccommodationResearchCell {
  destinationId: string;
  outcome: "LIVE" | "UNAVAILABLE" | "MISSING";
  code?: ProviderUnavailableCode;
}

export async function evaluateAccommodationResearchCompleteness(params: {
  snapshotId: string;
  agentTaskRunId: string;
  destinationCandidates: string[];
  client?: DbClient;
}): Promise<{ complete: boolean; cells: AccommodationResearchCell[] }> {
  const rows = await (params.client ?? db).select({
    destinationId: providerSearchRuns.destinationId,
    outcome: providerSearchRuns.outcome,
    errorCode: providerSearchRuns.errorCode,
  }).from(providerSearchRuns).where(and(
    eq(providerSearchRuns.snapshotId, params.snapshotId),
    eq(providerSearchRuns.agentTaskRunId, params.agentTaskRunId),
    eq(providerSearchRuns.category, "accommodation"),
  ));
  const cells = params.destinationCandidates.map((destinationId) => {
    const matching = rows.filter((row) => row.destinationId === destinationId);
    if (matching.some((row) => row.outcome === "LIVE")) return { destinationId, outcome: "LIVE" } satisfies AccommodationResearchCell;
    const unavailable = matching.find((row) => row.outcome === "UNAVAILABLE");
    if (unavailable) return {
      destinationId,
      outcome: "UNAVAILABLE",
      code: isCode(unavailable.errorCode) ? unavailable.errorCode : "UPSTREAM_FAILURE",
    } satisfies AccommodationResearchCell;
    return { destinationId, outcome: "MISSING" } satisfies AccommodationResearchCell;
  });
  return { complete: cells.every((cell) => cell.outcome !== "MISSING"), cells };
}

export function accommodationMatrixToGaps(cells: ReadonlyArray<AccommodationResearchCell>) {
  return cells.flatMap((cell) => cell.outcome === "UNAVAILABLE"
    ? [{ capability: "accommodation" as const, code: cell.code ?? "UPSTREAM_FAILURE", destinationId: cell.destinationId }]
    : []);
}

export class AccommodationResearchIncompleteError extends Error {
  readonly code = "PLANNING_DATA_UNAVAILABLE";
  constructor(readonly cells: AccommodationResearchCell[]) {
    super("Accommodation discovery is incomplete for one or more destinations");
    this.name = "AccommodationResearchIncompleteError";
  }
}

function isCode(value: string | null): value is ProviderUnavailableCode {
  return [
    "NOT_CONFIGURED", "SEARCH_CONSTRAINTS_INCOMPLETE", "NO_RESULTS", "RATE_LIMITED",
    "UPSTREAM_TIMEOUT", "UPSTREAM_FAILURE", "INVALID_PROVIDER_RESPONSE", "PROVIDER_NOT_APPROVED",
  ].includes(value ?? "");
}
