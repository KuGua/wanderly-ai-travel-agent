import { and, count, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { tripMembers } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";

/**
 * Server-derived trip collaboration mode. Not persisted as a column — it is
 * computed from `trip_members WHERE is_required = true`. Phase 1 of
 * `docs/personal-trip-orchestration-implementation.md`.
 */
export type TripMode = "SOLO" | "TEAM";

export const SOLO_DESTINATION_MIN = 1;
export const SOLO_DESTINATION_MAX = 5;
export const TEAM_DESTINATION_MIN = 2;
export const TEAM_DESTINATION_MAX = 5;

/**
 * Shared `Tx` type matching the rest of `apps/api/src/services/*`. Lets
 * callers pass either the default `db` handle or an in-flight transaction.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbHandle = typeof db | Tx;

/**
 * Returns `SOLO` when exactly one required member exists on the Trip.
 * Returns `TEAM` otherwise (0, 2+ required members, or the trip does not
 * exist). Callers should pair this with `assertTripModeForBrief` to validate
 * the candidate list against the derived mode.
 */
export async function getTripMode(handle: DbHandle, tripId: string): Promise<TripMode> {
  const [row] = await handle
    .select({ requiredCount: count() })
    .from(tripMembers)
    .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.isRequired, true)));
  const required = Number(row?.requiredCount ?? 0);
  return required === 1 ? "SOLO" : "TEAM";
}

/**
 * Throws a stable `ApiError` when the destination-candidate list violates
 * the derived mode's allowed range. SOLO accepts 1..5 candidates; TEAM keeps
 * the pre-existing 2..5 bound. The error code `RESEARCH_BRIEF_INVALID` is
 * used by both the activation route and the Phase 2 research command route.
 */
export function assertTripModeForBrief(
  mode: TripMode,
  candidates: readonly string[],
): void {
  if (mode === "SOLO") {
    if (candidates.length < SOLO_DESTINATION_MIN || candidates.length > SOLO_DESTINATION_MAX) {
      throw new ApiError(
        422,
        "Unprocessable Entity",
        `RESEARCH_BRIEF_INVALID: SOLO trips require ${SOLO_DESTINATION_MIN}..${SOLO_DESTINATION_MAX} destination candidates (received ${candidates.length})`,
      );
    }
    return;
  }
  if (candidates.length < TEAM_DESTINATION_MIN || candidates.length > TEAM_DESTINATION_MAX) {
    throw new ApiError(
      422,
      "Unprocessable Entity",
      `RESEARCH_BRIEF_INVALID: TEAM trips require ${TEAM_DESTINATION_MIN}..${TEAM_DESTINATION_MAX} destination candidates (received ${candidates.length})`,
    );
  }
}

/**
 * Convenience: load the trip mode AND validate the candidate list in one
 * call. Use from the trip-activation route and from the research command
 * route (Phase 2).
 */
export async function loadAndAssertTripModeForBrief(
  handle: DbHandle,
  tripId: string,
  candidates: readonly string[],
): Promise<TripMode> {
  const mode = await getTripMode(handle, tripId);
  assertTripModeForBrief(mode, candidates);
  return mode;
}