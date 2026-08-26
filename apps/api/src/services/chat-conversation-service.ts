import { desc, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { chatMessages, chatThreads } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { ownerConversationResponseSchema } from "../types/schemas.js";

type ChatThreadRow = typeof chatThreads.$inferSelect;

export async function getOwnerConversation(params: {
  threadId: string;
  ownerUserId: string;
  limit?: number;
}) {
  const thread = await requireThreadOwner(params.threadId, params.ownerUserId);
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 100);
  const rows = await db.select().from(chatMessages)
    .where(eq(chatMessages.threadId, params.threadId))
    .orderBy(desc(chatMessages.messageSequence))
    .limit(limit);

  return ownerConversationResponseSchema.parse({
    thread: toThreadSummary(thread),
    messages: rows.reverse().map((row) => ({
      id: row.id,
      role: row.role,
      content: row.body,
      sequence: row.messageSequence,
      createdAt: row.createdAt.toISOString(),
    })),
  });
}

async function requireThreadOwner(threadId: string, ownerUserId: string): Promise<ChatThreadRow> {
  const [thread] = await db.select().from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!thread) throw new ApiError(404, "Not Found", "Thread not found");
  if (thread.ownerUserId !== ownerUserId) {
    throw new ApiError(403, "Forbidden", "Not the owner of this thread");
  }
  return thread;
}

function toThreadSummary(row: ChatThreadRow) {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    tripId: row.tripId ?? null,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}
