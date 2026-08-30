import { eq, and, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { sharedTrips, tripMembers, tripSearchPreferences, tripStaySearchPreferences } from "../db/schema.js";
import { planRequestSchema } from "../types/schemas.js";
import { createConstraintSnapshot, getLatestActivePlan } from "../services/planning-service.js";
import { acceptResearchTask } from "../tasks/task-repository.js";
import { requireActiveTrip } from "../services/trip-status-guard.js";
import { createRequestContext } from "../utils/context.js";
import { ApiError } from "../middleware/error-handler.js";
import { personalResearchCapabilitySchema } from "../types/schemas.js";
import {
  PlanAdoptionServiceError,
  planAdoptionErrorToApiError,
  soloAdoptProposedPlan,
} from "../services/plan-adoption-service.js";

const FULL_CAPABILITY_SET: readonly string[] = personalResearchCapabilitySchema.options;

export async function planningRoutes(app: FastifyInstance) {
  // Phase 2 — Legacy `POST /planning/generate` is now a thin wrapper around
  // the Personal Trip Orchestrator research command. It builds the same
  // immutable snapshot, calls `acceptResearchTask` with
  // `outputMode: "PROPOSE_PLAN"` and the full capability set, and rewrites
  // the response's `operation` to `"PLAN"` so the public contract stays
  // backward-compatible (existing tests assert `operation: "PLAN"`).
  // New clients should call `POST /api/v1/trips/:tripId/research` directly.
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

    const accepted = await acceptResearchTask({
      ctx, tripId: body.tripId, userId: request.user.id, snapshotId,
      flightSearchPreferencesVersion: latestPreference[0].version,
      staySearchPreferencesVersion: latestStayPreference[0]?.version ?? undefined,
      outputMode: "PROPOSE_PLAN",
      requestedCapabilities: FULL_CAPABILITY_SET,
      requestId: request.clientRequestId ?? randomUUID(),
    });
    // Rewrite operation label for the legacy public contract.
    return reply.code(202).send({
      runId: accepted.runId,
      operation: "PLAN" as const,
      status: accepted.status,
      generationAttempt: accepted.generationAttempt,
      snapshotId: accepted.snapshotId,
    });
  });

  /**
   * Phase 3 — Solo plan adoption. Owner `ACCEPT` flips the `PROPOSED` plan
   * to `ACTIVE` in a single round trip. Rejects TEAM trips with 403 NOT_SOLO
   * (the team flow is `POST /plans/:planId/adoption-votes`).
   */
  app.post("/plans/:planId/accept-solo", async (request, reply) => {
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const { planId } = request.params as { planId: string };

    try {
      const result = await soloAdoptProposedPlan({
        ctx,
        planId,
        userId: request.user.id,
      });
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof PlanAdoptionServiceError) {
        throw planAdoptionErrorToApiError(err);
      }
      throw err;
    }
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
