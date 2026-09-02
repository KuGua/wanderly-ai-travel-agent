import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import { auditEvents, freeTextMemories, userProfiles, users } from "../src/db/schema.js";
import {
  FREE_TEXT_MEMORY_MAX_CHARS,
  FREE_TEXT_MEMORY_MAX_ENTRIES,
  deleteFreeTextMemory,
  listFreeTextMemories,
  saveFreeTextMemory,
} from "../src/services/free-text-memory-service.js";
import {
  CONVERSATION_FREE_TEXT_BUDGET_CHARS,
  buildConversationMemoryContext,
} from "../src/services/conversation-memory-context.js";

const ctx = { correlationId: "00000000-0000-4000-8000-0000000000ab", actorUserId: undefined } as never;
let ownerId: string;
let otherId: string;

async function ensureUser(externalId: string): Promise<string> {
  const [created] = await db.insert(users).values({ externalId, displayName: externalId })
    .onConflictDoNothing({ target: users.externalId }).returning();
  if (created) {
    await db.insert(userProfiles).values({ userId: created.id, displayName: externalId })
      .onConflictDoNothing({ target: userProfiles.userId });
    return created.id;
  }
  const [existing] = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
  return existing!.id;
}

async function cleanup() {
  const ids = [ownerId, otherId].filter(Boolean);
  if (ids.length === 0) return;
  await db.delete(freeTextMemories).where(inArray(freeTextMemories.userId, ids));
  await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, ids));
}

beforeAll(async () => {
  ownerId = await ensureUser("free-text-owner");
  otherId = await ensureUser("free-text-other");
});
afterAll(cleanup);
beforeEach(cleanup);

describe("what a traveller may keep in their own words", () => {
  it("keeps the sentence, and says how many are left", async () => {
    const saved = await saveFreeTextMemory({ ctx, userId: ownerId, content: "我在京都只想住町屋" });
    expect(saved.outcome).toBe("SAVED");
    if (saved.outcome === "SAVED") expect(saved.remaining).toBe(FREE_TEXT_MEMORY_MAX_ENTRIES - 1);
    expect((await listFreeTextMemories(ownerId))[0].content).toBe("我在京都只想住町屋");
  });

  it("refuses a highlight past the length limit rather than cutting it in half", async () => {
    const tooLong = "字".repeat(FREE_TEXT_MEMORY_MAX_CHARS + 1);
    const saved = await saveFreeTextMemory({ ctx, userId: ownerId, content: tooLong });

    expect(saved).toEqual({ outcome: "TOO_LONG", length: FREE_TEXT_MEMORY_MAX_CHARS + 1, limit: FREE_TEXT_MEMORY_MAX_CHARS });
    expect(await listFreeTextMemories(ownerId)).toHaveLength(0);
  });

  it("refuses the twenty-first rather than dropping the oldest", async () => {
    // Silently evicting would lose something the traveller chose to keep,
    // with nothing on screen to say so.
    for (let index = 0; index < FREE_TEXT_MEMORY_MAX_ENTRIES; index += 1) {
      await saveFreeTextMemory({ ctx, userId: ownerId, content: `note ${index}` });
    }
    const overflow = await saveFreeTextMemory({ ctx, userId: ownerId, content: "one too many" });

    expect(overflow).toEqual({ outcome: "LIST_FULL", limit: FREE_TEXT_MEMORY_MAX_ENTRIES });
    expect(await listFreeTextMemories(ownerId)).toHaveLength(FREE_TEXT_MEMORY_MAX_ENTRIES);
    expect((await listFreeTextMemories(ownerId)).some((note) => note.content === "note 0")).toBe(true);
  });

  it("deletes only the owner's own note", async () => {
    const mine = await saveFreeTextMemory({ ctx, userId: ownerId, content: "mine" });
    const theirs = await saveFreeTextMemory({ ctx, userId: otherId, content: "theirs" });
    if (mine.outcome !== "SAVED" || theirs.outcome !== "SAVED") throw new Error("setup");

    expect(await deleteFreeTextMemory({ ctx, userId: ownerId, memoryId: theirs.memory.id })).toBe(false);
    expect(await deleteFreeTextMemory({ ctx, userId: ownerId, memoryId: mine.memory.id })).toBe(true);
    expect(await listFreeTextMemories(otherId)).toHaveLength(1);
  });

  it("stops adding notes to the prompt once the budget is spent", async () => {
    // Twenty 500-character notes is 10,000 characters on every turn, which
    // the typed fields never cost. Whole notes are left behind rather than
    // cut: half a remembered preference is worse than none.
    for (let index = 0; index < 8; index += 1) {
      await saveFreeTextMemory({ ctx, userId: ownerId, content: `${index}`.repeat(FREE_TEXT_MEMORY_MAX_CHARS) });
    }
    const facts = await buildConversationMemoryContext(ownerId);
    const notes = facts.filter((fact) => fact.source === "HIGHLIGHT");
    const spent = notes.reduce((total, note) => total + String(note.value).length, 0);

    expect(notes.length).toBeLessThan(8);
    expect(spent).toBeLessThanOrEqual(CONVERSATION_FREE_TEXT_BUDGET_CHARS);
    expect(notes.every((note) => String(note.value).length === FREE_TEXT_MEMORY_MAX_CHARS)).toBe(true);
  });
});
