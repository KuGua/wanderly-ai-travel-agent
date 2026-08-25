import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  users,
  sharedTrips,
  tripMembers,
  chatMessages,
  chatThreads,
  auditEvents,
} from "../src/db/schema.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
let aliceId: string;
let bobId: string;
let tripId: string;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();

  // Reuse or create seeded fixture users via the auth helpers' subjects.
  const [alice] = await db.insert(users)
    .values({ externalId: "alice", displayName: "Alice" })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  const [bob] = await db.insert(users)
    .values({ externalId: "bob", displayName: "Bob" })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  aliceId = (alice ?? (await db.select().from(users).where(eq(users.externalId, "alice")).limit(1))[0])!.id;
  bobId = (bob ?? (await db.select().from(users).where(eq(users.externalId, "bob")).limit(1))[0])!.id;
});

afterAll(async () => {
  await cleanupOwnedChatState();
  await app.close();
});

beforeEach(async () => {
  await cleanupOwnedChatState();
  tripId = randomUUID();
  await db.insert(sharedTrips).values({
    id: tripId,
    name: `chat-threads-test-${tripId}`,
    createdBy: aliceId,
    departureCities: ["San Francisco", "Shanghai"],
    destinationCandidates: ["Tokyo", "Bangkok"],
  });
  await db.insert(tripMembers).values([
    { tripId, userId: aliceId, role: "CREATOR", isRequired: true },
    { tripId, userId: bobId, role: "MEMBER", isRequired: true },
  ]);
});

describe("chat-threads route — owner-only", () => {
  it("alice can create a thread bound to a trip", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { title: "Planning scratchpad", tripId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

    // Audit row carries CHAT_THREAD_CREATE
    const [audit] = await db.select()
      .from(auditEvents)
      .where(and(
        eq(auditEvents.action, "CHAT_THREAD_CREATE"),
        eq(auditEvents.actorUserId, aliceId),
      ))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(aliceId);
  });

  it("GET /threads only returns the caller's threads", async () => {
    // Alice creates one; Bob creates one
    await app.inject({
      method: "POST", url: "/api/v1/threads",
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { title: "Alice thread" },
    });
    await app.inject({
      method: "POST", url: "/api/v1/threads",
      headers: { ...authHeaders("bob"), "content-type": "application/json" },
      payload: { title: "Bob thread" },
    });

    const aliceList = await app.inject({
      method: "GET", url: "/api/v1/threads",
      headers: { ...authHeaders("alice") },
    });
    const bobList = await app.inject({
      method: "GET", url: "/api/v1/threads",
      headers: { ...authHeaders("bob") },
    });

    const aliceBody = aliceList.json() as { threads: Array<{ title: string }> };
    const bobBody = bobList.json() as { threads: Array<{ title: string }> };
    expect(aliceBody.threads.map(t => t.title)).toEqual(["Alice thread"]);
    expect(bobBody.threads.map(t => t.title)).toEqual(["Bob thread"]);
  });

  it("bob cannot read alice's thread — 403", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/v1/threads",
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { title: "Alice private" },
    });
    const { id } = create.json() as { id: string };

    const res = await app.inject({
      method: "GET", url: `/api/v1/threads/${id}`,
      headers: { ...authHeaders("bob") },
    });
    expect(res.statusCode).toBe(403);
  });

  it("unknown threadId returns 404 (not 403, to keep both codes meaningful)", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/v1/threads/${randomUUID()}`,
      headers: { ...authHeaders("bob") },
    });
    expect(res.statusCode).toBe(404);
  });

  it("messages never return raw body; only redacted summary for owner-marked shared", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/v1/threads",
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { title: "Redaction test" },
    });
    const { id: threadId } = create.json() as { id: string };

    // Append a message and manually backfill redacted_summary so the API
    // can return it.
    const [inserted] = await db.insert(chatMessages).values({
      threadId,
      senderUserId: aliceId,
      role: "USER",
      body: "This is raw transcript that must never surface.",
      markedSharedByOwner: true,
      redactedSummary: "User mentioned an unshared constraint.",
    }).returning();
    void inserted;

    const res = await app.inject({
      method: "GET", url: `/api/v1/threads/${threadId}/messages`,
      headers: { ...authHeaders("alice") },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: Array<{ contentRedacted: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].contentRedacted).toBe("User mentioned an unshared constraint.");
    // Defense: the response body must not contain the raw transcript.
    expect(JSON.stringify(body)).not.toContain("raw transcript");
  });

  it("unshared message returns contentRedacted=''", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/v1/threads",
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { title: "Empty redaction test" },
    });
    const { id: threadId } = create.json() as { id: string };

    await db.insert(chatMessages).values({
      threadId,
      senderUserId: aliceId,
      role: "USER",
      body: "raw private message",
      markedSharedByOwner: false,
    });

    const res = await app.inject({
      method: "GET", url: `/api/v1/threads/${threadId}/messages`,
      headers: { ...authHeaders("alice") },
    });
    const body = res.json() as { messages: Array<{ contentRedacted: string }> };
    expect(body.messages[0].contentRedacted).toBe("");
  });

  it("DELETE cascades messages and records CHAT_THREAD_DELETE audit", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/v1/threads",
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { title: "To be deleted" },
    });
    const { id: threadId } = create.json() as { id: string };

    await db.insert(chatMessages).values({
      threadId,
      senderUserId: aliceId,
      role: "USER",
      body: "should vanish",
    });

    const del = await app.inject({
      method: "DELETE", url: `/api/v1/threads/${threadId}`,
      headers: { ...authHeaders("alice") },
    });
    expect(del.statusCode).toBe(200);

    const remainingThreads = await db.select().from(chatThreads)
      .where(eq(chatThreads.id, threadId));
    const remainingMessages = await db.select().from(chatMessages)
      .where(eq(chatMessages.threadId, threadId));
    expect(remainingThreads).toHaveLength(0);
    expect(remainingMessages).toHaveLength(0);

    const [audit] = await db.select()
      .from(auditEvents)
      .where(and(
        eq(auditEvents.action, "CHAT_THREAD_DELETE"),
        eq(auditEvents.actorUserId, aliceId),
      ))
      .limit(1);
    expect(audit).toBeDefined();
  });
});

async function cleanupOwnedChatState(): Promise<void> {
  if (!aliceId || !bobId) return;

  await db.delete(auditEvents).where(and(
    inArray(auditEvents.actorUserId, [aliceId, bobId]),
    inArray(auditEvents.action, [
      "CHAT_THREAD_CREATE",
      "CHAT_THREAD_DELETE",
      "CHAT_MESSAGE_APPEND",
    ]),
  ));
  // Deleting owned threads cascades their messages.
  await db.delete(chatThreads)
    .where(inArray(chatThreads.ownerUserId, [aliceId, bobId]));

  if (tripId) {
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
  }
}
