import { desc, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { chatMessages, chatThreads } from "../db/schema.js";
import { ownerConversationResponseSchema } from "../types/schemas.js";
import { requireOwnedTripThreadRead } from "./chat-thread-service.js";

type ChatThreadRow = typeof chatThreads.$inferSelect;

export async function getOwnerConversation(params: {
  threadId: string;
  ownerUserId: string;
  limit?: number;
}) {
  const thread = await requireOwnedTripThreadRead(params.threadId, params.ownerUserId);
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

function toThreadSummary(row: ChatThreadRow) {
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
