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
} from "../src/db/schema.js";
import { AgentStreamRelay } from "../src/tasks/agent-stream-relay.js";
import { loadConversationTaskInput } from "../src/tasks/task-repository.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    verifyAccessToken: verifyTestAccessToken,
    agentStreamRelay: new AgentStreamRelay(),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("agent_task_runs.intent persistence", () => {
  it("persists intent through accept → loadConversationTaskInput", async () => {
    const requestId = randomUUID();
    let threadId: string | undefined;
    let runId: string | undefined;
    const idempotencyKey = `chat_turn:${requestId}:${randomUUID()}`;

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/threads",
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: { title: `Intent persistence ${randomUUID()}` },
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
      const input = await loadConversationTaskInput(fullRun);
      expect(input.intent).toBe("auto_intro");
      expect(input.question).toBe("Tell me about Kyoto");
      expect(input.place).toMatchObject({
        name: "Kyoto",
        latitude: 35.0116,
        longitude: 135.7681,
        sourceType: "REFERENCE",
      });
    } finally {
      if (threadId) await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
    }
  });

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
        payload: { title: `Intent null ${randomUUID()}` },
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
      const input = await loadConversationTaskInput(fullRun);
      expect(input.intent).toBeUndefined();
    } finally {
      if (threadId) await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
    }
  });
});