import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/database.js";
import { chatThreads, tripMembers } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OwnedTripThreadRow = typeof chatThreads.$inferSelect;

/**
 * Locks the given thread row and verifies:
 *   1. The thread exists;
 *   2. The caller is the thread's `owner_user_id`;
 *   3. The caller is still an active member of the thread's trip.
 *
 * Replaces the five copies of owner-only checks that previously lived
 * in chat-threads.ts, chat-conversation-service.ts, task-repository.ts,
 * thread-recall-skill.ts, and (transitively) the conversation handler.
 *
 * Trip membership is NOT optional: per `docs/trip-scoped-private-threads-
 * implementation.md` §5.1, an owner who has been removed from the Trip
 * must lose access to all active threads owned by them in that Trip.
 *
 * Returns the locked row so callers can trust `tripId` and persist it
 * onto related rows (e.g. `agent_task_runs`).
 */
export async function requireOwnedTripThread(
  tx: Tx,
  threadId: string,
  ownerUserId: string,
): Promise<OwnedTripThreadRow> {
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new ApiError(400, "Bad Request", "threadId is required");
  }
  if (typeof ownerUserId !== "string" || ownerUserId.length === 0) {
    throw new ApiError(400, "Bad Request", "ownerUserId is required");
  }

  const rows = await tx.select()
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1)
    .for("update");
  const thread = rows[0];
  if (!thread) {
    throw new ApiError(404, "Not Found", "Thread not found");
  }

  if (thread.ownerUserId !== ownerUserId) {
    // Never 404 in place of 403 to avoid enumeration; the message does
    // not include owner or membership state.
    throw new ApiError(403, "Forbidden", "Not the owner of this thread");
  }

  const membership = await tx.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(eq(tripMembers.tripId, thread.tripId), eq(tripMembers.userId, ownerUserId)))
    .limit(1);
  if (membership.length === 0) {
    throw new ApiError(403, "Forbidden", "Not an active member of this thread's trip");
  }

  return thread;
}

/**
 * Lightweight non-locking check used by routes that only need to read
 * thread metadata (e.g. GET /threads/:threadId/conversation).
 *
 * For mutation paths and task acceptance, prefer requireOwnedTripThread.
 */
export async function requireOwnedTripThreadRead(
  threadId: string,
  ownerUserId: string,
): Promise<OwnedTripThreadRow> {
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new ApiError(400, "Bad Request", "threadId is required");
  }

  const rows = await db.select()
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  const thread = rows[0];
  if (!thread) {
    throw new ApiError(404, "Not Found", "Thread not found");
  }
  if (thread.ownerUserId !== ownerUserId) {
    throw new ApiError(403, "Forbidden", "Not the owner of this thread");
  }

  const membership = await db.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(eq(tripMembers.tripId, thread.tripId), eq(tripMembers.userId, ownerUserId)))
    .limit(1);
  if (membership.length === 0) {
    throw new ApiError(403, "Forbidden", "Not an active member of this thread's trip");
  }

  return thread;
}

/**
 * Used by the worker after picking up an agent task: the row was
 * already locked at acceptance time, but membership may have changed
 * between acceptance and execution.  Returns true if the owner is
 * still an active member of the thread's trip.
 */
export async function isThreadOwnerActiveMember(
  threadId: string,
  ownerUserId: string,
): Promise<{ active: boolean; tripId: string }> {
  const rows = await db.select({ tripId: chatThreads.tripId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  const thread = rows[0];
  if (!thread) return { active: false, tripId: "" };

  const membership = await db.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(eq(tripMembers.tripId, thread.tripId), eq(tripMembers.userId, ownerUserId)))
    .limit(1);
  return { active: membership.length > 0, tripId: thread.tripId };
}

// Suppress unused-import warning when only one helper is referenced.
// `sql` is kept available for future partial-index checks.
void sql;
