import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  chatThreads,
  idempotencyRecords,
  users,
} from "../src/db/schema.js";
import { AgentStreamRelay } from "../src/tasks/agent-stream-relay.js";
import { loadConversationTurnInput } from "../src/tasks/task-repository.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";
import { provisionTripAndMember } from "./helpers/trip.js";

let app: FastifyInstance;
let tripId: string;

beforeAll(async () => {
  app = await buildApp({
    verifyAccessToken: verifyTestAccessToken,
    agentStreamRelay: new AgentStreamRelay(),
  });
  await app.ready();
  // Per docs/trip-scoped-private-threads-implementation.md §1.1 every
  // chat thread must belong to a Trip and the creator must be an active
  // member.  Provision a Trip for the alice test user once per suite.
  // Provision alice rather than assume her — see the note in
  // agent-run-stream-headers.test.ts. Nothing seeds this user, so on a fresh
  // database this file failed at collection, which is how it showed up in CI.
  const [inserted] = await db.insert(users)
    .values({ externalId: "alice", displayName: "Alice" })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  const alice = inserted
    ?? (await db.select().from(users).where(eq(users.externalId, "alice")).limit(1))[0]!;
  const provisioned = await provisionTripAndMember({ ownerUserId: alice.id });
  tripId = provisioned.tripId;
});

afterAll(async () => {
  await app.close();
});

describe("agent_task_runs.intent persistence", () => {
  it("persists intent through accept → loadConversationTurnInput and pins the context boundary", async () => {
    const requestId = randomUUID();
    let threadId: string | undefined;
    let runId: string | undefined;
    const idempotencyKey = `chat_turn:${requestId}:${randomUUID()}`;

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/threads",
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: { title: `Intent persistence ${randomUUID()}`, tripId },
      });
      expect(created.statusCode).toBe(201);
      threadId = (created.json() as { id: string }).id;

      const accepted = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${threadId}/turns`,
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: {
          requestId,
          question: "Tell me about Kyoto",
          intent: "auto_intro",
          place: {
            sourceId: "kyoto",
            name: "Kyoto",
            latitude: 35.0116,
            longitude: 135.7681,
            sourceType: "REFERENCE",
          },
        },
      });
      expect(accepted.statusCode).toBe(202);
      runId = (accepted.json() as { runId: string }).runId;

      const [run] = await db.select({ intent: agentTaskRuns.intent }).from(agentTaskRuns)
        .where(eq(agentTaskRuns.id, runId))
        .limit(1);
      expect(run?.intent).toBe("auto_intro");

      const [fullRun] = await db.select().from(agentTaskRuns)
        .where(eq(agentTaskRuns.id, runId))
        .limit(1);
      const input = await loadConversationTurnInput(fullRun);
      expect(input.intent).toBe("auto_intro");
      expect(input.question).toBe("Tell me about Kyoto");
      expect(input.place).toMatchObject({
        name: "Kyoto",
        latitude: 35.0116,
        longitude: 135.7681,
        sourceType: "REFERENCE",
      });
      // Per docs/thread-context-memory-implementation.md §4.1 the context
      // boundary MUST be pinned to the just-inserted USER row's sequence
      // at acceptance time.  This guarantees retries cannot widen the
      // window into messages appended after the user pressed send.
      expect(fullRun.contextMaxMessageSequence).not.toBeNull();
      expect(fullRun.contextMaxMessageSequence).toBeGreaterThan(0);
    } finally {
      if (threadId) await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
    }
  });

  it.each(["brief_saved", "preferences_saved"] as const)(
    "carries %s through to the Skill, so the turn may say the save landed",
    async (intent) => {
      const requestId = randomUUID();
      let threadId: string | undefined;
      const idempotencyKey = `chat_turn:${requestId}:${randomUUID()}`;

      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/threads",
          headers: { ...authHeaders("alice"), "content-type": "application/json" },
          payload: { title: `Intent ${intent} ${randomUUID()}`, tripId },
        });
        expect(created.statusCode).toBe(201);
        threadId = (created.json() as { id: string }).id;

        const accepted = await app.inject({
          method: "POST",
          url: `/api/v1/threads/${threadId}/turns`,
          headers: { ...authHeaders("alice"), "content-type": "application/json" },
          payload: { requestId, question: "I've just saved this to the trip.", intent },
        });
        expect(accepted.statusCode).toBe(202);
        const runId = (accepted.json() as { runId: string }).runId;

        const [fullRun] = await db.select().from(agentTaskRuns)
          .where(eq(agentTaskRuns.id, runId))
          .limit(1);
        expect(fullRun.intent).toBe(intent);
        // The loader used to narrow to auto_intro | user_typed, which dropped
        // exactly the two intents that authorize a completion claim: the reply
        // to a card the traveller had just saved was replaced by "I couldn't
        // turn that into a savable trip change yet".
        const input = await loadConversationTurnInput(fullRun);
        expect(input.intent).toBe(intent);
      } finally {
        if (threadId) await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
        await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
      }
    },
  );

  it("roundtripures undefined intent as null without throwing", async () => {
    const requestId = randomUUID();
    let threadId: string | undefined;
    let runId: string | undefined;
    const idempotencyKey = `chat_turn:${requestId}:${randomUUID()}`;

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/threads",
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: { title: `Intent null ${randomUUID()}`, tripId },
      });
      threadId = (created.json() as { id: string }).id;

      const accepted = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${threadId}/turns`,
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: { requestId, question: "Kyoto weather?" },
      });
      expect(accepted.statusCode).toBe(202);
      runId = (accepted.json() as { runId: string }).runId;

      const [run] = await db.select({ intent: agentTaskRuns.intent }).from(agentTaskRuns)
        .where(eq(agentTaskRuns.id, runId))
        .limit(1);
      expect(run?.intent).toBeNull();

      const [fullRun] = await db.select().from(agentTaskRuns)
        .where(eq(agentTaskRuns.id, runId))
        .limit(1);
      const input = await loadConversationTurnInput(fullRun);
      expect(input.intent).toBeUndefined();
      // PLAN/REPLAN tasks do not exist in this suite, but the column
      // shape is the same — for a CONVERSATION task the boundary is set.
      expect(fullRun.contextMaxMessageSequence).not.toBeNull();
    } finally {
      if (threadId) await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
    }
  });
});