import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { invokeSkill } from "../src/agents/skill-registry.js";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { agentTaskRuns, auditEvents, chatMessages, chatThreads, conversationHotelSearchStates, idempotencyRecords, personalResearchEvidence, users } from "../src/db/schema.js";
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

  it("routes a hotel request through the LLM conversation without persisting a card draft", async () => {
    const requestId = randomUUID();
    const threadId = await createThread(`Classified ${randomUUID()}`);
    let draftRunId: string | null = null;
    try {
      const accepted = await submitTurn(threadId, requestId, "请你帮我找一下西门町附近的酒店");
      expect(accepted.statusCode).toBe(202);
      const body = accepted.json() as AcceptedTurnResponse;
      draftRunId = body.runId;

      expect(await processNextAgentTask()).toBe(true);

      const run = await app.inject({
        method: "GET",
        url: `/api/v1/agent-runs/${body.runId}`,
        headers: authHeaders("alice"),
      });
      expect(run.statusCode).toBe(200);
      const runBody = run.json() as {
        status: string;
        researchIntentDraft: unknown;
        researchIntentState: string | null;
        assistantMessageId: string | null;
      };
      expect(runBody.status).toBe("COMPLETED");
      expect(runBody.researchIntentDraft).toBeNull();
      expect(runBody.researchIntentState).toBeNull();
      expect(runBody.assistantMessageId).not.toBeNull();
      const [assistantMessage] = await db.select().from(chatMessages).where(eq(chatMessages.id, runBody.assistantMessageId!));
      expect(assistantMessage?.body).toContain("Tokyo offers");

      const [runRow] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, body.runId));
      expect(runRow.researchIntentDraft).toBeNull();
      expect(runRow.researchIntentState).toBeNull();

      // Cross-thread safety remains unchanged for the conversation run.
      const bobView = await app.inject({
        method: "GET",
        url: `/api/v1/agent-runs/${body.runId}`,
        headers: authHeaders("bob"),
      });
      expect(bobView.statusCode).toBe(403);

    } finally {
      if (draftRunId) {
        await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, draftRunId));
      }
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, `chat_turn:${threadId}:${requestId}`));
    }
  });

  it("falls back to the LLM path for non-classified conversation turns", async () => {
    const requestId = randomUUID();
    const threadId = await createThread(`Unclassified ${randomUUID()}`);
    let fallbackRunId: string | null = null;
    try {
      // "桃园住宿区域推荐" is recommendation / qualitative phrasing; the
      // classifier must return CONVERSATION and the LLM path runs.
      const accepted = await submitTurn(threadId, requestId, "桃园住宿区域推荐");
      expect(accepted.statusCode).toBe(202);
      const body = accepted.json() as AcceptedTurnResponse;
      fallbackRunId = body.runId;
      expect(await processNextAgentTask()).toBe(true);

      const run = await app.inject({
        method: "GET",
        url: `/api/v1/agent-runs/${body.runId}`,
        headers: authHeaders("alice"),
      });
      const runBody = run.json() as {
        researchIntentDraft: unknown;
        researchIntentState: unknown;
        assistantMessageId: string | null;
      };
      // No draft persisted; the LLM reply becomes the assistant message.
      expect(runBody.researchIntentDraft).toBeNull();
      expect(runBody.researchIntentState).toBeNull();
      expect(runBody.assistantMessageId).not.toBeNull();
      const [assistantMessage] = await db.select().from(chatMessages).where(eq(chatMessages.id, runBody.assistantMessageId!));
      expect(assistantMessage?.body).toContain("Tokyo offers");
    } finally {
      if (fallbackRunId) {
        await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, fallbackRunId));
      }
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, `chat_turn:${threadId}:${requestId}`));
    }
  });

  it("Phase 4 — conversation worker dispatches hotel.search inline and persists personal_research_evidence", async () => {
    const previous = {
      flag: process.env.PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED,
      toolCalling: process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED,
    };
    process.env.PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED = "true";
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";

    const grounded = "Search ran; the live hotel feed returned no live inventory at the moment.";
    const toolGateway = buildToolDispatchGateway(grounded);
    __setModelGatewayForTests(toolGateway as unknown as ModelGateway);

    const threadId = await createThread(`Phase 4 tool dispatch ${randomUUID()}`);
    const firstRequestId = randomUUID();
    const secondRequestId = randomUUID();
    const firstRunIds: string[] = [];
    const evidenceRowsToCleanup: string[] = [];
    try {
      // First confirmation: full draft, expect a fresh evidence row.
      const first = await submitTurn(threadId, firstRequestId,
        "请你帮我找一下台北车站周边的酒店，2026/9/15 - 9/20，3 人 2 间房，豪华型，CNY。确认搜索");
      expect(first.statusCode).toBe(202);
      const firstRunId = (first.json() as AcceptedTurnResponse).runId;
      firstRunIds.push(firstRunId);
      expect(await processNextAgentTask()).toBe(true);

      const [firstEvidence] = await db.select().from(personalResearchEvidence)
        .where(eq(personalResearchEvidence.runId, firstRunId));
      expect(firstEvidence).toBeDefined();
      expect(firstEvidence?.capability).toBe("hotel.search");
      // The provider is unconfigured in test env, so the executor
      // returns NOT_CONFIGURED. The orchestrator persists that summary
      // regardless.
      const resultJson = firstEvidence?.resultJson as { outcome?: string; summary?: { errorCode?: string } };
      expect(resultJson?.outcome).toBe("UNAVAILABLE");
      expect(resultJson?.summary?.errorCode).toBe("NOT_CONFIGURED");
      evidenceRowsToCleanup.push(firstEvidence!.id);
      const [savedState] = await db.select().from(conversationHotelSearchStates)
        .where(eq(conversationHotelSearchStates.threadId, threadId));
      expect(savedState).toMatchObject({
        tripId,
        ownerUserId: aliceId,
        cityCode: "TPE",
        checkIn: "2026-09-15",
        checkOut: "2026-09-20",
        adults: 3,
        rooms: 2,
        currency: "CNY",
        confirmedMessageId: expect.any(String),
        confirmedAt: expect.any(Date),
      });

      // Idempotency: a second confirmation in a new turn must not insert a
      // new evidence row — the worker's dispatch closure probes the table
      // before invoking the executor.
      const second = await submitTurn(threadId, secondRequestId,
        "确认搜索");
      expect(second.statusCode).toBe(202);
      const secondRunId = (second.json() as AcceptedTurnResponse).runId;
      firstRunIds.push(secondRunId);
      expect(await processNextAgentTask()).toBe(true);

      const allRows = await db.select({ id: personalResearchEvidence.id, runId: personalResearchEvidence.runId })
        .from(personalResearchEvidence)
        .where(inArray(personalResearchEvidence.runId, firstRunIds));
      // Each conversation turn is its own durable run. The worker probes
      // by `(run_id, capability)` per-run, so a brand-new turn writes its
      // own evidence row rather than reusing a previous turn's. The unique
      // index prevents two `hotel.search` rows on the same runId; that is
      // the dedup guarantee — not cross-turn memoisation.
      expect(allRows).toHaveLength(2);
      const runIdsWithRows = new Set(allRows.map(r => r.runId));
      expect(runIdsWithRows.has(firstRunIds[0])).toBe(true);
      expect(runIdsWithRows.has(firstRunIds[1])).toBe(true);
      evidenceRowsToCleanup.push(...allRows.map(r => r.id));
      // The tool loop ran exactly once per turn (one dispatch per turn).
      expect(toolGateway.dispatchedNames).toEqual(["hotel.search", "hotel.search"]);
    } finally {
      for (const rowId of evidenceRowsToCleanup) {
        await db.delete(personalResearchEvidence).where(eq(personalResearchEvidence.id, rowId));
      }
      for (const runId of firstRunIds) {
        await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, runId));
      }
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, `chat_turn:${threadId}:${firstRequestId}`));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, `chat_turn:${threadId}:${secondRequestId}`));
      process.env.PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED = previous.flag;
      process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = previous.toolCalling;
      __setModelGatewayForTests(successfulConversationGateway);
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

/**
 * Phase 4 — tool-dispatching gateway. Simulates the LLMGateway's tool-calling
 * loop in a single `streamConversationReply` call: invokes the worker's
 * `dispatchTool` directly, then streams a grounded reply through `onDelta`.
 * The llm-gateway.test.ts suite already exercises the chunk-accumulator
 * path; this e2e verifies the worker's plumbing (dispatch closure invoked,
 * evidence row written, second-stream grounded reply routed back).
 */
function buildToolDispatchGateway(groundedReply: string): ModelGateway & {
  dispatchedNames: string[];
  groundedReplyCount: number;
} {
  const state = {
    dispatchedNames: [] as string[],
    groundedReplyCount: 0,
  };
  const gateway = {
    async generateStructuredPlan() { throw new Error("not used by conversation E2E"); },
    async explainPlanDiff() { throw new Error("not used by conversation E2E"); },
    async generateConversationReply() {
      throw new Error("tool-dispatch path always uses the streaming gateway");
    },
    async streamConversationReply(params: Parameters<NonNullable<ModelGateway["streamConversationReply"]>>[0]) {
      const onDelta = params.onDelta;
      // Subsequent confirmation turns deliberately provide no fields. The
      // worker must merge the server-persisted hotel state before it can
      // dispatch the provider, rather than relying on conversational context.
      const args = params.hotelSearchState ? {} : {
        cityCode: "TPE",
        checkIn: "2026-09-15",
        checkOut: "2026-09-20",
        occupancy: { adults: 3, rooms: 2 },
        currency: "CNY",
      };
      const toolResult = params.dispatchTool
        ? await params.dispatchTool({ id: "call_phase4", name: "hotel.search", arguments: args })
        : { outcome: "AVAILABLE", hotel: { currency: "CNY" } };
      state.dispatchedNames.push("hotel.search");
      void toolResult;
      const chunks = [
        { choices: [{ delta: { content: groundedReply } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ];
      for (const chunk of chunks) {
        const delta = chunk.choices[0].delta;
        if (delta.content) await onDelta(delta.content);
      }
      state.groundedReplyCount += 1;
      return { content: groundedReply, responseMode: "MODEL" };
    },
  } as ModelGateway;
  // Attach mutable counters AFTER the gateway object is created so the
  // object identity is stable across `__setModelGatewayForTests` calls
  // and our assertions observe live values.
  return Object.assign(gateway, {
    get dispatchedNames() { return state.dispatchedNames; },
    get groundedReplyCount() { return state.groundedReplyCount; },
  });
}
