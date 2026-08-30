import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { tripMembers } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { saveConfirmedSearchPreferences } from "../services/flight-search-preferences-service.js";
import { loadLatestStaySearchPreferences, saveConfirmedStaySearchPreferences } from "../services/stay-search-preferences-service.js";
import { tripSearchPreferencesRequestSchema, tripSearchPreferencesResponseSchema, tripStaySearchPreferencesRequestSchema, tripStaySearchPreferencesResponseSchema } from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";

export async function searchPreferenceRoutes(app: FastifyInstance) {
  const requireMembership = async (tripId: string, userId: string) => {
    const [membership] = await db.select({ userId: tripMembers.userId }).from(tripMembers)
      .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, userId))).limit(1);
    if (!membership) throw new ApiError(403, "Forbidden", "Not a member of this trip");
  };
  app.post("/trips/:tripId/search-preferences", async (request, reply) => {
    const { tripId } = request.params as { tripId: string };
    const input = tripSearchPreferencesRequestSchema.parse(request.body);
    const [membership] = await db.select({ userId: tripMembers.userId }).from(tripMembers)
      .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, request.user.id))).limit(1);
    if (!membership) throw new ApiError(403, "Forbidden", "Not a member of this trip");
    const created = await saveConfirmedSearchPreferences({
      ctx: createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId),
      tripId,
      confirmedBy: request.user.id,
      input,
    });
    return reply.code(201).send(tripSearchPreferencesResponseSchema.parse({
      ...created,
      createdAt: created.createdAt.toISOString(),
    }));
  });

  app.get("/trips/:tripId/stay-search-preferences", async (request, reply) => {
    const { tripId } = request.params as { tripId: string };
    await requireMembership(tripId, request.user.id);
    const latest = await loadLatestStaySearchPreferences(tripId);
    if (!latest) throw new ApiError(404, "Not Found", "Stay search preferences not found");
    return reply.send(tripStaySearchPreferencesResponseSchema.parse({ ...latest, createdAt: latest.createdAt.toISOString() }));
  });

  app.put("/trips/:tripId/stay-search-preferences", async (request, reply) => {
    const { tripId } = request.params as { tripId: string };
    await requireMembership(tripId, request.user.id);
    const input = tripStaySearchPreferencesRequestSchema.parse(request.body);
    const created = await saveConfirmedStaySearchPreferences({
      ctx: createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId),
      tripId,
      confirmedBy: request.user.id,
      input,
    });
    return reply.code(201).send(tripStaySearchPreferencesResponseSchema.parse({ ...created, createdAt: created.createdAt.toISOString() }));
  });
}
