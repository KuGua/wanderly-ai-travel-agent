import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { buildApp } from "../src/app.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { invokeSkill } from "../src/agents/skill-registry.js";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  chatMessages,
  chatThreads,
  idempotencyRecords,
  users,
} from "../src/db/schema.js";
import { __setModelGatewayForTests } from "../src/providers/gateway-factory.js";
import { MockModelGateway } from "../src/providers/model-gateway.js";
import { threadRecallSkill } from "../src/skills/personal/thread-recall-skill.js";
import { createRequestContext } from "../src/utils/context.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
let aliceId: string;

beforeAll(async () => {
  __setModelGatewayForTests(new MockModelGateway());
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();
  const [alice] = await db.select().from(users).where(eq(users.externalId, "alice")).limit(1);
  aliceId = alice.id;
});

afterAll(async () => {
  __setModelGatewayForTests(null);
  await app.close();
});

describe("owner-only Personal Agent conversation flow", () => {
  it("persists, deduplicates, repeats the same Skill versions, and restores owner history", async () => {
    const requestIds = [randomUUID(), randomUUID()];
    const idempotencyKeys: string[] = [];
    const correlationIds: string[] = [];
    let threadId: string | undefined;

    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/threads",
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: { title: `Explore chat ${randomUUID()}` },
      });
      collectCorrelation(create, correlationIds);
      expect(create.statusCode).toBe(201);
      threadId = (create.json() as { id: string }).id;
      idempotencyKeys.push(...requestIds.map(id => `chat_turn:${threadId}:${id}`));

      const first = await submitTurn(threadId, requestIds[0], "Tell me about Tokyo");
      collectCorrelation(first, correlationIds);
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as TurnResponse;
      expect(firstBody.userMessage).toMatchObject({ role: "USER", content: "Tell me about Tokyo" });
      expect(firstBody.assistantMessage.role).toBe("ASSISTANT");
      expect(firstBody.responseMode).toBe("DEMO_FALLBACK");

      const duplicate = await submitTurn(threadId, requestIds[0], "Tell me about Tokyo");
      collectCorrelation(duplicate, correlationIds);
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json()).toEqual(firstBody);

      const second = await submitTurn(threadId, requestIds[1], "What should I explore next?");
      collectCorrelation(second, correlationIds);
      expect(second.statusCode).toBe(200);

      const rows = await db.select().from(chatMessages)
        .where(eq(chatMessages.threadId, threadId));
      expect(rows).toHaveLength(4);
      expect(rows.filter(row => row.role === "USER")).toHaveLength(2);
      expect(rows.filter(row => row.role === "ASSISTANT")).toHaveLength(2);
      expect(rows.filter(row => row.role === "USER").every(row => row.senderUserId === aliceId)).toBe(true);
      expect(rows.filter(row => row.role === "ASSISTANT").every(row => row.senderUserId === null)).toBe(true);

      const conversation = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${threadId}/conversation`,
        headers: authHeaders("alice"),
      });
      collectCorrelation(conversation, correlationIds);
      expect(conversation.statusCode).toBe(200);
      const conversationBody = conversation.json() as { messages: Array<{ role: string; content: string }> };
      expect(conversationBody.messages).toHaveLength(4);
      expect(conversationBody.messages.some(message => message.content === "Tell me about Tokyo")).toBe(true);
      expect(conversationBody.messages.some(message => message.role === "ASSISTANT")).toBe(true);

      const bobTurn = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${threadId}/turns`,
        headers: { ...authHeaders("bob"), "content-type": "application/json" },
        payload: { requestId: randomUUID(), question: "Read Alice's chat" },
      });
      collectCorrelation(bobTurn, correlationIds);
      expect(bobTurn.statusCode).toBe(403);

      const bobHistory = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${threadId}/conversation`,
        headers: authHeaders("bob"),
      });
      collectCorrelation(bobHistory, correlationIds);
      expect(bobHistory.statusCode).toBe(403);

      const forged = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${threadId}/messages`,
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: { body: "forged", role: "ASSISTANT" },
      });
      collectCorrelation(forged, correlationIds);
      expect(forged.statusCode).toBe(400);

      const recall = await invokeSkill<unknown, { messages: Array<{ contentRedacted: string }> }>(threadRecallSkill.name, {
        ctx: createRequestContext(aliceId),
        policyGate: new DefaultPolicyGate("personal"),
      }, { threadId, limit: 20 }, { expectedVersion: threadRecallSkill.version });
      expect(recall.messages).toHaveLength(4);
      expect(recall.messages.every(message => message.contentRedacted === "")).toBe(true);
      expect(JSON.stringify(recall)).not.toContain("Tell me about Tokyo");

      const audits = correlationIds.length > 0
        ? await db.select().from(auditEvents).where(inArray(auditEvents.correlationId, correlationIds))
        : [];
      const serializedAudits = JSON.stringify(audits.map(audit => audit.summary));
      expect(serializedAudits).not.toContain("Tell me about Tokyo");
      expect(serializedAudits).not.toContain(firstBody.assistantMessage.content);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/v1/threads/${threadId}`,
        headers: authHeaders("alice"),
      });
      collectCorrelation(deleted, correlationIds);
      expect(deleted.statusCode).toBe(200);
      expect(await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId))).toHaveLength(0);
    } finally {
      if (threadId) {
        await db.delete(chatMessages).where(eq(chatMessages.threadId, threadId));
        await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      }
      if (idempotencyKeys.length > 0) {
        await db.delete(idempotencyRecords).where(inArray(idempotencyRecords.idempotencyKey, idempotencyKeys));
      }
      if (correlationIds.length > 0) {
        await db.delete(auditEvents).where(inArray(auditEvents.correlationId, correlationIds));
      }
    }

    async function submitTurn(targetThreadId: string, requestId: string, question: string) {
      return app.inject({
        method: "POST",
        url: `/api/v1/threads/${targetThreadId}/turns`,
        headers: { ...authHeaders("alice"), "content-type": "application/json" },
        payload: {
          requestId,
          question,
          place: {
            sourceId: "tokyo",
            name: "Tokyo",
            latitude: 35.6895,
            longitude: 139.6917,
            sourceType: "FIXTURE",
          },
        },
      });
    }
  });
});

interface TurnResponse {
  threadId: string;
  userMessage: { id: string; role: "USER"; content: string; createdAt: string };
  assistantMessage: { id: string; role: "ASSISTANT"; content: string; createdAt: string };
  responseMode: "MODEL" | "DEMO_FALLBACK";
}

function collectCorrelation(response: { headers: Record<string, string | string[] | undefined> }, target: string[]) {
  const value = response.headers["x-correlation-id"];
  if (typeof value === "string") target.push(value);
}
