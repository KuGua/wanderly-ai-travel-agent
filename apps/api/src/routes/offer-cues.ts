import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { actOnOfferCueCandidate, loadPendingOfferCues } from "../services/offer-cue-service.js";
import { listPersonalOfferSelectionsForTrip } from "../services/personal-offer-selection-service.js";
import { deletePersonalOfferSelection } from "../services/personal-offer-selection-service.js";
import {
  errorResponseSchema,
  offerCueActionRequestSchema,
  offerCueActionResponseSchema,
  personalOfferSelectionDeleteRequestSchema,
  personalOfferSelectionListResponseSchema,
  personalOfferSelectionResponseSchema,
  toJsonSchema,
} from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";

const routeParamsSchema = z.object({
  threadId: z.string().uuid(),
}).strict();

const candidateParamsSchema = z.object({
  threadId: z.string().uuid(),
  cueId: z.string().uuid(),
  candidateId: z.string().uuid(),
}).strict();

const selectionParamsSchema = z.object({
  threadId: z.string().uuid(),
  selectionId: z.string().uuid(),
}).strict();

const queryCapabilitySchema = z.object({
  capability: z.enum(["flight", "hotel"]).optional(),
}).strict();

export async function offerCueRoutes(app: FastifyInstance) {
  app.get("/threads/:threadId/offer-cues", {
    schema: {
      description: "List the owner-only Flight / Hotel Offer Cues that are still OPEN on this thread.",
      tags: ["threads"],
      params: toJsonSchema(routeParamsSchema),
      querystring: toJsonSchema(queryCapabilitySchema),
      response: {
        200: toJsonSchema(z.object({ cues: z.array(z.unknown()) })),
        400: toJsonSchema(errorResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const { threadId } = routeParamsSchema.parse(request.params);
    const query = queryCapabilitySchema.parse(request.query ?? {});
    const cues = await loadPendingOfferCues({
      threadId,
      ownerUserId: request.user.id,
      capability: query.capability,
    });
    return { cues };
  });

  for (const action of ["accept", "dismiss"] as const) {
    app.post(`/threads/:threadId/offer-cues/:cueId/candidates/:candidateId/${action}`, {
      schema: {
        description: `${action} one owner-only Flight/Hotel Offer Cue candidate without booking or changing the Shared Plan.`,
        tags: ["threads"],
        params: toJsonSchema(candidateParamsSchema),
        body: toJsonSchema(offerCueActionRequestSchema),
        response: {
          200: toJsonSchema(offerCueActionResponseSchema),
          400: toJsonSchema(errorResponseSchema),
          403: toJsonSchema(errorResponseSchema),
          404: toJsonSchema(errorResponseSchema),
          409: toJsonSchema(errorResponseSchema),
        },
      },
    }, async (request) => {
      const route = candidateParamsSchema.parse(request.params);
      const body = offerCueActionRequestSchema.parse(request.body);
      return actOnOfferCueCandidate({
        ctx: createRequestContext(
          request.user.id,
          request.correlationId,
          request.traceId,
          request.clientRequestId,
          request.traceparent,
          request.tracestate,
          request.spanId,
        ),
        ...route,
        ownerUserId: request.user.id,
        action,
        requestId: body.requestId,
        expectedVersion: body.expectedVersion,
        timeZone: body.timeZone,
        source: body.source,
      });
    });
  }
}

export async function offerSelectionRoutes(app: FastifyInstance) {
  app.get("/threads/:threadId/offer-selections", {
    schema: {
      description: "List the owner-only personal offer selections for this thread.",
      tags: ["threads"],
      params: toJsonSchema(routeParamsSchema),
      querystring: toJsonSchema(queryCapabilitySchema),
      response: {
        200: toJsonSchema(personalOfferSelectionListResponseSchema),
        400: toJsonSchema(errorResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const { threadId } = routeParamsSchema.parse(request.params);
    const query = queryCapabilitySchema.parse(request.query ?? {});
    const selections = await listPersonalOfferSelectionsForTrip({
      threadId,
      ownerUserId: request.user.id,
      capability: query.capability,
    });
    return { selections };
  });

  app.delete("/threads/:threadId/offer-selections/:selectionId", {
    schema: {
      description: "Mark one personal offer selection as REMOVED. The row is kept for audit; the active selection for the scope is dropped.",
      tags: ["threads"],
      params: toJsonSchema(selectionParamsSchema),
      body: toJsonSchema(personalOfferSelectionDeleteRequestSchema),
      response: {
        200: toJsonSchema(z.object({ selection: personalOfferSelectionResponseSchema.nullable() })),
        400: toJsonSchema(errorResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
        409: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const route = selectionParamsSchema.parse(request.params);
    const body = personalOfferSelectionDeleteRequestSchema.parse(request.body);
    const result = await deletePersonalOfferSelection({
      ctx: createRequestContext(
        request.user.id,
        request.correlationId,
        request.traceId,
        request.clientRequestId,
        request.traceparent,
        request.tracestate,
        request.spanId,
      ),
      ...route,
      ownerUserId: request.user.id,
      requestId: body.requestId,
      expectedVersion: body.expectedVersion,
    });
    return { selection: result };
  });
}
