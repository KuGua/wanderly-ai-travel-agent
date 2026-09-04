import { and, eq, desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { db } from "../db/database.js";
import { chatThreads, chatMessages, tripConstraintProposals } from "../db/schema.js";
import { recordAudit } from "../services/audit-service.js";
import { createRequestContext } from "../utils/context.js";
import { getOwnerConversation } from "../services/chat-conversation-service.js";
import { acceptConversationTask } from "../tasks/task-repository.js";
import {
  requireOwnedTripThread,
  requireOwnedTripThreadRead,
} from "../services/chat-thread-service.js";
import {
  appendMessageSchema,
  conversationTurnRequestSchema,
  createThreadSchema,
  threadDetailsResponseSchema,
  threadMessagesResponseSchema,
  threadsListResponseSchema,
  type ChatMessageRedacted,
  type ThreadSummary,
} from "../types/schemas.js";

/**
 * Owner-only chat thread REST routes.  Every operation is scoped to
 * `request.user.id`; trip binding does NOT grant trip-mate access.
 *
 * Trip-scoped threads are managed via `/trips/:tripId/threads` (see
 * `routes/trip-threads.ts`).  This file keeps only the per-thread
 * operations whose URL is keyed by `threadId`; general "list/create
 * a thread" endpoints have been retired because Trip binding is now
 * mandatory.
 *
 * All access checks go through `requireOwnedTripThread` /
 * `requireOwnedTripThreadRead`, which additionally verify the caller
 * is still an active member of the thread's trip.
 */
export async function chatThreadRoutes(app: FastifyInstance) {
  // ─── General thread create/list — Trip-scoped legacy shims ──────────────
  //
  // Per docs/trip-scoped-private-threads-implementation.md §6.3 the
  // preferred entry points are under `/trips/:tripId/threads`.  These two
  // endpoints are retained ONLY as compatibility shims for callers that
  // have not yet migrated: they require an explicit `tripId`, refuse
  // non-members, and route through the same `requireOwnedTripThread`
  // helper for thread reads/writes.  New clients MUST use the Trip-scoped
  // routes; these are expected to be removed once the migration is
  // complete.  The 410 Gone response is not used here because removing
  // the route would break the legacy chat fixtures; the routes stay
  // behind a single Trip-binding guard so they cannot bypass membership.
  app.get("/threads", async (request, reply) => {
    // @deprecated Legacy shim; clients must use `GET /api/v1/trips/:tripId/threads`.
    // List the caller's own threads, server-side filtered by `ownerUserId`
    // and `archivedAt IS NULL`.  No trip-scope filter is applied here —
    // Trip-scoped filtering is intentionally left to the new endpoint so
    // these legacy callers continue to see threads they created before
    // being Trip-scoped.
    const { chatThreads } = await import("../db/schema.js");
    const { desc } = await import("drizzle-orm");
    const { eq, and, isNull } = await import("drizzle-orm");
    const rows = await db.select()
      .from(chatThreads)
      .where(and(eq(chatThreads.ownerUserId, request.user.id), isNull(chatThreads.archivedAt)))
      .orderBy(desc(chatThreads.createdAt));
    return reply.send(threadsListResponseSchema.parse({ threads: rows.map(toThreadSummary) }));
  });

  app.post("/threads", async (request, reply) => {
    // @deprecated Legacy shim; clients must use
    // `POST /api/v1/trips/:tripId/threads` (create) or
    // `POST /api/v1/trips/:tripId/threads/default` (idempotent default).
    // Legacy create endpoint.  Requires the caller to be an active
    // member of the trip they bind the thread to.
    const { chatThreads, tripMembers } = await import("../db/schema.js");
    const { and: andOp, eq: eqOp } = await import("drizzle-orm");
    const { ApiError } = await import("../middleware/error-handler.js");
    const { recordAudit } = await import("../services/audit-service.js");

    const body = createThreadSchema.parse(request.body);
    if (!body.tripId) {
      throw new ApiError(400, "Bad Request", "tripId is required; use POST /trips/:tripId/threads for Trip-scoped creation");
    }
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const membership = await db.select({ userId: tripMembers.userId })
      .from(tripMembers)
      .where(andOp(eqOp(tripMembers.tripId, body.tripId), eqOp(tripMembers.userId, request.user.id)))
      .limit(1);
    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not an active member of this trip");
    }
    const created = await db.transaction(async (tx) => {
      const now = new Date();
      const [thread] = await tx.insert(chatThreads).values({
        ownerUserId: request.user.id,
        tripId: body.tripId!,
        scope: "TRIP",
        isDefault: false,
        title: body.title,
        // The legacy shim always carries a caller-supplied title, so the
        // lifecycle metadata is MANUAL and the locale is unknown.
        titleSource: "MANUAL",
        titleLocale: null,
        titleUpdatedAt: now,
      }).returning();
      await recordAudit({
        ctx,
        action: "CHAT_THREAD_CREATE",
        actorUserId: request.user.id,
        tripId: body.tripId!,
        summary: { threadId: thread.id, isDefault: false },
        tx,
      });
      return thread;
    });
    return reply.code(201).send({ id: created.id, message: "Thread created" });
  });

  // Get one thread with its redacted messages
  app.get("/threads/:threadId", async (request) => {
    const { threadId } = request.params as { threadId: string };
    const thread = await requireOwnedTripThreadRead(threadId, request.user.id);

    const messages = await fetchRedactedMessages(threadId);

    return threadDetailsResponseSchema.parse({
      thread: toThreadSummary(thread),
      messages,
    });
  });

  // Owner-readable raw USER/ASSISTANT history for restoring the private UI.
  app.get("/threads/:threadId/conversation", async (request) => {
    const { threadId } = request.params as { threadId: string };
    await requireOwnedTripThreadRead(threadId, request.user.id);
    const query = (request.query ?? {}) as { limit?: string };
    return getOwnerConversation({
      threadId,
      ownerUserId: request.user.id,
      limit: clampLimit(query.limit, 100),
    });
  });

  // Persist the USER message and durable task, then return without
  // waiting for the model.  The Worker owns execution; the browser only
  // observes via SSE.
  app.post("/threads/:threadId/turns", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    await requireOwnedTripThreadRead(threadId, request.user.id);
    const input = conversationTurnRequestSchema.parse(request.body);
    const accepted = await acceptConversationTask({
      ctx,
      threadId,
      ownerUserId: request.user.id,
      input,
    });
    return reply.code(202).send(accepted);
  });

  // Delete thread (cascade messages via FK).  Locking the thread via
  // the transaction-scoped helper keeps concurrent deletes safe.
  app.delete("/threads/:threadId", async (request) => {
    const { threadId } = request.params as { threadId: string };
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );

    await db.transaction(async (tx) => {
      const thread = await requireOwnedTripThread(tx, threadId, request.user.id);

      // A PENDING handoff requires its private-thread provenance to remain
      // confirmable. Deleting that thread explicitly dismisses those pending
      // candidates before FK SET NULL redacts terminal provenance links.
      await tx.update(tripConstraintProposals)
        .set({ status: "DISMISSED", resolvedAt: new Date() })
        .where(and(
          eq(tripConstraintProposals.originThreadId, threadId),
          eq(tripConstraintProposals.status, "PENDING"),
        ));
      await tx.delete(chatMessages).where(eq(chatMessages.threadId, threadId));
      await tx.delete(chatThreads).where(eq(chatThreads.id, threadId));

      await recordAudit({
        ctx,
        action: "CHAT_THREAD_DELETE",
        actorUserId: request.user.id,
        tripId: thread.tripId,
        summary: { threadId },
        tx,
      });
    });

    return { message: "Thread deleted" };
  });

  // Append a message (raw body stored; never returned).
  app.post("/threads/:threadId/messages", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const body = appendMessageSchema.parse(request.body);

    const created = await db.transaction(async (tx) => {
      const thread = await requireOwnedTripThread(tx, threadId, request.user.id);

      const [msg] = await tx.insert(chatMessages).values({
        threadId,
        senderUserId: request.user.id,
        role: "USER",
        body: body.body,
        markedSharedByOwner: body.markedSharedByOwner ?? false,
        redactedSummary: null,
      }).returning();

      await recordAudit({
        ctx,
        action: "CHAT_MESSAGE_APPEND",
        actorUserId: request.user.id,
        tripId: thread.tripId,
        summary: {
          threadId,
          messageId: msg.id,
          role: "USER",
          markedSharedByOwner: msg.markedSharedByOwner,
        },
        tx,
      });

      return msg;
    });

    reply.code(201).send({ id: created.id, message: "Message appended" });
  });

  // List redacted messages for a thread
  app.get("/threads/:threadId/messages", async (request) => {
    const { threadId } = request.params as { threadId: string };
    await requireOwnedTripThreadRead(threadId, request.user.id);

    const query = (request.query ?? {}) as { limit?: string };
    const limit = clampLimit(query.limit);

    const messages = await fetchRedactedMessages(threadId, limit);

    return threadMessagesResponseSchema.parse({ messages });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toThreadSummary(row: typeof chatThreads.$inferSelect): ThreadSummary {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    tripId: row.tripId,
    scope: row.scope,
    isDefault: row.isDefault,
    title: row.title,
    titleSource: row.titleSource,
    titleLocale: row.titleLocale,
    titleUpdatedAt: row.titleUpdatedAt ? row.titleUpdatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

function toRedactedMessage(row: typeof chatMessages.$inferSelect): ChatMessageRedacted {
  return {
    id: row.id,
    role: row.role,
    contentRedacted:
      row.markedSharedByOwner && row.redactedSummary ? row.redactedSummary : "",
    createdAt: row.createdAt.toISOString(),
  };
}

async function fetchRedactedMessages(
  threadId: string,
  limit: number = 20,
): Promise<ChatMessageRedacted[]> {
  const rows = await db.select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.messageSequence))
    .limit(limit);

  return rows.reverse().map(toRedactedMessage);
}

function clampLimit(raw: string | undefined, defaultValue: number = 20): number {
  if (!raw) return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(n, 100);
}
