import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

import { db } from "../db/database.js";
import {
  planningResearchResults,
  tripMembers,
  tripSearchPreferences,
  tripStaySearchPreferences,
} from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { createConstraintSnapshot } from "../services/planning-service.js";
import { requireResearchEligible } from "../services/trip-status-guard.js";
import { acceptResearchTask } from "../tasks/task-repository.js";
import { publishAgentStreamEvent } from "../tasks/task-stream-publisher.js";
import {
  errorResponseSchema,
  latestResearchResultResponseSchema,
  researchCommandAcceptedResponseSchema,
  researchCommandRequestSchema,
  toJsonSchema,
} from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";

const tripIdParamSchema = z.object({ tripId: z.string().uuid() }).strict();

/**
 * Phase 2 — Personal Trip Orchestrator routes.
 *
 * - `POST /api/v1/trips/:tripId/research` — owner (or any required member)
 *   confirms a research command. The request body is `.strict()` and rejects
 *   every authority field (`snapshotId`, `provider`, `latitude`,
 *   `longitude`, `placeId`, `dates`, `currency`, `toolCallId`, `identity`,
 *   chat content). Server derives every authority field from the active
 *   Trip + required-member state. Returns 202 with the run envelope.
 * - `GET /api/v1/trips/:tripId/research/latest` — returns the latest safe
 *   research summary for the trip. Phase 3 populates rows; Phase 2 returns
 *   `result: null` until the orchestrator has run.
 */
export async function researchRoutes(app: FastifyInstance): Promise<void> {
  app.post("/trips/:tripId/research", {
    schema: {
      description: "Phase 2 — owner-confirmed research command for a solo/team Trip.",
      // The Fastify `body` schema is intentionally omitted: Zod `.strict()`
      // is the single source of truth and runs inside the handler via
      // `researchCommandRequestSchema.parse(request.body)`. Reusing the
      // converted JSON schema here would risk Fastify's validator
      // accepting unknown keys silently.
      response: {
        202: toJsonSchema(researchCommandAcceptedResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
        409: toJsonSchema(errorResponseSchema),
        422: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const { tripId } = tripIdParamSchema.parse(request.params);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const body = researchCommandRequestSchema.parse(request.body);

    const [tripRow] = await db.select({
      id: tripMembers.tripId,
      destinationCandidates: tripMembers.tripId,
    }).from(tripMembers)
      .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);
    void tripRow; // Membership probe only — full trip row loaded below.

    // We need the trip's destinationCandidates + travel dates for mode-aware
    // validation + snapshot.
    const fullTripRow = await db.query.sharedTrips.findFirst({
      where: (t, { eq: e }) => e(t.id, tripId),
    });
    if (!fullTripRow) throw new ApiError(404, "Not Found", "Trip not found");

    // 2) Mode-aware eligibility — Draft trips rejected, optional members
    //    rejected, candidates must match SOLO 1..5 / TEAM 2..5.
    await requireResearchEligible(tripId, request.user.id, fullTripRow.destinationCandidates);

    // 3) Load the latest confirmed search-preference versions. Phase 3 may
    //    split this into a capability-aware validator that 422s on missing
    //    preferences; for Phase 2 we mirror `/planning/generate` and 422
    //    when flight preferences are missing.
    const [latestFlightPref] = await db.select().from(tripSearchPreferences)
      .where(eq(tripSearchPreferences.tripId, tripId))
      .orderBy(desc(tripSearchPreferences.version))
      .limit(1);
    if (!latestFlightPref) {
      throw new ApiError(
        422,
        "Unprocessable Entity",
        "RESEARCH_CAPABILITY_GAP: trip has no confirmed flight search preferences",
      );
    }
    const [latestStayPref] = process.env.PLAN_ENABLE_HOTEL === "true"
      ? await db.select().from(tripStaySearchPreferences)
        .where(eq(tripStaySearchPreferences.tripId, tripId))
        .orderBy(desc(tripStaySearchPreferences.version))
        .limit(1)
      : [null];

    // 4) Build an immutable constraint snapshot.
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [],
      departureCities: [],
      destinationCandidates: fullTripRow.destinationCandidates,
      travelDateStart: fullTripRow.travelDateStart ?? undefined,
      travelDateEnd: fullTripRow.travelDateEnd ?? undefined,
    });

    // 5) Accept the durable task. Idempotent on (tripId, requestId) via the
    //    partial unique index `agent_task_runs_trip_request_unique`.
    const accepted = await acceptResearchTask({
      ctx,
      tripId,
      userId: request.user.id,
      snapshotId,
      flightSearchPreferencesVersion: latestFlightPref.version,
      staySearchPreferencesVersion: latestStayPref?.version ?? undefined,
      outputMode: body.outputMode,
      requestedCapabilities: body.requestedCapabilities,
      requestId: body.requestId,
    });

    // 6) Publish SNAPSHOT_CREATED so the UI run card has a stage before the
    //    Worker picks up. The Worker emits RESEARCHING / VALIDATING /
    //    PERSISTING / COMPLETED.
    await publishAgentStreamEvent({
      event: "research.stage",
      runId: accepted.runId,
      generationAttempt: 0,
      stage: "SNAPSHOT_CREATED",
      traceparent: request.traceparent,
    });

    const response = researchCommandAcceptedResponseSchema.parse({
      runId: accepted.runId,
      operation: accepted.operation,
      snapshotId: accepted.snapshotId,
      status: accepted.status,
    });
    return reply.code(202).send(response);
  });

  app.get("/trips/:tripId/research/latest", {
    schema: {
      description: "Phase 2 — read the latest safe research summary for the trip.",
      response: {
        200: toJsonSchema(latestResearchResultResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const { tripId } = tripIdParamSchema.parse(request.params);

    // Caller must be a member of the trip.
    const [membership] = await db.select({ userId: tripMembers.userId }).from(tripMembers).where(and(
      eq(tripMembers.tripId, tripId),
      eq(tripMembers.userId, request.user.id),
    )).limit(1);
    if (!membership) throw new ApiError(403, "Forbidden", "Not a member of this trip");

    const [latest] = await db.select().from(planningResearchResults)
      .where(eq(planningResearchResults.tripId, tripId))
      .orderBy(desc(planningResearchResults.createdAt))
      .limit(1);

    const payload = latestResearchResultResponseSchema.parse({
      result: latest ? {
        id: latest.id,
        tripId: latest.tripId,
        snapshotId: latest.snapshotId,
        agentTaskRunId: latest.agentTaskRunId,
        status: latest.status as "COMPLETE" | "COMPLETED_WITH_GAPS",
        serviceGaps: latest.serviceGaps,
        resultPlanId: latest.resultPlanId,
        createdAt: latest.createdAt.toISOString(),
      } : null,
    });
    return reply.code(200).send(payload);
  });
}
