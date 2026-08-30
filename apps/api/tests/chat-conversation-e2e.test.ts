import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { invokeSkill } from "../src/agents/skill-registry.js";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { agentTaskRuns, auditEvents, chatMessages, chatThreads, idempotencyRecords, users } from "../src/db/schema.js";
import { __setModelGatewayForTests } from "../src/providers/gateway-factory.js";
import { ModelGatewayError } from "../src/providers/llm-gateway.js";
import type { ModelGateway } from "../src/providers/model-gateway.js";
import { threadRecallSkill } from "../src/skills/personal/thread-recall-skill.js";
import { AgentStreamRelay } from "../src/tasks/agent-stream-relay.js";
import { createRequestContext } from "../src/utils/context.js";
import { processNextAgentTask } from "../src/workers/agent-task-worker.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";
import { provisionTripAndMember } from "./helpers/trip.js";

let app: FastifyInstance;
let aliceId: string;
let tripId: string;

beforeAll(async () => {
  __setModelGatewayForTests(successfulConversationGateway);
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken, agentStreamRelay: new AgentStreamRelay() });
  await app.ready();
  const [createdAlice] = await db.insert(users)
    .values({ externalId: "alice", displayName: "Alice" })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  await db.insert(users)
    .values({ externalId: "bob", displayName: "Bob" })
    .onConflictDoNothing({ target: users.externalId });
  aliceId = (createdAlice ?? (await db.select().from(users)
    .where(eq(users.externalId, "alice")).limit(1))[0])!.id;
  // Per docs/trip-scoped-private-threads-implementation.md §1.1 every
  // chat thread must belong to a Trip and the creator must be an active
  // member.  Provision a Trip for this test suite up-front so the
  // POST /threads compatibility shim can accept the body.
  const provisioned = await provisionTripAndMember({ ownerUserId: aliceId });
  tripId = provisioned.tripId;
});

afterAll(async () => {
  __setModelGatewayForTests(null);
  await app.close();
});

describe("durable owner-only Personal Agent conversation flow", () => {
  it("accepts once, rejects concurrent work, completes in the Worker, and restores ordered owner history", async () => {
    const requestIds = [randomUUID(), randomUUID(), randomUUID()];
    const idempotencyKeys: string[] = [];
    const correlationIds: string[] = [];
    let threadId: string | undefined;

    try {
      threadId = await createThread(`Explore chat ${randomUUID()}`);
      idempotencyKeys.push(...requestIds.map((id) => `chat_turn:${threadId}:${id}`));

      const first = await submitTurn(threadId, requestIds[0], "Tell me about Tokyo");
      collectCorrelation(first, correlationIds);
      expect(first.statusCode).toBe(202);
      const firstBody = first.json() as AcceptedTurnResponse;
      expect(firstBody).toMatchObject({
        threadId,
        operation: "CONVERSATION",
        status: "QUEUED",
        generationAttempt: 0,
        userMessage: { role: "USER", content: "Tell me about Tokyo", sequence: expect.any(Number) },
      });
      const [acceptedRun] = await db.select().from(agentTaskRuns)
        .where(eq(agentTaskRuns.id, firstBody.runId)).limit(1);
      expect(acceptedRun).toMatchObject({
        operation: "CONVERSATION",
        threadId,
        tripId,
        userMessageId: firstBody.userMessage.id,
      });

      const duplicate = await submitTurn(threadId, requestIds[0], "Tell me about Tokyo");
      expect(duplicate.statusCode).toBe(202);
      expect(duplicate.json()).toEqual(firstBody);

      const concurrent = await submitTurn(threadId, requestIds[1], "Start another answer");
      expect(concurrent.statusCode).toBe(409);
      expect(await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId))).toHaveLength(1);

      expect(await processNextAgentTask()).toBe(true);
      const completedRun = await app.inject({
        method: "GET",
        url: `/api/v1/agent-runs/${firstBody.runId}`,
        headers: authHeaders("alice"),
      });
      expect(completedRun.statusCode).toBe(200);
      expect(completedRun.json()).toMatchObject({
        status: "COMPLETED",
        generationAttempt: 1,
        attemptCount: 1,
        assistantMessageId: expect.any(String),
      });

      const second = await submitTurn(threadId, requestIds[2], "What should I explore next?");
      expect(second.statusCode).toBe(202);
      expect(await processNextAgentTask()).toBe(true);

      const conversation = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${threadId}/conversation`,
        headers: authHeaders("alice"),
      });
      collectCorrelation(conversation, correlationIds);
      expect(conversation.statusCode).toBe(200);
      const messages = (conversation.json() as { messages: OwnerMessage[] }).messages;
      expect(messages).toHaveLength(4);
      expect(messages.map((message) => message.role)).toEqual(["USER", "ASSISTANT", "USER", "ASSISTANT"]);
      const sequences = messages.map((message) => message.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));

      const rows = await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId));
      expect(rows.filter((row) => row.role === "USER").every((row) => row.senderUserId === aliceId)).toBe(true);
      expect(rows.filter((row) => row.role === "ASSISTANT").every((row) => row.senderUserId === null)).toBe(true);

      const bobRun = await app.inject({
        method: "GET",
        url: `/api/v1/agent-runs/${firstBody.runId}`,
        headers: authHeaders("bob"),
      });
      expect(bobRun.statusCode).toBe(403);
      const bobHistory = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${threadId}/conversation`,
        headers: authHeaders("bob"),
      });
      expect(bobHistory.statusCode).toBe(403);

      const recall = await invokeSkill<unknown, { messages: Array<{ contentRedacted: string }> }>(threadRecallSkill.name, {
        ctx: createRequestContext(aliceId),
        policyGate: new DefaultPolicyGate("personal"),
      }, { threadId, limit: 20 }, { expectedVersion: threadRecallSkill.version });
      expect(recall.messages).toHaveLength(4);
      expect(recall.messages.every((message) => message.contentRedacted === "")).toBe(true);

      // A privacy assertion that inspects nothing silently passes, so prove the
      // audit trail was actually collected and covers this turn before asserting
      // that raw question and answer text is absent from it.
      expect(correlationIds.length).toBeGreaterThan(0);
      const audits = await db.select().from(auditEvents)
        .where(inArray(auditEvents.correlationId, correlationIds));
      expect(audits.length).toBeGreaterThan(0);
      const auditedActions = new Set(audits.map((audit) => audit.action));
      expect(auditedActions).toContain("CHAT_MESSAGE_APPEND");
      expect(auditedActions).toContain("AGENT_TASK");
      const serializedAudits = JSON.stringify(audits.map((audit) => audit.summary));
      expect(serializedAudits).not.toContain("Tell me about Tokyo");
      expect(serializedAudits).not.toContain("Tokyo offers distinct neighborhoods");
    } finally {
      if (threadId) await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      if (idempotencyKeys.length > 0) {
        await db.delete(idempotencyRecords).where(inArray(idempotencyRecords.idempotencyKey, idempotencyKeys));
      }
      if (correlationIds.length > 0) {
        await db.delete(auditEvents).where(inArray(auditEvents.correlationId, correlationIds));
      }
    }
  });

  it("cancels a queued task immediately without inventing an assistant message", async () => {
    const requestId = randomUUID();
    const threadId = await createThread(`Cancelled chat ${randomUUID()}`);
    try {
      const accepted = await submitTurn(threadId, requestId, "Do not start this answer");
      const body = accepted.json() as AcceptedTurnResponse;
      const cancelled = await app.inject({
        method: "POST",
        url: `/api/v1/agent-runs/${body.runId}/cancel`,
        headers: authHeaders("alice"),
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ status: "CANCELLED", errorCode: "CANCELLED" });
      const messages = await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId));
      expect(messages.map((message) => message.role)).toEqual(["USER"]);
    } finally {
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, `chat_turn:${threadId}:${requestId}`));
    }
  });

  it("persists the USER message and exposes a safe terminal code after retry exhaustion", async () => {
    const requestId = randomUUID();
    const threadId = await createThread(`Provider failure ${randomUUID()}`);
    __setModelGatewayForTests(failingConversationGateway);
    try {
      const accepted = await submitTurn(threadId, requestId, "Tell me about Tokyo");
      expect(accepted.statusCode).toBe(202);
      const body = accepted.json() as AcceptedTurnResponse;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await db.update(agentTaskRuns).set({ nextAttemptAt: new Date(0) }).where(eq(agentTaskRuns.id, body.runId));
        expect(await processNextAgentTask()).toBe(true);
      }

      const failed = await app.inject({
        method: "GET",
        url: `/api/v1/agent-runs/${body.runId}`,
        headers: authHeaders("alice"),
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.json()).toMatchObject({
        status: "FAILED",
        attemptCount: 3,
        generationAttempt: 3,
        errorCode: "UPSTREAM_5XX",
        assistantMessageId: null,
      });
      const messages = await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId));
      expect(messages.map((message) => message.role)).toEqual(["USER"]);
    } finally {
      __setModelGatewayForTests(successfulConversationGateway);
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, `chat_turn:${threadId}:${requestId}`));
    }
  });
});

async function createThread(title: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: { ...authHeaders("alice"), "content-type": "application/json" },
    payload: { title, tripId },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

function submitTurn(threadId: string, requestId: string, question: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/threads/${threadId}/turns`,
    headers: { ...authHeaders("alice"), "content-type": "application/json" },
    payload: {
      requestId,
      question,
      place: { sourceId: "tokyo", name: "Tokyo", latitude: 35.6895, longitude: 139.6917, sourceType: "REFERENCE" },
    },
  });
}

interface AcceptedTurnResponse {
  threadId: string;
  runId: string;
  operation: "CONVERSATION";
  status: "QUEUED";
  generationAttempt: 0;
  userMessage: OwnerMessage & { role: "USER" };
}

interface OwnerMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  sequence: number;
  createdAt: string;
}

const successfulConversationGateway: ModelGateway = {
  async generateConversationReply() {
    return { content: "Tokyo offers distinct neighborhoods, food culture, design, and museums.", responseMode: "MODEL" };
  },
  async generateStructuredPlan() { throw new Error("not used by conversation E2E"); },
  async explainPlanDiff() { throw new Error("not used by conversation E2E"); },
};

const failingConversationGateway: ModelGateway = {
  ...successfulConversationGateway,
  async generateConversationReply() { throw new ModelGatewayError("UPSTREAM_5XX", "conversation"); },
};

function collectCorrelation(response: { headers: Record<string, string | string[] | undefined> }, target: string[]) {
  const value = response.headers["x-correlation-id"];
  if (typeof value === "string") target.push(value);
}
