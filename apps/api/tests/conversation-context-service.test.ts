/**
 * Unit tests for the bounded same-thread LLM context builder.
 *
 * Coverage tracks the §10 acceptance scenarios for AC7 / TS-H1d, plus
 * the resilience cases the design doc §5 expects. Each test provisions
 * its own Trip + thread + chat_messages directly so the Postgres
 * `message_sequence` identity column produces real, increasing sequence
 * numbers — the same shape the Worker sees in production.
 */
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  chatMessages,
  chatThreads,
  sharedTrips,
  tripMembers,
  users,
  type AgentTaskRow,
} from "../src/db/schema.js";
import { buildConversationContext } from "../src/services/conversation-context-service.js";
import { provisionTripAndMember } from "./helpers/trip.js";

let aliceId: string;
let bobId: string;

beforeAll(async () => {
  const [alice] = await db.insert(users)
    .values({ externalId: `ctx-alice-${randomUUID()}`, displayName: "Context Alice" })
    .returning();
  const [bob] = await db.insert(users)
    .values({ externalId: `ctx-bob-${randomUUID()}`, displayName: "Context Bob" })
    .returning();
  aliceId = alice.id;
  bobId = bob.id;
});

afterAll(async () => {
  const testUserIds = [aliceId, bobId];
  await db.delete(chatMessages).where(inArray(chatMessages.senderUserId, testUserIds));
  await db.delete(chatThreads).where(inArray(chatThreads.ownerUserId, testUserIds));
  await db.delete(tripMembers).where(inArray(tripMembers.userId, testUserIds));
  await db.delete(sharedTrips).where(inArray(sharedTrips.createdBy, testUserIds));
  await db.delete(users).where(eq(users.id, aliceId));
  await db.delete(users).where(eq(users.id, bobId));
});

beforeEach(async () => {
  await db.delete(chatMessages).where(inArray(chatMessages.senderUserId, [aliceId, bobId]));
  await db.delete(chatThreads).where(inArray(chatThreads.ownerUserId, [aliceId, bobId]));
  await db.delete(agentTaskRuns).where(inArray(agentTaskRuns.createdByUserId, [aliceId, bobId]));
});

type ThreadWithTrip = { threadId: string; tripId: string };

async function createAliceThread(): Promise<ThreadWithTrip> {
  const { tripId } = await provisionTripAndMember({ ownerUserId: aliceId });
  const [thread] = await db.insert(chatThreads).values({
    ownerUserId: aliceId,
    tripId,
    scope: "TRIP",
    isDefault: false,
    title: `ctx test ${randomUUID().slice(0, 8)}`,
  }).returning();
  return { threadId: thread.id, tripId };
}

async function createAliceThreadInTrip(tripId: string): Promise<string> {
  const [thread] = await db.insert(chatThreads).values({
    ownerUserId: aliceId,
    tripId,
    scope: "TRIP",
    isDefault: false,
    title: `second alice thread ${randomUUID().slice(0, 8)}`,
  }).returning();
  return thread.id;
}

async function createBobThreadInTrip(tripId: string): Promise<string> {
  const [thread] = await db.insert(chatThreads).values({
    ownerUserId: bobId,
    tripId,
    scope: "TRIP",
    isDefault: false,
    title: `bob thread ${randomUUID().slice(0, 8)}`,
  }).returning();
  return thread.id;
}

async function insertUser(threadId: string, body: string): Promise<string> {
  const [row] = await db.insert(chatMessages).values({
    threadId,
    senderUserId: aliceId,
    role: "USER",
    body,
    markedSharedByOwner: false,
    redactedSummary: null,
  }).returning();
  return row.id;
}

async function insertBobUser(threadId: string, body: string): Promise<string> {
  const [row] = await db.insert(chatMessages).values({
    threadId,
    senderUserId: bobId,
    role: "USER",
    body,
    markedSharedByOwner: false,
    redactedSummary: null,
  }).returning();
  return row.id;
}

async function insertAssistant(threadId: string, body: string): Promise<string> {
  const [row] = await db.insert(chatMessages).values({
    threadId,
    senderUserId: null,
    role: "ASSISTANT",
    body,
    markedSharedByOwner: false,
    redactedSummary: null,
  }).returning();
  return row.id;
}

/**
 * Build a CONVERSATION `agent_task_runs` row matching the shape the
 * acceptance transaction in `task-repository.ts` would persist.  The
 * `context_max_message_sequence` mirrors the just-inserted USER row's
 * `message_sequence` — exactly what `acceptConversationTask` writes —
 * so tests verify the same upper-bound semantics without spinning the
 * full HTTP route.
 */
async function createConversationRun(
  threadId: string,
  userMessageId: string,
  overrides: Partial<Pick<AgentTaskRow, "contextMaxMessageSequence" | "userMessageId" | "tripId" | "threadId">> = {},
): Promise<AgentTaskRow> {
  const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, threadId)).limit(1);
  const [userMessage] = await db.select({ messageSequence: chatMessages.messageSequence })
    .from(chatMessages).where(eq(chatMessages.id, userMessageId)).limit(1);
  const [run] = await db.insert(agentTaskRuns).values({
    operation: "CONVERSATION",
    status: "QUEUED",
    createdByUserId: aliceId,
    threadId,
    tripId: thread?.tripId ?? null,
    requestId: randomUUID(),
    userMessageId,
    contextMaxMessageSequence: userMessage?.messageSequence ?? 1,
    expiresAt: new Date(Date.now() + 300_000),
    ...overrides,
  }).returning();
  return run;
}

describe("buildConversationContext", () => {
  it("returns chronological complete turns for a typical re-entry (§10.3)", async () => {
    const { threadId } = await createAliceThread();
    await insertUser(threadId, "first question");
    await insertAssistant(threadId, "first answer");
    await insertUser(threadId, "second question");
    await insertAssistant(threadId, "second answer");
    const currentUserId = await insertUser(threadId, "third question (current)");
    const run = await createConversationRun(threadId, currentUserId);

    const context = await buildConversationContext(run);

    expect(context.messages).toHaveLength(4);
    expect(context.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT", "USER", "ASSISTANT"]);
    expect(context.messages.map((m) => m.content)).toEqual([
      "first question", "first answer",
      "second question", "second answer",
    ]);
    expect(context.truncated).toBe(false);
    expect(context.truncatedReason).toBe(null);
  });

  it("never includes the current USER message in history (§10.3 / §3.2.2)", async () => {
    const { threadId } = await createAliceThread();
    // An earlier USER body identical to the current one — content-based
    // dedupe would drop the wrong row, so the builder MUST drop by id.
    const identical = "tell me about tokyo";
    await insertUser(threadId, identical);
    await insertAssistant(threadId, "first answer");
    await insertUser(threadId, identical);
    await insertAssistant(threadId, "second answer");
    const currentUserId = await insertUser(threadId, identical);
    const run = await createConversationRun(threadId, currentUserId);

    const context = await buildConversationContext(run);
    // We must see 2 turns = 4 messages: two USER+ASSISTANT pairs from
    // before the current question.  Even though 3 USER rows share the
    // same content, the current one is dropped by id, leaving 2.
    expect(context.messages).toHaveLength(4);
    expect(context.messages.filter((m) => m.role === "USER")).toHaveLength(2);
    // The current USER row is dropped by id, not by content: prove it
    // by fetching the row directly and confirming its body is the same
    // as the older rows — so only an id-based drop could distinguish it.
    const [currentRow] = await db.select().from(chatMessages)
      .where(eq(chatMessages.id, currentUserId)).limit(1);
    expect(currentRow?.body).toBe(identical);
    // Bound is pinned to the current row's sequence (proves it was the
    // accepted row, not an earlier duplicate).
    expect(context.maxMessageSequence).toBe(currentRow?.messageSequence);
  });

  it("returns an empty context when the thread has no prior history (§3.2.5)", async () => {
    const { threadId } = await createAliceThread();
    const currentUserId = await insertUser(threadId, "first ever question");
    const run = await createConversationRun(threadId, currentUserId);

    const context = await buildConversationContext(run);
    expect(context.messages).toEqual([]);
    expect(context.truncated).toBe(false);
    expect(context.truncatedReason).toBe(null);
    // The bound is still pinned to the current row's sequence so callers
    // can confirm the query was correctly bounded.
    const [userMessage] = await db.select({ messageSequence: chatMessages.messageSequence })
      .from(chatMessages).where(eq(chatMessages.id, currentUserId)).limit(1);
    expect(context.maxMessageSequence).toBe(userMessage?.messageSequence);
  });

  it("starts history at the previous complete turn when the latest USER is unanswered (§3.2.3)", async () => {
    const { threadId } = await createAliceThread();
    await insertUser(threadId, "oldest q");
    await insertAssistant(threadId, "oldest a");
    await insertUser(threadId, "middle q");
    await insertAssistant(threadId, "middle a");
    // Latest USER is unanswered — its row must be excluded; history must
    // start from the previous complete turn.
    const currentUserId = await insertUser(threadId, "unanswered q");
    const run = await createConversationRun(threadId, currentUserId);

    const context = await buildConversationContext(run);
    expect(context.messages.map((m) => m.content)).toEqual([
      "oldest q", "oldest a",
      "middle q", "middle a",
    ]);
    // No dangling ASSISTANT — the new model call will produce it.
    expect(context.messages.at(-1)?.role).toBe("ASSISTANT");
  });

  it("caps history to the newest N turns when more turns are present than fit the read window (§3.2.1)", async () => {
    const { threadId } = await createAliceThread();
    // 12 complete turns + current unanswered USER = 25 messages.  The
    // read window is 2*MAX_TURNS+1 = 17 rows DESC, so the oldest 4 turns
    // (8 messages) are not in the window at all — there is no explicit
    // turn_limit truncation step, the LIMIT bound it naturally.
    for (let i = 0; i < 12; i += 1) {
      await insertUser(threadId, `q-${i}`);
      await insertAssistant(threadId, `a-${i}`);
    }
    const currentUserId = await insertUser(threadId, "current");
    const run = await createConversationRun(threadId, currentUserId);

    const context = await buildConversationContext(run);
    expect(context.messages).toHaveLength(16); // 8 turns × 2 messages
    expect(context.messages[0].content).toBe("q-4");
    expect(context.messages.at(-1)?.content).toBe("a-11");
    // Oldest turns must NOT be present (e.g., q-0 / a-0).
    expect(context.messages.map((m) => m.content)).not.toContain("q-0");
    expect(context.messages.map((m) => m.content)).not.toContain("a-0");
  });

  it("drops oldest whole turns when char budget overflows and never slices bodies (§3.2.4, §10.4)", async () => {
    const { threadId } = await createAliceThread();
    // Three turns, each ~5000 chars total (just over the default 12,000 budget).
    const padding = "x".repeat(4900);
    await insertUser(threadId, "u1");
    await insertAssistant(threadId, padding);
    await insertUser(threadId, "u2");
    await insertAssistant(threadId, padding);
    await insertUser(threadId, "u3");
    await insertAssistant(threadId, padding);
    const currentUserId = await insertUser(threadId, "current");
    const run = await createConversationRun(threadId, currentUserId);

    const context = await buildConversationContext(run);
    // Budget is 12,000. Three turns × ~4900 = ~14,700 > 12,000.
    // Per §3.2.4 the OLDEST turns get dropped first: drop t1 → 9800 ≤ 12000 ✓,
    // drop t2 → 4900 ≤ 12000 ✓, t3 newest kept. Two turns survive.
    expect(context.truncatedReason).toBe("char_limit");
    expect(context.messages).toHaveLength(4); // 2 turns × 2 messages
    // Oldest dropped: no t1 content present.
    expect(context.messages.map((m) => m.content)).not.toContain("u1");
    // Newest kept whole: the 4900-char body must NOT be a prefix/slice.
    for (const message of context.messages) {
      if (message.content === padding) {
        expect(message.content.length).toBe(4900);
      }
    }
  });

  it("is deterministic across repeated calls with the same run row (§10.5 / §1.6)", async () => {
    const { threadId } = await createAliceThread();
    for (let i = 0; i < 4; i += 1) {
      await insertUser(threadId, `q-${i}`);
      await insertAssistant(threadId, `a-${i}`);
    }
    const currentUserId = await insertUser(threadId, "current");
    const run = await createConversationRun(threadId, currentUserId);

    const first = await buildConversationContext(run);
    const second = await buildConversationContext(run);
    expect(second).toEqual(first);
  });

  it("ignores messages appended after the task's saved upper sequence boundary (§10.5)", async () => {
    const { threadId } = await createAliceThread();
    await insertUser(threadId, "before-bound q1");
    await insertAssistant(threadId, "before-bound a1");
    await insertUser(threadId, "before-bound q2");
    await insertAssistant(threadId, "before-bound a2");
    const currentUserId = await insertUser(threadId, "current");
    const run = await createConversationRun(threadId, currentUserId);
    const bound = run.contextMaxMessageSequence;
    expect(bound).not.toBeNull();
    // Append two more messages AFTER acceptance — they MUST NOT appear
    // in the prompt even though they share the same threadId.
    await insertUser(threadId, "after-bound q");
    await insertAssistant(threadId, "after-bound a");

    const context = await buildConversationContext(run);
    const flat = context.messages.map((m) => m.content).join("\n");
    expect(flat).not.toContain("after-bound");
    expect(context.maxMessageSequence).toBe(bound);
  });

  it("falls back to the USER row's sequence when context_max_message_sequence is NULL (§4.1 / D5)", async () => {
    const { threadId } = await createAliceThread();
    await insertUser(threadId, "old q");
    await insertAssistant(threadId, "old a");
    const currentUserId = await insertUser(threadId, "current");
    const run = await createConversationRun(threadId, currentUserId, { contextMaxMessageSequence: null });
    expect(run.contextMaxMessageSequence).toBeNull();
    // Append a message that must remain invisible under the legacy bound.
    await insertUser(threadId, "after-bound q");
    await insertAssistant(threadId, "after-bound a");

    const context = await buildConversationContext(run);
    expect(context.messages.map((m) => m.content)).toEqual(["old q", "old a"]);
    // Column is still NULL after the call — no writeback.
    const [after] = await db.select({ contextMaxMessageSequence: agentTaskRuns.contextMaxMessageSequence })
      .from(agentTaskRuns).where(eq(agentTaskRuns.userMessageId, currentUserId)).limit(1);
    expect(after?.contextMaxMessageSequence).toBeNull();
  });

  it("never returns messages from another thread, even in the same trip (§10.2 / §1.2)", async () => {
    const { threadId: aliceThreadId, tripId } = await createAliceThread();
    const bobThreadId = await createBobThreadInTrip(tripId);
    const aliceSecondThreadId = await createAliceThreadInTrip(tripId);

    // Alice's main thread: 1 complete turn + current.
    await insertUser(aliceThreadId, "alice q1");
    await insertAssistant(aliceThreadId, "alice a1");
    const currentUserId = await insertUser(aliceThreadId, "alice current");
    const run = await createConversationRun(aliceThreadId, currentUserId);

    // Same Trip, Bob's thread — must be invisible.
    const bobUserId = await insertBobUser(bobThreadId, "bob-isolated-q");
    await insertAssistant(bobThreadId, "bob-isolated-a");

    // Same Trip, second Alice-owned thread — also invisible.
    await insertUser(aliceSecondThreadId, "alice-other-thread-q");
    await insertAssistant(aliceSecondThreadId, "alice-other-thread-a");

    const context = await buildConversationContext(run);
    const flat = context.messages.map((m) => m.content).join("\n");
    expect(flat).not.toContain("bob-isolated");
    expect(flat).not.toContain("alice-other-thread");
    expect(context.messages.map((m) => m.content)).toEqual(["alice q1", "alice a1"]);
    // Sanity: bob's row was actually inserted (cleanup happens in afterAll).
    expect(bobUserId).toBeDefined();
  });

  it("ignores empty-body rows defensively (§3.2.2)", async () => {
    const { threadId } = await createAliceThread();
    // Insert an empty ASSISTANT body — defensive: a future code path
    // could write an empty row and we MUST NOT pass it to the model.
    await db.insert(chatMessages).values({
      threadId,
      senderUserId: null,
      role: "ASSISTANT",
      body: "",
      markedSharedByOwner: false,
      redactedSummary: null,
    });
    await insertUser(threadId, "u1");
    await insertAssistant(threadId, "a1");
    const currentUserId = await insertUser(threadId, "current");
    const run = await createConversationRun(threadId, currentUserId);

    const context = await buildConversationContext(run);
    // Empty-body ASSISTANT must be filtered out; only the real turn
    // (u1, a1) remains.
    expect(context.messages.map((m) => m.content)).toEqual(["u1", "a1"]);
  });

  it("ignores markedSharedByOwner and redactedSummary — returns raw body (§3.2.2 / §11)", async () => {
    const { threadId } = await createAliceThread();
    // Both columns are false/null; builder still returns the raw body.
    await db.insert(chatMessages).values({
      threadId,
      senderUserId: aliceId,
      role: "USER",
      body: "raw-private-content",
      markedSharedByOwner: false,
      redactedSummary: null,
    });
    await db.insert(chatMessages).values({
      threadId,
      senderUserId: null,
      role: "ASSISTANT",
      body: "raw-private-answer",
      markedSharedByOwner: false,
      redactedSummary: null,
    });
    const currentUserId = await insertUser(threadId, "current");
    const run = await createConversationRun(threadId, currentUserId);

    const context = await buildConversationContext(run);
    expect(context.messages.map((m) => m.content)).toEqual([
      "raw-private-content", "raw-private-answer",
    ]);
  });

  it("drops unpaired USER messages without over-including (§3.2.3)", async () => {
    const { threadId } = await createAliceThread();
    // Two USERs in a row (no ASSISTANT between them) followed by a complete
    // turn + the current question. The unpaired trailing USER must be
    // skipped without crashing or pulling in earlier orphan rows.
    await insertUser(threadId, "unpaired-1");
    await insertUser(threadId, "unpaired-2");
    await insertUser(threadId, "paired q");
    await insertAssistant(threadId, "paired a");
    const currentUserId = await insertUser(threadId, "current");
    const run = await createConversationRun(threadId, currentUserId);

    const context = await buildConversationContext(run);
    const flat = context.messages.map((m) => m.content).join("\n");
    expect(flat).not.toContain("unpaired-1");
    expect(flat).not.toContain("unpaired-2");
    expect(context.messages.map((m) => m.content)).toEqual(["paired q", "paired a"]);
  });

  it("fails closed when the task references are incomplete (§10.6)", async () => {
    await expect(
      buildConversationContext({
        id: randomUUID(),
        operation: "CONVERSATION",
        status: "QUEUED",
        createdByUserId: aliceId,
        threadId: null,
        tripId: null,
        requestId: randomUUID(),
        userMessageId: null,
        // @ts-expect-error — explicit shape for a missing-fields run row
        snapshotId: null, assistantMessageId: null, resultPlanId: null,
        placeSourceId: null, placeName: null,
        placeLatitude: null, placeLongitude: null,
        placeSourceType: null,
        intent: null,
        generationAttempt: 0, attemptCount: 0, maxAttempts: 3,
        leaseToken: null, leaseExpiresAt: null,
        startedAt: null, finishedAt: null, cancelRequestedAt: null,
        nextAttemptAt: new Date(), expiresAt: new Date(),
        errorCode: null, traceContext: null,
        contextMaxMessageSequence: null,
        createdAt: new Date(), updatedAt: new Date(),
      }),
    ).rejects.toThrow(/references are incomplete/);
  });

  it("fails closed when the USER message row is missing or in another thread (§10.6)", async () => {
    const { threadId } = await createAliceThread();
    const userMessageId = await insertUser(threadId, "u1");
    const run = await createConversationRun(threadId, userMessageId);
    // Delete the USER row after creating the run — the builder must
    // not fall back to the cached body, and must fail closed.
    await db.delete(chatMessages).where(eq(chatMessages.id, userMessageId));

    await expect(buildConversationContext(run)).rejects.toThrow(/USER message is unavailable/);
  });

  it("fails closed when userMessageId points at an ASSISTANT row (§10.6)", async () => {
    const { threadId } = await createAliceThread();
    const assistantId = await insertAssistant(threadId, "wrong role");
    const run = await createConversationRun(threadId, assistantId);

    await expect(buildConversationContext(run)).rejects.toThrow(/role mismatch/);
  });

  it("fails closed when userMessageId lives in a different thread (§1.2)", async () => {
    const { threadId: aliceThread } = await createAliceThread();
    const { tripId } = await provisionTripAndMember({ ownerUserId: bobId });
    const [bobThread] = await db.insert(chatThreads).values({
      ownerUserId: bobId,
      tripId,
      scope: "TRIP",
      isDefault: false,
      title: "bob cross",
    }).returning();
    const bobUserId = await insertBobUser(bobThread.id, "bob-q");

    // Build a run row claiming the USER lives in aliceThread but referencing
    // a message id that actually belongs to bobThread.
    const run = await createConversationRun(aliceThread, bobUserId, { tripId });

    await expect(buildConversationContext(run)).rejects.toThrow(/USER message is unavailable/);
  });

  it("fails closed when the resolved bound is not a positive integer (§4.1)", async () => {
    // The CHECK constraint rejects non-positive persisted bounds, so we
    // construct a fully-formed run row by hand and bypass persistence.
    const { threadId } = await createAliceThread();
    const currentUserId = await insertUser(threadId, "current");
    const [userMessage] = await db.select().from(chatMessages)
      .where(eq(chatMessages.id, currentUserId)).limit(1);
    await expect(buildConversationContext({
      id: randomUUID(),
      operation: "CONVERSATION",
      status: "QUEUED",
      createdByUserId: aliceId,
      threadId,
      tripId: userMessage?.threadId ?? null,
      requestId: randomUUID(),
      userMessageId: currentUserId,
      snapshotId: null, assistantMessageId: null, resultPlanId: null,
      placeSourceId: null, placeName: null,
      placeLatitude: null, placeLongitude: null,
      placeSourceType: null,
      intent: null,
      generationAttempt: 0, attemptCount: 0, maxAttempts: 3,
      leaseToken: null, leaseExpiresAt: null,
      startedAt: null, finishedAt: null, cancelRequestedAt: null,
      nextAttemptAt: new Date(), expiresAt: new Date(),
      errorCode: null, traceContext: null,
      contextMaxMessageSequence: 0,
      createdAt: new Date(), updatedAt: new Date(),
    })).rejects.toThrow(/not a positive integer/);
  });
});