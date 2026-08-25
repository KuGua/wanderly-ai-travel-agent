import { eq, desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { db } from "../db/database.js";
import { chatThreads, chatMessages } from "../db/schema.js";
import { recordAudit } from "../services/audit-service.js";
import { ApiError } from "../middleware/error-handler.js";
import { createRequestContext } from "../utils/context.js";
import {
  appendMessageSchema,
  createThreadSchema,
  threadDetailsResponseSchema,
  threadMessagesResponseSchema,
  threadsListResponseSchema,
  type ChatMessageRedacted,
  type ThreadSummary,
} from "../types/schemas.js";

/**
 * Owner-only chat thread REST routes. Every operation is scoped to
 * `request.user.id`; trip binding does NOT grant trip-mate access.
 *
 * - 404 when the thread does not exist
 * - 403 when the caller is not the owner (never 404 in place of 403, to
 *   avoid enumeration)
 * - mutations are wrapped in `db.transaction(...)`; the audit row commits
 *   atomically with the business change via `recordAudit({ tx })`
 */
export async function chatThreadRoutes(app: FastifyInstance) {
  // List my threads
  app.get("/threads", async (request) => {
    const ownerId = request.user.id;
    const rows = await db.select()
      .from(chatThreads)
      .where(eq(chatThreads.ownerUserId, ownerId))
      .orderBy(desc(chatThreads.createdAt));

    return threadsListResponseSchema.parse({
      threads: rows.map(toThreadSummary),
    });
  });

  // Create a new thread
  app.post("/threads", async (request, reply) => {
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId,
    );
    const body = createThreadSchema.parse(request.body);

    const created = await db.transaction(async (tx) => {
      const [thread] = await tx.insert(chatThreads).values({
        ownerUserId: request.user.id,
        tripId: body.tripId ?? null,
        title: body.title,
      }).returning();

      await recordAudit({
        ctx,
        action: "CHAT_THREAD_CREATE",
        actorUserId: request.user.id,
        tripId: body.tripId ?? undefined,
        summary: { threadId: thread.id, hasTripBinding: Boolean(body.tripId) },
        tx,
      });

      return thread;
    });

    reply.code(201).send({ id: created.id, message: "Thread created" });
  });

  // Get one thread with its redacted messages
  app.get("/threads/:threadId", async (request) => {
    const { threadId } = request.params as { threadId: string };
    const thread = await ownerGuard(threadId, request.user.id);

    const messages = await fetchRedactedMessages(threadId);

    return threadDetailsResponseSchema.parse({
      thread: toThreadSummary(thread),
      messages,
    });
  });

  // Delete thread (cascade messages via FK)
  app.delete("/threads/:threadId", async (request) => {
    const { threadId } = request.params as { threadId: string };
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId,
    );

    await db.transaction(async (tx) => {
      const thread = await ownerGuardTx(tx, threadId, request.user.id);

      await tx.delete(chatMessages).where(eq(chatMessages.threadId, threadId));
      await tx.delete(chatThreads).where(eq(chatThreads.id, threadId));

      await recordAudit({
        ctx,
        action: "CHAT_THREAD_DELETE",
        actorUserId: request.user.id,
        tripId: thread.tripId ?? undefined,
        summary: { threadId },
        tx,
      });
    });

    return { message: "Thread deleted" };
  });

  // Append a message (raw body stored; never returned)
  app.post("/threads/:threadId/messages", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId,
    );
    const body = appendMessageSchema.parse(request.body);

    const created = await db.transaction(async (tx) => {
      const thread = await ownerGuardTx(tx, threadId, request.user.id);

      const [msg] = await tx.insert(chatMessages).values({
        threadId,
        senderUserId: request.user.id,
        role: body.role,
        body: body.body,
        markedSharedByOwner: body.markedSharedByOwner ?? false,
        redactedSummary: null,
      }).returning();

      await recordAudit({
        ctx,
        action: "CHAT_MESSAGE_APPEND",
        actorUserId: request.user.id,
        tripId: thread.tripId ?? undefined,
        summary: {
          threadId,
          messageId: msg.id,
          role: body.role,
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
    await ownerGuard(threadId, request.user.id);

    const query = (request.query ?? {}) as { limit?: string };
    const limit = clampLimit(query.limit);

    const messages = await fetchRedactedMessages(threadId, limit);

    return threadMessagesResponseSchema.parse({ messages });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type ChatThreadRow = typeof chatThreads.$inferSelect;

function toThreadSummary(row: ChatThreadRow): ThreadSummary {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    tripId: row.tripId ?? null,
    title: row.title,
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

async function ownerGuard(threadId: string, userId: string): Promise<ChatThreadRow> {
  const [thread] = await db.select().from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!thread) throw new ApiError(404, "Not Found", "Thread not found");
  if (thread.ownerUserId !== userId) {
    throw new ApiError(403, "Forbidden", "Not the owner of this thread");
  }
  return thread;
}

async function ownerGuardTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  threadId: string,
  userId: string,
): Promise<ChatThreadRow> {
  const [thread] = await tx.select().from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!thread) throw new ApiError(404, "Not Found", "Thread not found");
  if (thread.ownerUserId !== userId) {
    throw new ApiError(403, "Forbidden", "Not the owner of this thread");
  }
  return thread;
}

async function fetchRedactedMessages(
  threadId: string,
  limit: number = 20,
): Promise<ChatMessageRedacted[]> {
  const rows = await db.select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);

  // Reverse to chronological order (oldest first) for the caller.
  return rows.reverse().map(toRedactedMessage);
}

function clampLimit(raw: string | undefined): number {
  if (!raw) return 20;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(n, 100);
}
