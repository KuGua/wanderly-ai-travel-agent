import { and, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { sharedTrips, tripMembers } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { metrics } from "../observability/metrics.js";
import {
  loadAndAssertTripModeForBrief,
  type TripMode,
} from "./trip-mode-service.js";

type ActiveTripStatus = Exclude<
  (typeof sharedTrips.$inferSelect)["status"],
  "DRAFT"
>;

/**
 * Reject any collaboration command (invitation, consent, planning, replan,
 * confirmation, booking, change-event) against a Trip that has not been
 * activated yet. The Draft state is a private exploration surface for the
 * creator only; it has no membership quorum, no snapshot, and no booking
 * surface.
 *
 * Returns the active status when the trip is ready so the caller can branch
 * on it without re-querying the row.
 */
export async function requireActiveTrip(
  tripId: string,
  operation:
    | "invitation" | "consent" | "planning" | "confirmation" | "booking" | "change_event"
    | "constraint_propose" | "constraint_confirm" | "constraint_dismiss"
    | "constraint_upsert" | "constraint_revoke" | "constraint_read"
    | "adoption_vote"
    | "research"
    = "planning",
): Promise<ActiveTripStatus> {
  const [trip] = await db.select({ status: sharedTrips.status })
    .from(sharedTrips)
    .where(eq(sharedTrips.id, tripId))
    .limit(1);

  if (!trip) {
    throw new ApiError(404, "Not Found", "Trip not found");
  }
  if (trip.status === "DRAFT") {
    metrics.inc("draft_command_rejected_total", { operation });
    throw new ApiError(
      409,
      "Conflict",
      "TRIP_NOT_ACTIVE: activate the trip before running collaboration commands",
    );
  }
  return trip.status;
}

/**
 * Phase 1 — Personal Trip Orchestrator research-command guard.
 *
 * Rejects with the same `TRIP_NOT_ACTIVE` semantics as `requireActiveTrip`
 * for DRAFT trips, then verifies the caller is a required member of the
 * trip and that the supplied candidate list matches the derived trip mode
 * (SOLO 1..5 / TEAM 2..3). Capability-dependency checks (e.g. confirmed
 * search preferences) live in the Phase 2 research command route, where the
 * requested capability list is known.
 *
 * Returns the derived mode so the route can branch on it without a second
 * trip_members query.
 */
export async function requireResearchEligible(
  tripId: string,
  userId: string,
  candidates: readonly string[],
  handle: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
): Promise<TripMode> {
  const [trip] = await handle.select({ status: sharedTrips.status })
    .from(sharedTrips)
    .where(eq(sharedTrips.id, tripId))
    .limit(1);

  if (!trip) {
    throw new ApiError(404, "Not Found", "Trip not found");
  }
  if (trip.status === "DRAFT") {
    metrics.inc("draft_command_rejected_total", { operation: "research" });
    throw new ApiError(
      409,
      "Conflict",
      "TRIP_NOT_ACTIVE: activate the trip before running research commands",
    );
  }

  const [membership] = await handle.select({ isRequired: tripMembers.isRequired })
    .from(tripMembers)
    .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, userId)))
    .limit(1);

  if (!membership?.isRequired) {
    throw new ApiError(
      403,
      "Forbidden",
      "Only required members may run research commands on this trip",
    );
  }

  return await loadAndAssertTripModeForBrief(handle, tripId, candidates);
}
