import { eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { sharedTrips } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { metrics } from "../observability/metrics.js";

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
  operation: "invitation" | "consent" | "planning" | "confirmation" | "booking" | "change_event" = "planning",
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