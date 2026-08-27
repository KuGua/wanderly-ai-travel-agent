import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { tripMembers } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { changeEventSchema } from "../types/schemas.js";
import { processChangeEvent } from "../services/change-event-service.js";
import { requireActiveTrip } from "../services/trip-status-guard.js";
import { createRequestContext } from "../utils/context.js";
import { ApiError } from "../middleware/error-handler.js";

export async function changeEventRoutes(app: FastifyInstance) {
  // Submit change event
  app.post("/change-events", {
    
      

  }, async (request) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const body = changeEventSchema.parse(request.body);

    // Verify membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    await requireActiveTrip(body.tripId, "change_event");

    const result = await processChangeEvent({
      ctx,
      tripId: body.tripId,
      eventId: body.eventId,
      eventType: body.eventType,
      payload: body.payload,
    });

    return {
      message: result.replanned ? "Change event processed, plan regenerated" : "Change event recorded",
      ...result,
    };
  });
}
