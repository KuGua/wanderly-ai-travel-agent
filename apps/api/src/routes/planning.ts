import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { sharedTrips, tripMembers } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { planRequestSchema } from "../types/schemas.js";
import { createConstraintSnapshot, generatePlan, getLatestActivePlan } from "../services/planning-service.js";
import { checkVisaReadiness } from "../services/visa-service.js";
import { createRequestContext } from "../utils/context.js";
import { ApiError } from "../middleware/error-handler.js";

export async function planningRoutes(app: FastifyInstance) {
  // Generate plan for a trip
  app.post("/planning/generate", {
    
      

  }, async (request) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId);
    const body = planRequestSchema.parse(request.body);

    // Verify membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    // Get trip details
    const [trip] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, body.tripId)).limit(1);
    if (!trip) {
      throw new ApiError(404, "Not Found", "Trip not found");
    }

    // Get all required members
    const members = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.isRequired, true)));

    // Create constraint snapshot
    const snapshotId = await createConstraintSnapshot({
      tripId: body.tripId,
      memberIds: members.map(m => m.userId),
      departureCities: trip.departureCities as string[],
      destinationCandidates: trip.destinationCandidates as string[],
      travelDateStart: trip.travelDateStart ?? undefined,
      travelDateEnd: trip.travelDateEnd ?? undefined,
    });

    // Generate plan for first destination candidate (simplified)
    const destination = (trip.destinationCandidates as string[])[0];
    const planId = await generatePlan({
      ctx,
      tripId: body.tripId,
      snapshotId,
      destination,
      memberIds: members.map(m => m.userId),
    });

    // Get visa readiness for each member
    const visaChecks = await Promise.all(
      members.map(m => checkVisaReadiness({
        planId,
        snapshotId,
        memberId: m.userId,
        tripId: body.tripId,
        destinationCountry: destination,
      }))
    );

    const plan = await getLatestActivePlan(body.tripId);

    return {
      planId,
      snapshotId,
      plan: plan?.planData,
      visaChecks,
      message: "Plan generated successfully",
    };
  });

  // Get latest plan for a trip
  app.get("/planning/:tripId/latest", async (request) => {
    const { tripId } = request.params as { tripId: string };

    // Verify membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    const plan = await getLatestActivePlan(tripId);
    if (!plan) {
      throw new ApiError(404, "Not Found", "No active plan found");
    }

    return { plan };
  });
}
