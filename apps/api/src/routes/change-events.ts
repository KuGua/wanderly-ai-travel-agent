import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { tripMembers } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { changeEventSchema } from "../types/schemas.js";
import { processChangeEvent } from "../services/change-event-service.js";
import { createRequestContext } from "../utils/context.js";

export async function changeEventRoutes(app: FastifyInstance) {
  // Submit change event
  app.post("/change-events", {
    
      

  }, async (request, reply) => {
    const ctx = createRequestContext(request.user.id);
    const body = changeEventSchema.parse(request.body);

    // Verify membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      reply.code(403).send({ statusCode: 403, error: "Forbidden", message: "Not a member of this trip" });
      return;
    }

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
