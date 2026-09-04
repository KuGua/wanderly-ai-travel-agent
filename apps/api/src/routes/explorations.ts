import { z } from "zod";
import type { FastifyInstance } from "fastify";

import { startExploration } from "../services/exploration-service.js";
import { createRequestContext } from "../utils/context.js";
import {
  explorationStartRequestSchema,
  explorationStartResponseSchema,
  toJsonSchema,
} from "../types/schemas.js";
import { metrics } from "../observability/metrics.js";

export async function explorationRoutes(app: FastifyInstance) {
  // `POST /explorations/start` is the only Explore-page path that creates a
  // Trip. The request body carries the client-generated UUIDv4 used as the
  // idempotency key for the trip+member+thread transaction. First call
  // returns 201, same `requestId` replays return 200 with the same body.
  app.post("/explorations/start", {
    schema: {
      description: "Start a new private Draft Trip workspace for the authenticated user. Idempotent on `requestId`.",
      tags: ["explorations"],
      body: toJsonSchema(explorationStartRequestSchema),
      response: {
        201: toJsonSchema(explorationStartResponseSchema),
        200: toJsonSchema(explorationStartResponseSchema),
        409: toJsonSchema(z.object({
          statusCode: z.number(),
          error: z.string(),
          message: z.string(),
          correlationId: z.string().uuid(),
        }).strict()),
      },
    },
  }, async (request, reply) => {
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const body = explorationStartRequestSchema.parse(request.body);

    let result;
    try {
      result = await startExploration({
        ctx,
        userId: request.user.id,
        requestId: body.requestId,
        locale: body.locale,
      });
    } catch (error) {
      metrics.inc("exploration_start_total", { result: "error" });
      throw error;
    }

    metrics.inc("exploration_start_total", {
      result: result.wasCreated ? "created" : "cached",
    });

    // Re-fetch the persisted Trip + thread so the response carries
    // canonical createdAt/updatedAt values.
    const { db } = await import("../db/database.js");
    const { chatThreads, sharedTrips } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");

    const [trip] = await db.select().from(sharedTrips)
      .where(eq(sharedTrips.id, result.tripId)).limit(1);
    const [thread] = await db.select().from(chatThreads)
      .where(eq(chatThreads.id, result.defaultThreadId)).limit(1);
    if (!trip || !thread) {
      throw new Error("exploration_start persistence drift");
    }

    const payload = explorationStartResponseSchema.parse({
      trip: {
        id: trip.id,
        name: trip.name,
        status: trip.status,
        departureCities: [],
        destinationCandidates: [],
        travelDateStart: null,
        travelDateEnd: null,
        createdAt: trip.createdAt.toISOString(),
        updatedAt: trip.updatedAt.toISOString(),
      },
      defaultThread: {
        id: thread.id,
        tripId: thread.tripId,
        scope: "TRIP",
        isDefault: true,
      },
    });

    return reply.code(result.wasCreated ? 201 : 200).send(payload);
  });
}
