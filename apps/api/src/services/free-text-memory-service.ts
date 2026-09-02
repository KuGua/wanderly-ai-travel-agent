/**
 * Free-text memories: what a traveller highlighted that the catalogue could
 * not express.
 *
 * Long-term memory is otherwise a closed set of typed fields, which is what
 * makes it safe to hand a model and safe to export under consent. That
 * closure is right, and it also means someone can highlight a true, useful
 * sentence — "我在京都只想住町屋" — and be told it cannot be kept. These rows
 * are the narrow exception: owner-only, never exported, never a plan input.
 *
 * Both bounds are reported rather than applied silently. A traveller who
 * highlights 600 characters is told it is too long, not handed a sentence cut
 * in half; one who has filled the list is told which to remove, not left
 * wondering why the newest one vanished.
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../db/database.js";
import { freeTextMemories } from "../db/schema.js";
import { metrics } from "../observability/metrics.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";

/** A highlight longer than this is refused, not truncated. */
export const FREE_TEXT_MEMORY_MAX_CHARS = 500;

/** How many a traveller may keep. Reached, the next one is refused. */
export const FREE_TEXT_MEMORY_MAX_ENTRIES = 20;

export type FreeTextMemory = {
  id: string;
  content: string;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  createdAt: Date;
};

export type SaveFreeTextOutcome =
  | { outcome: "SAVED"; memory: FreeTextMemory; remaining: number }
  | { outcome: "TOO_LONG"; length: number; limit: number }
  | { outcome: "LIST_FULL"; limit: number }
  | { outcome: "EMPTY" };

function toMemory(row: typeof freeTextMemories.$inferSelect): FreeTextMemory {
  return {
    id: row.id,
    content: row.content,
    sourceThreadId: row.sourceThreadId,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt,
  };
}

export async function listFreeTextMemories(userId: string): Promise<FreeTextMemory[]> {
  const rows = await db.select().from(freeTextMemories)
    .where(eq(freeTextMemories.userId, userId))
    .orderBy(desc(freeTextMemories.createdAt));
  return rows.map(toMemory);
}

export async function saveFreeTextMemory(params: {
  ctx: RequestContext;
  userId: string;
  content: string;
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
}): Promise<SaveFreeTextOutcome> {
  const content = params.content.trim();
  if (content.length === 0) return { outcome: "EMPTY" };
  if (content.length > FREE_TEXT_MEMORY_MAX_CHARS) {
    metrics.inc("free_text_memory_writes_total", { result: "too_long" });
    return { outcome: "TOO_LONG", length: content.length, limit: FREE_TEXT_MEMORY_MAX_CHARS };
  }

  return db.transaction(async (tx) => {
    // Counted inside the transaction so two highlights racing cannot both
    // see nineteen rows and both write.
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(freeTextMemories)
      .where(eq(freeTextMemories.userId, params.userId));
    if (count >= FREE_TEXT_MEMORY_MAX_ENTRIES) {
      metrics.inc("free_text_memory_writes_total", { result: "list_full" });
      return { outcome: "LIST_FULL", limit: FREE_TEXT_MEMORY_MAX_ENTRIES };
    }

    const [row] = await tx.insert(freeTextMemories).values({
      userId: params.userId,
      content,
      sourceThreadId: params.sourceThreadId ?? null,
      sourceMessageId: params.sourceMessageId ?? null,
    }).returning();

    await recordAudit({
      ctx: params.ctx,
      action: "FREE_TEXT_MEMORY_CREATE",
      actorUserId: params.userId,
      // The highlighted text is the traveller's own words; length only.
      summary: { memoryId: row.id, contentLength: content.length },
      tx,
    });

    metrics.inc("free_text_memory_writes_total", { result: "saved" });
    return {
      outcome: "SAVED",
      memory: toMemory(row),
      remaining: FREE_TEXT_MEMORY_MAX_ENTRIES - (count + 1),
    };
  });
}

/** Owner-scoped. Returns false when the row is absent or someone else's. */
export async function deleteFreeTextMemory(params: {
  ctx: RequestContext;
  userId: string;
  memoryId: string;
}): Promise<boolean> {
  const deleted = await db.delete(freeTextMemories)
    .where(and(
      eq(freeTextMemories.id, params.memoryId),
      eq(freeTextMemories.userId, params.userId),
    ))
    .returning({ id: freeTextMemories.id });
  if (deleted.length === 0) return false;
  await recordAudit({
    ctx: params.ctx,
    action: "FREE_TEXT_MEMORY_DELETE",
    actorUserId: params.userId,
    summary: { memoryId: params.memoryId },
  });
  return true;
}
