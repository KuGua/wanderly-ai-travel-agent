import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { __setModelGatewayForTests } from "../src/providers/gateway-factory.js";
import type { ModelGateway } from "../src/providers/model-gateway.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
let aliceId: string;
let bobId: string;
let tripId: string;

/** Replaced per-test so each case controls what the model returns. */
let generateThreadTitle = vi.fn();

function stubGateway(): void {
  __setModelGatewayForTests({ generateThreadTitle } as unknown as ModelGateway);
}

async function createExtraThread(title?: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/trips/${tripId}/threads`,
    headers: { ...authHeaders("alice"), "content-type": "application/json" },
    payload: title === undefined ? { titleLocale: "zh" } : { title },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function addUserMessage(threadId: string, body: string): Promise<void> {
  await db.insert(chatMessages).values({ threadId, senderUserId: aliceId, role: "USER", body });
}

async function readThread(threadId: string) {
  const [row] = await db.select().from(chatThreads).where(eq(chatThreads.id, threadId)).limit(1);
  return row!;
}

function suggest(threadId: string, payload: Record<string, unknown> = {}, actor = "alice") {
  return app.inject({
    method: "POST",
    url: `/api/v1/trips/${tripId}/threads/${threadId}/title/suggest`,
    headers: { ...authHeaders(actor), "content-type": "application/json" },
    payload: { requestId: randomUUID(), locale: "zh", ...payload },
  });
}

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();

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
  await cleanup();
  __setModelGatewayForTests(null);
  await app.close();
});

beforeEach(async () => {
  await cleanup();
  generateThreadTitle = vi.fn();
  stubGateway();
  tripId = randomUUID();
  await db.insert(sharedTrips).values({
    id: tripId,
    name: `thread-title-suggest-${tripId}`,
    createdBy: aliceId,
    departureCities: ["Shanghai"],
    destinationCandidates: ["Tokyo"],
  });
  await db.insert(tripMembers).values([
    { tripId, userId: aliceId, role: "CREATOR", isRequired: true },
    { tripId, userId: bobId, role: "MEMBER", isRequired: true },
  ]);
});

afterEach(() => {
  __setModelGatewayForTests(null);
});

describe("POST /trips/:tripId/threads — server-owned numbering", () => {
  // A plain count inside the transaction is not enough: READ COMMITTED lets
  // both transactions read the same count and write the same "新对话 N".
  it("gives two concurrent creates distinct titles", async () => {
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/trips/${tripId}/threads`,
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: { titleLocale: "zh" },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/trips/${tripId}/threads`,
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: { titleLocale: "zh" },
      }),
    ]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const titles = [first.json(), second.json()].map((t) => (t as { title: string }).title);
    expect(new Set(titles).size).toBe(2);
    expect(titles.every((t) => /^新对话 [0-9]+$/.test(t))).toBe(true);
  });

  it("marks a caller-supplied title MANUAL and a generated one AUTO", async () => {
    const manual = await readThread(await createExtraThread("签证准备"));
    expect(manual.titleSource).toBe("MANUAL");
    expect(manual.titleLocale).toBeNull();

    const auto = await readThread(await createExtraThread());
    expect(auto.titleSource).toBe("AUTO");
    expect(auto.titleLocale).toBe("zh");
  });
});

describe("POST /trips/:tripId/threads/:threadId/title/suggest", () => {
  it("applies a clean suggestion and audits it without the title text", async () => {
    const threadId = await createExtraThread();
    await addUserMessage(threadId, "我想去东京，帮我看看签证要准备什么");
    generateThreadTitle.mockResolvedValue({ title: "东京签证准备" });

    const res = await suggest(threadId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: true });

    const row = await readThread(threadId);
    expect(row.title).toBe("东京签证准备");
    expect(row.titleSource).toBe("AUTO");
    expect(row.titleLocale).toBe("zh");

    const [audit] = await db.select().from(auditEvents)
      .where(and(
        eq(auditEvents.action, "CHAT_THREAD_TITLE_UPDATE"),
        eq(auditEvents.actorUserId, aliceId),
      ))
      .limit(1);
    expect(audit!.summary).toEqual({ threadId, source: "llm" });
  });

  it("refuses a MANUAL thread without an explicit overwrite, and never calls the model", async () => {
    const threadId = await createExtraThread("签证准备");
    await addUserMessage(threadId, "帮我查一下签证");

    const res = await suggest(threadId);
    expect(res.json()).toMatchObject({ applied: false, reason: "MANUAL_LOCKED" });
    expect(generateThreadTitle).not.toHaveBeenCalled();
    expect((await readThread(threadId)).title).toBe("签证准备");
  });

  it("overwrites a MANUAL thread when the owner asks for it", async () => {
    const threadId = await createExtraThread("签证准备");
    await addUserMessage(threadId, "帮我查一下签证");
    generateThreadTitle.mockResolvedValue({ title: "签证与入境" });

    const res = await suggest(threadId, { overwriteManual: true });
    expect(res.json()).toMatchObject({ applied: true });
    const row = await readThread(threadId);
    expect(row.title).toBe("签证与入境");
    expect(row.titleSource).toBe("AUTO");
  });

  // The MANUAL check happens before a multi-second model call. A rename that
  // lands in that window must not be discarded by the write that follows.
  it("does not clobber a rename that lands while the model is still working", async () => {
    const threadId = await createExtraThread();
    await addUserMessage(threadId, "帮我查一下签证");
    generateThreadTitle.mockImplementation(async () => {
      await app.inject({
        method: "PATCH",
        url: `/api/v1/trips/${tripId}/threads/${threadId}/title`,
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: { title: "我自己起的名字" },
      });
      return { title: "模型起的名字" };
    });

    const res = await suggest(threadId);
    expect(res.json()).toMatchObject({ applied: false, reason: "MANUAL_LOCKED" });
    const row = await readThread(threadId);
    expect(row.title).toBe("我自己起的名字");
    expect(row.titleSource).toBe("MANUAL");
    // The response carries the owner's title, not the pre-rename row.
    expect((res.json() as { thread: { title: string } }).thread.title).toBe("我自己起的名字");
  });

  it("reports NO_MATERIAL without calling the model when the thread has no user message", async () => {
    const threadId = await createExtraThread();
    const res = await suggest(threadId);
    expect(res.json()).toMatchObject({ applied: false, reason: "NO_MATERIAL" });
    expect(generateThreadTitle).not.toHaveBeenCalled();
  });

  it("reports UNAVAILABLE and keeps the title when the gateway fails", async () => {
    const threadId = await createExtraThread();
    const before = (await readThread(threadId)).title;
    await addUserMessage(threadId, "帮我查一下签证");
    generateThreadTitle.mockRejectedValue(new Error("upstream exploded"));

    const res = await suggest(threadId);
    expect(res.json()).toMatchObject({ applied: false, reason: "UNAVAILABLE" });
    expect((await readThread(threadId)).title).toBe(before);
  });

  it("reports REJECTED and keeps the title when postprocessing refuses the output", async () => {
    const threadId = await createExtraThread();
    const before = (await readThread(threadId)).title;
    await addUserMessage(threadId, "帮我查一下签证");
    generateThreadTitle.mockResolvedValue({ title: "see https://example.com" });

    const res = await suggest(threadId);
    expect(res.json()).toMatchObject({ applied: false, reason: "REJECTED" });
    expect((await readThread(threadId)).title).toBe(before);
  });

  it("rejects a non-owner with 403 and an unknown thread with 404", async () => {
    const threadId = await createExtraThread();
    expect((await suggest(threadId, {}, "bob")).statusCode).toBe(403);
    expect((await suggest(randomUUID())).statusCode).toBe(404);
  });
});

async function cleanup(): Promise<void> {
  if (!aliceId || !bobId) return;
  const threads = await db.select({ id: chatThreads.id }).from(chatThreads)
    .where(inArray(chatThreads.ownerUserId, [aliceId, bobId]));
  const threadIds = threads.map((t) => t.id);
  if (threadIds.length > 0) {
    await db.delete(chatMessages).where(inArray(chatMessages.threadId, threadIds));
    await db.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
  }
  await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, [aliceId, bobId]));
  const trips = await db.select({ id: sharedTrips.id }).from(sharedTrips)
    .where(inArray(sharedTrips.createdBy, [aliceId, bobId]));
  const tripIds = trips.map((t) => t.id);
  if (tripIds.length > 0) {
    await db.delete(tripMembers).where(inArray(tripMembers.tripId, tripIds));
    await db.delete(sharedTrips).where(inArray(sharedTrips.id, tripIds));
  }
}
