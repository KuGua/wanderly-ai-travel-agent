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
import { and, desc, eq, or, sql } from "drizzle-orm";

import { db } from "../db/database.js";
import { freeTextMemories } from "../db/schema.js";
import { metrics } from "../observability/metrics.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";

/** A highlight longer than this is refused, not truncated. */
export const FREE_TEXT_MEMORY_MAX_CHARS = 500;

/** How many a traveller may keep. Reached, the next one is refused. */
export const FREE_TEXT_MEMORY_MAX_ENTRIES = 20;

export const personalNoteCategoryValues = ["GENERAL", "FOOD", "STAY", "PACE", "TRANSPORT", "BUDGET", "ACTIVITY"] as const;
export type PersonalNoteCategory = typeof personalNoteCategoryValues[number];
export type PersonalNoteScope = "ALL_TRIPS" | "CURRENT_TRIP";
export type PersonalNotePriority = "PINNED" | "NORMAL";
export type PersonalNoteStatus = "ACTIVE" | "ARCHIVED";

export type FreeTextMemory = {
  id: string;
  title: string;
  content: string;
  category: PersonalNoteCategory;
  appliesTo: PersonalNoteScope;
  tripId: string | null;
  priority: PersonalNotePriority;
  status: PersonalNoteStatus;
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
    title: row.title,
    content: row.content,
    category: row.category as PersonalNoteCategory,
    appliesTo: row.appliesTo as PersonalNoteScope,
    tripId: row.tripId,
    priority: row.priority as PersonalNotePriority,
    status: row.status as PersonalNoteStatus,
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

/** Owner-only, deterministic context selection. Notes never leave this service for Team planning. */
export async function listPersonalNotesForConversation(userId: string, tripId?: string | null): Promise<FreeTextMemory[]> {
  const scope = tripId
    ? or(eq(freeTextMemories.appliesTo, "ALL_TRIPS"), and(eq(freeTextMemories.appliesTo, "CURRENT_TRIP"), eq(freeTextMemories.tripId, tripId)))
    : eq(freeTextMemories.appliesTo, "ALL_TRIPS");
  const rows = await db.select().from(freeTextMemories).where(and(
    eq(freeTextMemories.userId, userId),
    eq(freeTextMemories.status, "ACTIVE"),
    scope,
  )).orderBy(desc(freeTextMemories.priority), desc(freeTextMemories.updatedAt));
  return rows.map(toMemory);
}

export async function saveFreeTextMemory(params: {
  ctx: RequestContext;
  userId: string;
  title?: string;
  content: string;
  category?: PersonalNoteCategory;
  appliesTo?: PersonalNoteScope;
  tripId?: string | null;
  priority?: PersonalNotePriority;
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

    const appliesTo = params.appliesTo ?? "ALL_TRIPS";
    if ((appliesTo === "CURRENT_TRIP") !== Boolean(params.tripId)) {
      return { outcome: "EMPTY" } as const;
    }
    const [row] = await tx.insert(freeTextMemories).values({
      userId: params.userId,
      title: (params.title?.trim() || "Personal note").slice(0, 80),
      content,
      category: params.category ?? "GENERAL",
      appliesTo,
      tripId: params.tripId ?? null,
      priority: params.priority ?? "NORMAL",
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

/** Owner-scoped archive; archived notes remain visible to their owner but never enter a prompt. */
export async function archiveFreeTextMemory(params: {
  ctx: RequestContext;
  userId: string;
  memoryId: string;
}): Promise<boolean> {
  const updated = await db.update(freeTextMemories).set({
    status: "ARCHIVED",
    updatedAt: new Date(),
  }).where(and(
    eq(freeTextMemories.id, params.memoryId),
    eq(freeTextMemories.userId, params.userId),
  )).returning({ id: freeTextMemories.id });
  if (updated.length === 0) return false;
  metrics.inc("free_text_memory_writes_total", { result: "archived" });
  return true;
}
