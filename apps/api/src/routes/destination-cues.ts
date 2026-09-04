import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { actOnDestinationCue } from "../services/destination-cue-service.js";
import {
  destinationCueActionRequestSchema,
  destinationCueActionResponseSchema,
  errorResponseSchema,
  toJsonSchema,
} from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";

const paramsSchema = z.object({
  threadId: z.string().uuid(),
  cueId: z.string().uuid(),
  candidateId: z.string().uuid(),
}).strict();

export async function destinationCueRoutes(app: FastifyInstance) {
  for (const action of ["accept", "dismiss"] as const) {
    app.post(`/threads/:threadId/destination-cues/:cueId/candidates/:candidateId/${action}`, {
      schema: {
        description: `${action} one owner-only destination candidate without resolving the rest of its batch.`,
        tags: ["threads"],
        params: toJsonSchema(paramsSchema),
        body: toJsonSchema(destinationCueActionRequestSchema),
        response: {
          200: toJsonSchema(destinationCueActionResponseSchema),
          400: toJsonSchema(errorResponseSchema),
          403: toJsonSchema(errorResponseSchema),
          404: toJsonSchema(errorResponseSchema),
          409: toJsonSchema(errorResponseSchema),
        },
      },
    }, async (request) => {
      const route = paramsSchema.parse(request.params);
      const body = destinationCueActionRequestSchema.parse(request.body);
      return actOnDestinationCue({
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
        titleLocale: body.titleLocale ?? "en",
      });
    });
  }
}
