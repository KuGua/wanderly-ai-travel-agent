/**
 * Personal Route Endpoint Routes — Phase 4.
 *
 * Owner-facing route endpoints for navigation/mobility research:
 *  - `GET  /api/v1/trips/:tripId/route-endpoints/proposals?query=…` —
 *    server-controlled candidate list (REF-only, never LLM).
 *  - `POST /api/v1/trips/:tripId/route-endpoints` — adopt a candidate
 *    as an ACTIVE non-OWNER_PRIVATE trip_place suitable for
 *    `navigation.route` invocation.
 *  - `GET  /api/v1/trips/:tripId/route-endpoints` — list the owner's
 *    most recently adopted ACTIVE route endpoints.
 *
 * All three endpoints enforce trip-membership; OWNER_PRIVATE
 * visibility is rejected at the adopt boundary.
 */

import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { db } from "../db/database.js";
import { agentTaskRuns, researchRouteSelections, tripMembers, tripPlaces } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import {
  adoptRouteEndpoint,
  listAdoptedRouteEndpoints,
  proposeRouteEndpoints,
  type RouteEndpointCandidate,
} from "../services/personal-route-place-proposal-service.js";
import { evaluateReadiness } from "../services/personal-research-readiness-service.js";
import { createRequestContext } from "../utils/context.js";
import {
  errorResponseSchema,
  toJsonSchema,
  uuidSchema,
} from "../types/schemas.js";

const tripIdParamSchema = z.object({
  tripId: uuidSchema,
}).strict();

const proposalsQuerySchema = z.object({
  query: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(5).optional(),
}).strict();

// The browser may only submit an opaque candidate identity previously exposed
// by this server. Names, coordinates, confidence and provenance are loaded
// again from `trip_places`; they are never trusted from the request body.
const adoptBodySchema = z.object({
  sourceId: z.string().trim().min(1).max(256),
}).strict();

const selectionParamsSchema = z.object({ runId: uuidSchema }).strict();
const selectionBodySchema = z.object({
  originPlaceId: uuidSchema,
  destinationPlaceId: uuidSchema,
  mode: z.enum(["WALK", "DRIVE", "CYCLE"]),
}).strict().refine((value) => value.originPlaceId !== value.destinationPlaceId, {
  message: "Origin and destination must differ",
});

const adoptResponseSchema = z.object({
  placeId: uuidSchema,
}).strict();

const listResponseSchema = z.object({
  endpoints: z.array(z.object({
    placeId: uuidSchema,
    displayName: z.string().min(1).max(256),
    longitude: z.number(),
    latitude: z.number(),
  }).strict()).max(2),
}).strict();

const proposalsResponseSchema = z.object({
  candidates: z.array(z.object({
    sourceId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    countryCode: z.string().nullable(),
    cityName: z.string().nullable(),
    longitude: z.number(),
    latitude: z.number(),
    provenance: z.enum(["REFERENCE", "INSPIRATION"]),
  }).strict()).max(5),
}).strict();

async function requireTripMember(tripId: string, userId: string): Promise<void> {
  const [member] = await db.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, userId)))
    .limit(1);
  if (!member) throw new ApiError(403, "Forbidden", "Not a member of this trip");
}

export async function personalRouteEndpointsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/trips/:tripId/route-endpoints/proposals", {
    schema: {
      description: "Phase 4 — list server-controlled route-endpoint candidates.",
      response: {
        200: toJsonSchema(proposalsResponseSchema),
        403: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const { tripId } = tripIdParamSchema.parse(request.params);
    const { query, limit } = proposalsQuerySchema.parse(request.query);
    await requireTripMember(tripId, request.user.id);
    const candidates = await proposeRouteEndpoints({
      ctx: createRequestContext(
        request.user.id, request.correlationId, request.traceId,
        request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
      ),
      tripId,
      ownerUserId: request.user.id,
      query,
      limit,
    });
    return { candidates };
  });

  app.post("/trips/:tripId/route-endpoints", {
    schema: {
      description: "Phase 4 — adopt a route-endpoint candidate as an ACTIVE non-private trip_place.",
      response: {
        201: toJsonSchema(adoptResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        422: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const { tripId } = tripIdParamSchema.parse(request.params);
    const body = adoptBodySchema.parse(request.body);
    await requireTripMember(tripId, request.user.id);
    const match = /^trip_place:([0-9a-f-]{36})$/i.exec(body.sourceId);
    if (!match) throw new ApiError(422, "Unprocessable Entity", "Route endpoint candidate is invalid");
    const [candidate] = await db.select().from(tripPlaces).where(and(
      eq(tripPlaces.id, match[1]!),
      eq(tripPlaces.tripId, tripId),
      eq(tripPlaces.status, "ACTIVE"),
      ne(tripPlaces.visibility, "OWNER_PRIVATE"),
    )).limit(1);
    if (!candidate) throw new ApiError(422, "Unprocessable Entity", "Route endpoint candidate is unavailable");
    const { placeId } = await adoptRouteEndpoint({
      ctx: createRequestContext(
        request.user.id, request.correlationId, request.traceId,
        request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
      ),
      tripId,
      ownerUserId: request.user.id,
      sourceId: body.sourceId,
      displayName: candidate.displayName,
      countryCode: candidate.countryCode,
      cityName: candidate.cityName,
      longitude: candidate.longitude ?? 0,
      latitude: candidate.latitude ?? 0,
      visibility: candidate.visibility as "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL",
      kind: candidate.kind,
    });
    return reply.code(201).send({ placeId });
  });

  app.put("/agent-runs/:runId/route-selection", {
    schema: {
      description: "Persist the owner-selected route endpoints and transport mode for a PROPOSED Personal intent.",
      response: { 204: { type: "null" }, 403: toJsonSchema(errorResponseSchema), 409: toJsonSchema(errorResponseSchema), 422: toJsonSchema(errorResponseSchema) },
    },
  }, async (request, reply) => {
    const { runId } = selectionParamsSchema.parse(request.params);
    const body = selectionBodySchema.parse(request.body);
    const [run] = await db.select().from(agentTaskRuns).where(and(
      eq(agentTaskRuns.id, runId),
      eq(agentTaskRuns.operation, "CONVERSATION"),
      eq(agentTaskRuns.createdByUserId, request.user.id),
      eq(agentTaskRuns.researchIntentState, "PROPOSED"),
    )).limit(1);
    if (!run?.tripId || !run.researchIntentDraft
      || !run.researchIntentDraft.requestedCapabilities.some((capability: string) => capability === "navigation" || capability === "mobility")) {
      throw new ApiError(409, "Conflict", "Route selection is not available for this intent");
    }
    const places = await db.select({ id: tripPlaces.id }).from(tripPlaces).where(and(
      eq(tripPlaces.tripId, run.tripId),
      eq(tripPlaces.status, "ACTIVE"),
      ne(tripPlaces.visibility, "OWNER_PRIVATE"),
    ));
    const valid = new Set(places.map((place) => place.id));
    if (!valid.has(body.originPlaceId) || !valid.has(body.destinationPlaceId)) {
      throw new ApiError(422, "Unprocessable Entity", "Route endpoints must be active non-private places in this trip");
    }
    await db.insert(researchRouteSelections).values({
      intentRunId: runId,
      tripId: run.tripId,
      ownerUserId: request.user.id,
      originPlaceId: body.originPlaceId,
      destinationPlaceId: body.destinationPlaceId,
      mode: body.mode,
    }).onConflictDoUpdate({
      target: researchRouteSelections.intentRunId,
      set: { originPlaceId: body.originPlaceId, destinationPlaceId: body.destinationPlaceId, mode: body.mode, updatedAt: new Date() },
    });
    const readiness = await evaluateReadiness({
      tripId: run.tripId,
      ownerUserId: request.user.id,
      intentRunId: runId,
      requestedCapabilities: run.researchIntentDraft.requestedCapabilities,
    });
    await db.update(agentTaskRuns).set({
      researchIntentDraft: {
        ...run.researchIntentDraft,
        readiness: readiness.readiness,
        blockers: readiness.blockers,
        warnings: readiness.warnings,
        missing: readiness.missing,
      },
      updatedAt: new Date(),
    }).where(and(eq(agentTaskRuns.id, runId), eq(agentTaskRuns.researchIntentState, "PROPOSED")));
    return reply.code(204).send();
  });

  app.get("/trips/:tripId/route-endpoints", {
    schema: {
      description: "Phase 4 — list the owner's most recently adopted route endpoints.",
      response: {
        200: toJsonSchema(listResponseSchema),
        403: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const { tripId } = tripIdParamSchema.parse(request.params);
    await requireTripMember(tripId, request.user.id);
    const endpoints: Array<{ placeId: string; displayName: string; longitude: number; latitude: number }> =
      await listAdoptedRouteEndpoints({ tripId, ownerUserId: request.user.id });
    return { endpoints };
  });
}
