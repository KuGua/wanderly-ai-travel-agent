import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

import { db } from "../db/database.js";
import {
  planningResearchResults,
  agentTaskRuns,
  researchRouteSelections,
  tripPlaces,
  sharedTrips,
  tripMembers,
  tripSearchPreferences,
  tripStaySearchPreferences,
} from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { createConstraintSnapshot } from "../services/planning-service.js";
import { requireResearchEligible } from "../services/trip-status-guard.js";
import { acceptResearchTask, findResearchTaskByRequestId, transitionResearchIntentState } from "../tasks/task-repository.js";
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

    // The Trip row lock serializes retries of the same request ID. The durable
    // task is checked before allocating a snapshot, preventing orphaned
    // snapshots on idempotent retries.
    const command = await db.transaction(async (tx) => {
      const [trip] = await tx.select().from(sharedTrips)
        .where(eq(sharedTrips.id, tripId)).for("update").limit(1);
      if (!trip) throw new ApiError(404, "Not Found", "Trip not found");

      const existing = await findResearchTaskByRequestId({ tripId, requestId: body.requestId, tx });
      if (existing) return { accepted: existing, created: false };

      // A classifier-derived command may be accepted exactly once. Locking the
      // source row serializes two distinct request IDs racing to confirm the
      // same proposal; the transition below is in this transaction with task
      // creation so failures leave the draft actionable.
      if (body.originatingIntentRunId) {
        const [intentRun] = await tx.select().from(agentTaskRuns)
          .where(eq(agentTaskRuns.id, body.originatingIntentRunId)).for("update").limit(1);
        if (!intentRun
          || intentRun.operation !== "CONVERSATION"
          || intentRun.tripId !== tripId
          || intentRun.createdByUserId !== request.user.id
          || intentRun.researchIntentState !== "PROPOSED"
          || !intentRun.researchIntentDraft) {
          throw new ApiError(409, "Conflict", "Research intent is no longer available for confirmation");
        }
        const draft = intentRun.researchIntentDraft;
        if (draft.kind !== body.outputMode
          || draft.requestedCapabilities.length !== body.requestedCapabilities.length
          || draft.requestedCapabilities.some((capability) => !body.requestedCapabilities.includes(capability))) {
          throw new ApiError(422, "Unprocessable Entity", "Research command does not match the proposed intent");
        }
        if (draft.requestedCapabilities.some((capability: string) => capability === "navigation" || capability === "mobility")) {
          const [selection] = await tx.select().from(researchRouteSelections).where(and(
            eq(researchRouteSelections.intentRunId, intentRun.id),
            eq(researchRouteSelections.tripId, tripId),
            eq(researchRouteSelections.ownerUserId, request.user.id),
          )).limit(1);
          if (!selection) throw new ApiError(422, "Unprocessable Entity", "RESEARCH_CAPABILITY_GAP: route endpoints and mode must be selected");
          const places = await tx.select({ id: tripPlaces.id }).from(tripPlaces).where(and(
            eq(tripPlaces.tripId, tripId),
            eq(tripPlaces.status, "ACTIVE"),
            ne(tripPlaces.visibility, "OWNER_PRIVATE"),
            inArray(tripPlaces.id, [selection.originPlaceId, selection.destinationPlaceId]),
          ));
          if (places.length !== 2) throw new ApiError(422, "Unprocessable Entity", "RESEARCH_CAPABILITY_GAP: selected route endpoints are no longer active");
        }
      }

      await requireResearchEligible(tripId, request.user.id, trip.destinationCandidates, tx);
      if (trip.departureCities.length === 0 || !trip.travelDateStart || !trip.travelDateEnd) {
        throw new ApiError(422, "Unprocessable Entity", "RESEARCH_CAPABILITY_GAP: trip requires departure cities and travel dates");
      }

      const requiresFlightPreferences = body.outputMode === "PROPOSE_PLAN"
        || body.requestedCapabilities.includes("flight")
        || body.requestedCapabilities.includes("activities")
        || body.requestedCapabilities.includes("mobility");
      if (body.outputMode === "PROPOSE_PLAN" && !body.requestedCapabilities.includes("flight")) {
        throw new ApiError(422, "Unprocessable Entity", "RESEARCH_CAPABILITY_GAP: PROPOSE_PLAN requires flight capability");
      }
      const [latestFlightPref] = requiresFlightPreferences
        ? await tx.select().from(tripSearchPreferences)
          .where(eq(tripSearchPreferences.tripId, tripId))
          .orderBy(desc(tripSearchPreferences.version)).limit(1)
        : [undefined];
      if (requiresFlightPreferences && !latestFlightPref) {
        throw new ApiError(422, "Unprocessable Entity", "RESEARCH_CAPABILITY_GAP: trip has no confirmed flight search preferences");
      }
      const requiresStayPreferences = body.requestedCapabilities.includes("hotel")
        && process.env.PLAN_ENABLE_HOTEL === "true";
      const [latestStayPref] = requiresStayPreferences
        ? await tx.select().from(tripStaySearchPreferences)
          .where(eq(tripStaySearchPreferences.tripId, tripId))
          .orderBy(desc(tripStaySearchPreferences.version)).limit(1)
        : [undefined];
      if (requiresStayPreferences && !latestStayPref) {
        throw new ApiError(422, "Unprocessable Entity", "RESEARCH_CAPABILITY_GAP: trip has no confirmed stay search preferences");
      }

      const snapshotId = await createConstraintSnapshot({
        tripId,
        memberIds: [],
        departureCities: trip.departureCities,
        destinationCandidates: trip.destinationCandidates,
        travelDateStart: trip.travelDateStart,
        travelDateEnd: trip.travelDateEnd,
        tx,
      });
      const accepted = await acceptResearchTask({
        ctx,
        tripId,
        userId: request.user.id,
        snapshotId,
        flightSearchPreferencesVersion: latestFlightPref?.version,
        staySearchPreferencesVersion: latestStayPref?.version,
        outputMode: body.outputMode,
        requestedCapabilities: body.requestedCapabilities,
        originatingIntentRunId: body.originatingIntentRunId,
        // Spec §3.1: bind the hotel provider at acceptance. `undefined` here
        // lets `acceptResearchTask` resolve `HOTEL_PROVIDER` itself when the
        // task uses the hotel capability; `null` when the capability is not
        // requested so the row never carries a misleading provider.
        hotelProvider: requiresStayPreferences ? undefined : null,
        requestId: body.requestId,
        tx,
      });
      if (body.originatingIntentRunId) {
        const transitioned = await transitionResearchIntentState({
          runId: body.originatingIntentRunId,
          fromState: "PROPOSED",
          toState: "CONFIRMED",
          tx,
        });
        if (!transitioned) {
          throw new ApiError(409, "Conflict", "Research intent is no longer available for confirmation");
        }
      }
      return { accepted, created: true };
    });

    // 6) Publish SNAPSHOT_CREATED so the UI run card has a stage before the
    //    Worker picks up. The Worker emits RESEARCHING / VALIDATING /
    //    PERSISTING / COMPLETED.
    if (command.created) {
      await publishAgentStreamEvent({
        event: "research.stage",
        runId: command.accepted.runId,
        generationAttempt: 0,
        stage: "SNAPSHOT_CREATED",
        traceparent: request.traceparent,
      });
    }

    const response = researchCommandAcceptedResponseSchema.parse({
      runId: command.accepted.runId,
      operation: command.accepted.operation,
      snapshotId: command.accepted.snapshotId,
      status: command.accepted.status,
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
