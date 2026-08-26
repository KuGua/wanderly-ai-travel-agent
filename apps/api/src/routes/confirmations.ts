import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { tripMembers } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { confirmPlanSchema } from "../types/schemas.js";
import { setConfirmation, checkAllConfirmed } from "../services/confirmation-service.js";
import { createRequestContext } from "../utils/context.js";
import { ApiError } from "../middleware/error-handler.js";

export async function confirmationRoutes(app: FastifyInstance) {
  // Confirm or request changes for a plan
  app.post("/confirmations", {
    
      

  }, async (request) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const body = confirmPlanSchema.parse(request.body);

    const tripId = body.tripId;

    // Verify membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    await setConfirmation({
      ctx,
      planId: body.planId,
      userId: request.user.id,
      tripId,
      decision: body.decision,
    });

    const { allConfirmed, confirmations } = await checkAllConfirmed({ planId: body.planId, tripId });

    return {
      message: `Confirmation set to ${body.decision}`,
      allConfirmed,
      confirmations,
    };
  });

  // Get confirmation status for a plan
  app.get("/confirmations/:planId", async (request) => {
    const { planId } = request.params as { planId: string };

    // The plan route performs membership authorization before confirmation.
    const { allConfirmed, confirmations } = await checkAllConfirmed({ planId, tripId: "" });

    return { allConfirmed, confirmations };
  });
}
