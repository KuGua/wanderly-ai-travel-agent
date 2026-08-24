import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { tripMembers } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { bookingRequestSchema, sandboxCallbackSchema } from "../types/schemas.js";
import { submitBooking, handleSandboxCallback } from "../services/booking-service.js";
import { createRequestContext } from "../utils/context.js";

export async function bookingRoutes(app: FastifyInstance) {
  // Submit booking to sandbox
  app.post("/bookings", {
    
      

  }, async (request, reply) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId);
    const body = bookingRequestSchema.parse(request.body);

    // Verify membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      reply.code(403).send({ statusCode: 403, error: "Forbidden", message: "Not a member of this trip" });
      return;
    }

    try {
      const result = await submitBooking({
        ctx,
        planId: body.planId,
        tripId: body.tripId,
        orchestrationRequestId: body.orchestrationRequestId,
        requestedBy: request.user.id,
      });

      return {
        message: result.isDuplicate ? "Duplicate request — returning cached result" : "Booking submitted",
        ...result,
      };
    } catch (error: unknown) {
      reply.code(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: error instanceof Error ? error.message : "Unknown booking error",
      });
    }
  });

  // Handle sandbox callback
  app.post("/bookings/callback", {
    
      

  }, async (request, reply) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId);
    const body = sandboxCallbackSchema.parse(request.body);

    try {
      const result = await handleSandboxCallback({
        ctx,
        orchestrationRequestId: body.orchestrationRequestId,
        eventId: body.eventId,
        serviceResults: body.serviceResults,
      });

      return {
        message: result.isDuplicate ? "Duplicate callback — ignored" : "Callback processed",
        ...result,
      };
    } catch (error: unknown) {
      reply.code(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: error instanceof Error ? error.message : "Unknown callback error",
      });
    }
  });
}
