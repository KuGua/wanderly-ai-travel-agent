import { and, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { providerSearchRuns } from "../db/schema.js";
import type { ProviderUnavailableCode } from "../types/domain.js";

type DbClient = Pick<typeof db, "select">;
export interface HotelResearchCell {
  destinationId: string;
  outcome: "LIVE" | "UNAVAILABLE" | "MISSING";
  code?: ProviderUnavailableCode;
}

export async function evaluateHotelResearchCompleteness(params: {
  snapshotId: string; agentTaskRunId: string; destinationCandidates: string[]; client?: DbClient;
}): Promise<{ complete: boolean; cells: HotelResearchCell[] }> {
  const rows = await (params.client ?? db).select({
    destinationId: providerSearchRuns.destinationId,
    outcome: providerSearchRuns.outcome,
    errorCode: providerSearchRuns.errorCode,
  }).from(providerSearchRuns).where(and(
    eq(providerSearchRuns.snapshotId, params.snapshotId),
    eq(providerSearchRuns.agentTaskRunId, params.agentTaskRunId),
    eq(providerSearchRuns.category, "hotel"),
  ));
  const cells = params.destinationCandidates.map((destinationId) => {
    const matching = rows.filter((row) => row.destinationId === destinationId);
    if (matching.some((row) => row.outcome === "LIVE")) return { destinationId, outcome: "LIVE" } satisfies HotelResearchCell;
    const unavailable = matching.find((row) => row.outcome === "UNAVAILABLE");
    if (unavailable) return {
      destinationId, outcome: "UNAVAILABLE",
      code: isCode(unavailable.errorCode) ? unavailable.errorCode : "UPSTREAM_FAILURE",
    } satisfies HotelResearchCell;
    return { destinationId, outcome: "MISSING" } satisfies HotelResearchCell;
  });
  return { complete: cells.every((cell) => cell.outcome !== "MISSING"), cells };
}

export function hotelMatrixToGaps(cells: ReadonlyArray<HotelResearchCell>) {
  return cells.flatMap((cell) => cell.outcome === "UNAVAILABLE"
    ? [{ capability: "hotel" as const, code: cell.code ?? "UPSTREAM_FAILURE", destinationId: cell.destinationId }]
    : []);
}

function isCode(value: string | null): value is ProviderUnavailableCode {
  return ["NOT_CONFIGURED", "SEARCH_CONSTRAINTS_INCOMPLETE", "NO_RESULTS", "RATE_LIMITED", "UPSTREAM_TIMEOUT", "UPSTREAM_FAILURE", "INVALID_PROVIDER_RESPONSE", "PROVIDER_NOT_APPROVED"].includes(value ?? "");
}

export class HotelResearchIncompleteError extends Error {
  readonly code = "PLANNING_DATA_UNAVAILABLE";
  constructor(readonly cells: HotelResearchCell[]) {
    super("Hotel research is incomplete for one or more destinations");
    this.name = "HotelResearchIncompleteError";
  }
}
