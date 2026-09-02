import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ApiError } from "../middleware/error-handler.js";
import { withMemoryIdempotency } from "./memory-idempotency.js";
import { createRequestContext } from "../utils/context.js";
import { MemoryFieldRejectedError } from "../services/preference-fact-service.js";
import {
  TripMembershipError,
  deleteTripMemory,
  listGroupDecisions,
  listOverridesForOwner,
  saveGroupDecision,
  saveOverride,
  type TripMemoryFact,
} from "../services/trip-memory-service.js";
import {
  readPreferenceCard,
  resolvePreferenceCard,
} from "../services/trip-preference-card-service.js";

/**
 * Trip-scoped memory API (docs/long-term-memory-implementation.md §5.3).
 *
 * Everything here is scoped by the `tripId` in the path and the caller's own
 * identity. `GET /trips/:tripId/memory/me` returns only the caller's own
 * overrides; `GET /trips/:tripId/memory` returns group decisions, which every
 * active member may see. Neither ever returns another member's private data.
 */

const putValueSchema = z.object({ value: z.unknown() }).strict();

function serialize(fact: TripMemoryFact) {
  return {
    id: fact.id,
    fieldKey: fact.fieldKey,
    value: fact.value,
    kind: fact.kind,
    source: fact.source,
    status: fact.status,
    updatedAt: fact.updatedAt.toISOString(),
  };
}

/**
 * Membership failures are 403, not 404: the trip id came from the caller's own
 * URL and its existence is not a secret worth hiding behind a wrong status.
 */
function toApiError(error: unknown): unknown {
  if (error instanceof TripMembershipError) {
    return new ApiError(403, "Forbidden", "You are not an active member of this trip");
  }
  if (error instanceof MemoryFieldRejectedError) {
    switch (error.reason) {
      case "UNREGISTERED_FIELD":
        return new ApiError(404, "Not Found", "Unknown memory field");
      case "SENSITIVE_FIELD":
        return new ApiError(403, "Forbidden", "This field cannot be stored on a trip");
      default:
        return new ApiError(422, "Validation Error", "Value does not match the field schema");
    }
  }
  return error;
}

export async function tripMemoryRoutes(app: FastifyInstance) {
  /** The caller's own overrides for this trip. */
  app.get<{ Params: { tripId: string } }>("/trips/:tripId/memory/me", async (request) => {
    try {
      const overrides = await listOverridesForOwner(request.params.tripId, request.user.id);
      return { overrides: overrides.map(serialize) };
    } catch (error) {
      throw toApiError(error);
    }
  });

  /** Group decisions, visible to every active member. */
  app.get<{ Params: { tripId: string } }>("/trips/:tripId/memory", async (request) => {
    try {
      const decisions = await listGroupDecisions(request.params.tripId, request.user.id);
      return { groupDecisions: decisions.map(serialize) };
    } catch (error) {
      throw toApiError(error);
    }
  });

  /** Saves or replaces the caller's own preference for this trip. */
  app.put<{ Params: { tripId: string; fieldKey: string } }>(
    "/trips/:tripId/memory/me/overrides/:fieldKey",
    async (request) => {
      const ctx = createRequestContext(
        request.user.id, request.correlationId, request.traceId,
        request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
      );
      const { value } = putValueSchema.parse(request.body);

      try {
        return await withMemoryIdempotency({
          request,
          userId: request.user.id,
          operation: "trip.override",
          entityType: "trip_memory_fact",
          entityId: (result) => result.id,
        }, async () => serialize(await saveOverride({
          ctx,
          tripId: request.params.tripId,
          userId: request.user.id,
          fieldKey: request.params.fieldKey,
          value,
        })));
      } catch (error) {
        throw toApiError(error);
      }
    },
  );

  /** Saves or replaces a whole-group decision for this trip. */
  app.put<{ Params: { tripId: string; fieldKey: string } }>(
    "/trips/:tripId/memory/group-decisions/:fieldKey",
    async (request) => {
      const ctx = createRequestContext(
        request.user.id, request.correlationId, request.traceId,
        request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
      );
      const { value } = putValueSchema.parse(request.body);

      try {
        return await withMemoryIdempotency({
          request,
          userId: request.user.id,
          operation: "trip.group",
          entityType: "trip_memory_fact",
          entityId: (result) => result.id,
        }, async () => serialize(await saveGroupDecision({
          ctx,
          tripId: request.params.tripId,
          userId: request.user.id,
          fieldKey: request.params.fieldKey,
          value,
        })));
      } catch (error) {
        throw toApiError(error);
      }
    },
  );

  /** Deletes the caller's own override, or a group decision on their trip. */
  app.delete<{ Params: { tripId: string; factId: string } }>(
    "/trips/:tripId/memory/:factId",
    async (request, reply) => {
      const ctx = createRequestContext(
        request.user.id, request.correlationId, request.traceId,
        request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
      );

      try {
        const removed = await deleteTripMemory({
          ctx,
          tripId: request.params.tripId,
          userId: request.user.id,
          factId: request.params.factId,
        });
        // `false` covers both "no such row" and "not yours to delete"; the
        // service already refused another member's override.
        if (!removed) throw new ApiError(404, "Not Found", "Trip memory not found");
        return reply.code(204).send();
      } catch (error) {
        throw toApiError(error);
      }
    },
  );

  // ─── GET /trips/:tripId/preference-card ──────────────────────────────────
  // What applies on this trip today, and whether the member has been asked.
  app.get<{ Params: { tripId: string } }>("/trips/:tripId/preference-card", async (request) => {
    const { tripId } = z.object({ tripId: z.string().uuid() }).parse(request.params);
    try {
      return await readPreferenceCard({ tripId, userId: request.user.id });
    } catch (error) {
      if (error instanceof TripMembershipError) throw new ApiError(403, "Forbidden", error.message);
      throw error;
    }
  });

  // ─── POST /trips/:tripId/preference-card ─────────────────────────────────
  // The member's answer. An empty list is an answer: the profile is right for
  // this trip, so nothing is overridden and the trip keeps inheriting.
  app.post<{ Params: { tripId: string } }>("/trips/:tripId/preference-card", async (request) => {
    const { tripId } = z.object({ tripId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      adjustments: z.array(z.object({
        fieldKey: z.string().min(1).max(64),
        value: z.unknown(),
      }).strict()).max(16),
    }).strict().parse(request.body);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    try {
      return await resolvePreferenceCard({ ctx, tripId, userId: request.user.id, adjustments: body.adjustments });
    } catch (error) {
      if (error instanceof TripMembershipError) throw new ApiError(403, "Forbidden", error.message);
      if (error instanceof MemoryFieldRejectedError) throw new ApiError(422, "Unprocessable Entity", error.message);
      throw error;
    }
  });
}
