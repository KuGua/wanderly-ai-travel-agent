import { eq, and } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { sharedTrips, tripMembers } from "../db/schema.js";
import { planRequestSchema } from "../types/schemas.js";
import { createConstraintSnapshot, generatePlan, getLatestActivePlan } from "../services/planning-service.js";
import { checkVisaReadiness } from "../services/visa-service.js";
import { createRequestContext } from "../utils/context.js";
import { ApiError } from "../middleware/error-handler.js";

export async function planningRoutes(app: FastifyInstance) {
  // Generate plans for a trip — produces one plan per destination candidate
  // (so two to three destinations all get their own flights/stay/ground and
  // visa checks, each anchored to the same shared snapshot).
  app.post("/planning/generate", async (request) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const body = planRequestSchema.parse(request.body);

    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    const [trip] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, body.tripId)).limit(1);
    if (!trip) {
      throw new ApiError(404, "Not Found", "Trip not found");
    }

    const members = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.isRequired, true)));
    const memberIds = members.map(m => m.userId);

    const destinationCandidates = (trip.destinationCandidates as string[]) ?? [];
    if (destinationCandidates.length === 0) {
      throw new ApiError(422, "Unprocessable Entity", "Trip has no destination candidates");
    }

    const departureCities = (trip.departureCities as string[]) ?? [];
    const travelDateStart = trip.travelDateStart ?? undefined;
    const travelDateEnd = trip.travelDateEnd ?? undefined;

    // One shared snapshot anchors every plan in this round.
    const snapshotId = await createConstraintSnapshot({
      tripId: body.tripId,
      memberIds,
      departureCities,
      destinationCandidates,
      travelDateStart,
      travelDateEnd,
    });

    // One plan per destination candidate, all referencing the same snapshot.
    const plans: Array<{ destination: string; planId: string; snapshotId: string }> = [];
    for (const destination of destinationCandidates) {
      const planId = await generatePlan({
        ctx,
        tripId: body.tripId,
        snapshotId,
        destination,
        memberIds,
      });
      plans.push({ destination, planId, snapshotId });
    }

    // Visa checks run per (destination, member) pair against the same snapshot.
    const visaChecksByDestination: Record<string, unknown[]> = {};
    for (const plan of plans) {
      const checks = await Promise.all(
        memberIds.map(memberId => checkVisaReadiness({
          planId: plan.planId,
          snapshotId,
          memberId,
          tripId: body.tripId,
          destinationCountry: plan.destination,
        })),
      );
      visaChecksByDestination[plan.destination] = checks;
    }

    const latestPlan = await getLatestActivePlan(body.tripId);

    return {
      snapshotId,
      plans,
      visaChecksByDestination,
      latestPlan: latestPlan?.planData,
      message: `Plans generated for ${plans.length} destination candidate(s)`,
    };
  });

  app.get("/planning/:tripId/latest", async (request) => {
    const { tripId } = request.params as { tripId: string };

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
