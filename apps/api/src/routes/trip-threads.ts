import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { db } from "../db/database.js";
import { chatThreads, tripMembers } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { recordAudit } from "../services/audit-service.js";
import { getOrCreateDefaultThread } from "../services/trip-invitation-service.js";
import { createRequestContext } from "../utils/context.js";
import {
  createTripThreadSchema,
  threadSummarySchema,
  threadsListResponseSchema,
  toJsonSchema,
  type ThreadSummary,
} from "../types/schemas.js";

async function requireTripMember(tripId: string, userId: string): Promise<void> {
  const rows = await db.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, userId)))
    .limit(1);
  if (rows.length === 0) {
    // Never 404 in place of 403: the caller might be probing the trip
    // space, and a hard 403 keeps the contract consistent.
    throw new ApiError(403, "Forbidden", "Not a member of this trip");
  }
}

function toThreadSummary(row: typeof chatThreads.$inferSelect): ThreadSummary {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    tripId: row.tripId,
    scope: row.scope,
    isDefault: row.isDefault,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

export async function tripThreadRoutes(app: FastifyInstance) {
  // List the caller's own active threads in this Trip.  Trip-mates'
  // threads are intentionally not visible: per
  // docs/trip-scoped-private-threads-implementation.md §1.1.4, threads
  // are owner-only even within the same Trip.
  app.get("/trips/:tripId/threads", async (request) => {
    const { tripId } = request.params as { tripId: string };
    await requireTripMember(tripId, request.user.id);

    const rows = await db.select()
      .from(chatThreads)
      .where(and(
        eq(chatThreads.tripId, tripId),
        eq(chatThreads.ownerUserId, request.user.id),
        sql`${chatThreads.archivedAt} IS NULL`,
      ))
      .orderBy(desc(chatThreads.isDefault), desc(chatThreads.createdAt), asc(chatThreads.id));

    return threadsListResponseSchema.parse({
      threads: rows.map(toThreadSummary),
    });
  });

  // Create an additional non-default private thread for the caller.
  app.post("/trips/:tripId/threads", async (request, reply) => {
    const { tripId } = request.params as { tripId: string };
    await requireTripMember(tripId, request.user.id);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const body = createTripThreadSchema.parse(request.body);

    const [thread] = await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(chatThreads).values({
        ownerUserId: request.user.id,
        tripId,
        scope: "TRIP",
        isDefault: false,
        title: body.title,
      }).returning();

      await recordAudit({
        ctx,
        action: "CHAT_THREAD_CREATE",
        actorUserId: request.user.id,
        tripId,
        summary: {
          threadId: inserted.id,
          isDefault: false,
        },
        tx,
      });
      return [inserted];
    });

    return reply.code(201).send(threadSummarySchema.parse(toThreadSummary(thread)));
  });

  // Idempotent get-or-create the caller's default scratchpad.  After
  // invitation acceptance this row already exists; the route keeps
  // the recovery semantics so that a missing default row (e.g. legacy
  // pre-onboarding data, network retry) does not strand the UI.
  app.post("/trips/:tripId/threads/default", async (request, reply) => {
    const { tripId } = request.params as { tripId: string };
    await requireTripMember(tripId, request.user.id);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );

    const result = await db.transaction(async (tx) => {
      const threadId = await getOrCreateDefaultThread(tx, {
        tripId,
        ownerUserId: request.user.id,
      });
      const [row] = await tx.select()
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1);
      if (!row) {
        throw new ApiError(500, "Internal Server Error", "Default thread missing after provision");
      }
      await recordAudit({
        ctx,
        action: "TRIP_DEFAULT_THREAD_PROVISION",
        actorUserId: request.user.id,
        tripId,
        summary: { threadId, idempotent: true },
        tx,
      });
      return row;
    });

    return reply.code(200).send(threadSummarySchema.parse(toThreadSummary(result)));
  });
}

// Re-export to silence unused import warnings when schemas are later
// inlined or refactored.  (Currently `toJsonSchema` is exported but
// unused at this layer.)
export { toJsonSchema };
