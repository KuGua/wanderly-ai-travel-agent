import { eq, and, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { sharedTrips, tripMembers, tripSearchPreferences, tripStaySearchPreferences } from "../db/schema.js";
import { planRequestSchema } from "../types/schemas.js";
import { createConstraintSnapshot, getLatestActivePlan } from "../services/planning-service.js";
import { acceptPlanningTask } from "../tasks/task-repository.js";
import { requireActiveTrip } from "../services/trip-status-guard.js";
import { createRequestContext } from "../utils/context.js";
import { ApiError } from "../middleware/error-handler.js";

export async function planningRoutes(app: FastifyInstance) {
  // Generate plans for a trip — produces one plan per destination candidate
  // (so two to three destinations all get their own flights/stay/ground and
  // visa checks, each anchored to the same shared snapshot).
  app.post("/planning/generate", async (request, reply) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const body = planRequestSchema.parse(request.body);

    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    await requireActiveTrip(body.tripId, "planning");

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

    const latestPreference = await db.select().from(tripSearchPreferences)
      .where(eq(tripSearchPreferences.tripId, body.tripId))
      .orderBy(desc(tripSearchPreferences.version)).limit(1);
    if (!latestPreference[0]) throw new ApiError(422, "Unprocessable Entity", "Confirmed flight search preferences are required");
    const latestStayPreference = process.env.PLAN_ENABLE_HOTEL === "true"
      ? await db.select().from(tripStaySearchPreferences).where(eq(tripStaySearchPreferences.tripId, body.tripId)).orderBy(desc(tripStaySearchPreferences.version)).limit(1)
      : [];
    if (process.env.PLAN_ENABLE_HOTEL === "true" && !latestStayPreference[0]) {
      throw new ApiError(422, "Unprocessable Entity", "Confirmed stay search preferences are required");
    }
    const accepted = await acceptPlanningTask({
      ctx, tripId: body.tripId, userId: request.user.id, snapshotId,
      flightSearchPreferencesVersion: latestPreference[0].version,
      staySearchPreferencesVersion: latestStayPreference[0]?.version,
      operation: "PLAN", requestId: request.clientRequestId ?? randomUUID(),
    });
    return reply.code(202).send({ ...accepted, snapshotId });
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
