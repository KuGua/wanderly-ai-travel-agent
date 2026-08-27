import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { SpanKind } from "@opentelemetry/api";

import { db, rawDb } from "../db/database.js";
import {
  agentTaskRuns,
  chatMessages,
  idempotencyRecords,
  outboxEvents,
} from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { resolveConversationPlace } from "../policy/conversation-safety.js";
import { recordAudit } from "../services/audit-service.js";
import { requireOwnedTripThread } from "../services/chat-thread-service.js";
import { claimIdempotency } from "../services/idempotency-service.js";
import {
  agentRunResponseSchema,
  conversationTurnAcceptedResponseSchema,
  type AgentRunResponse,
  type ConversationPlace,
  type ConversationTurnAcceptedResponse,
  type ConversationTurnRequest,
  type OwnerConversationMessage,
} from "../types/schemas.js";
import type { RequestContext } from "../utils/context.js";
import { createRequestContext } from "../utils/context.js";
import {
  getTracer,
  recordSpanError,
  safeSetAttribute,
} from "../observability/tracing.js";
import { agentTaskConfig } from "./config.js";
import { publishAgentStreamEvent } from "./task-stream-publisher.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AgentTaskRow = typeof agentTaskRuns.$inferSelect;

/**
 * Build the `agent_task_runs.trace_context` JSONB payload from the inbound
 * `RequestContext`. The shape is the W3C trace context plus the canonical
 * server-owned `correlationId`; it is consumed by the Worker's `ctxFromRun`
 * helper to reconstruct the active OTel context after the durable boundary.
 * `null` is returned when no trace context was supplied — old rows that
 * pre-date PR 3 land here, and the Worker falls back to a no-op span.
 */
function buildTraceContextForTask(ctx: RequestContext): {
  traceparent: string;
  tracestate?: string;
  correlationId: string;
} | null {
  if (!ctx.traceparent) return null;
  return {
    traceparent: ctx.traceparent,
    tracestate: ctx.tracestate,
    correlationId: ctx.correlationId,
  };
}

/**
 * Inverse of `buildTraceContextForTask`. Reads the persisted
 * `trace_context` column and rehydrates a `RequestContext` suitable for the
 * Worker. When the column is `null` (old rows, recovery, or background
 * replay), returns a context with a freshly-minted UUID so downstream
 * consumers never see `undefined` ids.
 */
export function ctxFromRun(run: AgentTaskRow): RequestContext {
  const tc = run.traceContext ?? null;
  return createRequestContext(
    run.createdByUserId,
    tc?.correlationId ?? randomUUID(),
    randomUUID(),
    undefined,
    tc?.traceparent,
    tc?.tracestate,
  );
}

const CLAIM_CONVERSATION_SQL = [
  "WITH candidate AS (",
  "  SELECT id FROM agent_task_runs",
  "  WHERE operation = 'CONVERSATION' AND status = 'QUEUED'",
  "    AND next_attempt_at <= NOW() AND expires_at > NOW()",
  "    AND attempt_count < max_attempts",
  "  ORDER BY created_at ASC",
  "  FOR UPDATE SKIP LOCKED LIMIT 1",
  ")",
  "UPDATE agent_task_runs AS task",
  "SET status = 'RUNNING', lease_token = $1,",
  "    lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),",
  "    started_at = COALESCE(task.started_at, NOW()),",
  "    attempt_count = task.attempt_count + 1,",
  "    generation_attempt = task.generation_attempt + 1, updated_at = NOW()",
  "FROM candidate WHERE task.id = candidate.id RETURNING task.id",
].join("\n");

export class LostTaskLeaseError extends Error {
  constructor() {
    super("Agent task lease is no longer active");
    this.name = "LostTaskLeaseError";
  }
}

export async function acceptConversationTask(params: {
  ctx: RequestContext;
  threadId: string;
  ownerUserId: string;
  input: ConversationTurnRequest;
}): Promise<ConversationTurnAcceptedResponse> {
  const span = getTracer().startSpan("db.agent_task_runs.INSERT", {
    kind: SpanKind.CLIENT,
    attributes: {
      "db.system": "postgresql",
      "db.operation": "INSERT",
      "db.sql.table": "agent_task_runs",
    },
  });
  try {
    const place = await resolveConversationPlace(params.input.place);
    const idempotencyKey = conversationIdempotencyKey(params.threadId, params.input.requestId);
    const runId = randomUUID();
    const expiresAt = new Date(Date.now() + agentTaskConfig.queueTtlSeconds * 1000);

    const accepted = await db.transaction(async (tx) => {
      const thread = await requireThreadOwner(tx, params.threadId, params.ownerUserId);
      const claimed = await claimIdempotency(tx, { key: idempotencyKey, entityType: "agent_conversation_task" });
      if (!claimed) return null;

      const [activeRun] = await tx.select({ id: agentTaskRuns.id }).from(agentTaskRuns).where(and(
        eq(agentTaskRuns.threadId, params.threadId),
        inArray(agentTaskRuns.status, ["QUEUED", "RUNNING", "CANCEL_REQUESTED"]),
      )).limit(1);
      if (activeRun) {
        throw new ApiError(409, "Conflict", "This conversation already has an active Agent run");
      }

      const [userMessage] = await tx.insert(chatMessages).values({
        threadId: params.threadId,
        senderUserId: params.ownerUserId,
        role: "USER",
        body: params.input.question,
        markedSharedByOwner: false,
        redactedSummary: null,
      }).returning();

      const [run] = await tx.insert(agentTaskRuns).values({
        id: runId,
        operation: "CONVERSATION",
        status: "QUEUED",
        createdByUserId: params.ownerUserId,
        threadId: params.threadId,
        // tripId is server-derived from the locked thread row; clients
        // never influence it via path or body.  This guarantees the
        // invariant in docs/trip-scoped-private-threads-implementation.md
        // §4.3 that conversation tasks carry the thread's trip_id.
        tripId: thread.tripId,
        requestId: params.input.requestId,
        userMessageId: userMessage.id,
        expiresAt,
        traceContext: buildTraceContextForTask(params.ctx),
        intent: params.input.intent ?? null,
        ...placeColumns(place),
      }).returning();

      // Consistency check: a CONVERSATION task MUST have both threadId
      // and tripId.  If either is missing, the schema is misconfigured
      // or the locking helper regressed — fail loudly.
      if (!run.threadId || !run.tripId) {
        throw new ApiError(500, "Internal Server Error", "Conversation task missing threadId/tripId");
      }

      await tx.update(idempotencyRecords).set({
        entityId: run.id,
        resultPayload: { runId: run.id },
      }).where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
      await tx.insert(outboxEvents).values({
        eventId: randomUUID(),
        eventType: "AGENT_TASK_QUEUED",
        payload: { taskId: run.id, operation: run.operation },
      });
      await recordAudit({
        ctx: params.ctx,
        action: "CHAT_MESSAGE_APPEND",
        actorUserId: params.ownerUserId,
        tripId: thread.tripId,
        summary: { threadId: params.threadId, messageId: userMessage.id, role: "USER" },
        tx,
      });
      await recordAudit({
        ctx: params.ctx,
        action: "AGENT_TASK",
        actorUserId: params.ownerUserId,
        tripId: thread.tripId,
        summary: { taskId: run.id, operation: run.operation, status: run.status },
        tx,
      });
      return acceptedResponse(run, toOwnerMessage(userMessage));
    });

    if (accepted) {
      safeSetAttribute(span, "db.outcome", "success");
      return accepted;
    }
    safeSetAttribute(span, "db.outcome", "duplicate");
    const existing = await loadAcceptedConversationTask(params.threadId, params.ownerUserId, params.input.requestId);
    if (existing) return existing;
    throw new ApiError(409, "Conflict", "Conversation turn is already being accepted");
  } catch (err) {
    safeSetAttribute(span, "db.outcome", "failure");
    recordSpanError(err);
    throw err;
  } finally {
    span.end();
  }
}

export async function getAuthorizedAgentRun(runId: string, userId: string): Promise<AgentRunResponse> {
  const [run] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).limit(1);
  if (!run) throw new ApiError(404, "Not Found", "Agent run not found");
  if (run.createdByUserId !== userId) throw new ApiError(403, "Forbidden", "Not authorized for this Agent run");
  return toRunResponse(run);
}

export async function requestAgentTaskCancellation(params: {
  ctx: RequestContext;
  runId: string;
  userId: string;
}): Promise<AgentRunResponse> {
  const result = await db.transaction(async (tx) => {
    const [run] = await tx.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, params.runId)).limit(1);
    if (!run) throw new ApiError(404, "Not Found", "Agent run not found");
    if (run.createdByUserId !== params.userId) throw new ApiError(403, "Forbidden", "Not authorized for this Agent run");
    if (!["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(run.status)) return toRunResponse(run);

    const cancelledBeforeStart = run.status === "QUEUED";
    const nextStatus = cancelledBeforeStart ? "CANCELLED" : "CANCEL_REQUESTED";
    const [updated] = await tx.update(agentTaskRuns).set({
      status: nextStatus,
      cancelRequestedAt: run.cancelRequestedAt ?? new Date(),
      finishedAt: cancelledBeforeStart ? new Date() : run.finishedAt,
      errorCode: cancelledBeforeStart ? "CANCELLED" : run.errorCode,
      updatedAt: new Date(),
    }).where(and(
      eq(agentTaskRuns.id, params.runId),
      inArray(agentTaskRuns.status, ["QUEUED", "RUNNING", "CANCEL_REQUESTED"]),
    )).returning();

    await tx.insert(outboxEvents).values({
      eventId: randomUUID(),
      eventType: cancelledBeforeStart ? "AGENT_TASK_CANCELLED" : "AGENT_TASK_CANCEL_REQUESTED",
      payload: { taskId: run.id, operation: run.operation },
    });
    await recordAudit({
      ctx: params.ctx,
      action: "AGENT_TASK",
      actorUserId: params.userId,
      summary: { taskId: run.id, operation: run.operation, status: nextStatus },
      tx,
    });
    return toRunResponse(updated ?? run);
  });
  if (result.status === "CANCELLED") {
    await publishAgentStreamEvent({
      event: "turn.cancelled",
      runId: result.runId,
      generationAttempt: result.generationAttempt,
    });
  }
  return result;
}

export type RecoveredAgentTask = {
  runId: string;
  generationAttempt: number;
  outcome: "RETRYING" | "FAILED" | "CANCELLED";
  code?: "EXPIRED" | "RETRY_EXHAUSTED";
};

export async function recoverExpiredAgentTasks(): Promise<RecoveredAgentTask[]> {
  const cancelled = await rawDb.unsafe<Array<{ run_id: string; generation_attempt: number }>>([
    "UPDATE agent_task_runs SET status = 'CANCELLED', lease_token = NULL, lease_expires_at = NULL,",
    "  finished_at = NOW(), updated_at = NOW(), error_code = 'CANCELLED'",
    "WHERE status = 'CANCEL_REQUESTED' AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())",
    "RETURNING id AS run_id, generation_attempt",
  ].join("\n"));
  const expired = await rawDb.unsafe<Array<{ run_id: string; generation_attempt: number }>>([
    "UPDATE agent_task_runs SET status = 'FAILED', finished_at = NOW(), updated_at = NOW(), error_code = 'EXPIRED'",
    "WHERE status = 'QUEUED' AND expires_at <= NOW()",
    "RETURNING id AS run_id, generation_attempt",
  ].join("\n"));
  const exhausted = await rawDb.unsafe<Array<{ run_id: string; generation_attempt: number }>>([
    "UPDATE agent_task_runs SET status = 'FAILED', lease_token = NULL, lease_expires_at = NULL,",
    "  finished_at = NOW(), updated_at = NOW(), error_code = 'RETRY_EXHAUSTED'",
    "WHERE status = 'RUNNING' AND lease_expires_at <= NOW()",
    "  AND (attempt_count >= max_attempts OR expires_at <= NOW())",
    "RETURNING id AS run_id, generation_attempt",
  ].join("\n"));
  const retrying = await rawDb.unsafe<Array<{ run_id: string; generation_attempt: number }>>([
    "UPDATE agent_task_runs SET status = 'QUEUED', lease_token = NULL, lease_expires_at = NULL,",
    "  next_attempt_at = NOW(), updated_at = NOW(), error_code = 'TIMEOUT'",
    "WHERE status = 'RUNNING' AND lease_expires_at <= NOW()",
    "  AND attempt_count < max_attempts AND expires_at > NOW()",
    "RETURNING id AS run_id, generation_attempt",
  ].join("\n"));
  return [
    ...cancelled.map((row) => ({ runId: row.run_id, generationAttempt: row.generation_attempt, outcome: "CANCELLED" as const })),
    ...expired.map((row) => ({ runId: row.run_id, generationAttempt: row.generation_attempt, outcome: "FAILED" as const, code: "EXPIRED" as const })),
    ...exhausted.map((row) => ({ runId: row.run_id, generationAttempt: row.generation_attempt, outcome: "FAILED" as const, code: "RETRY_EXHAUSTED" as const })),
    ...retrying.map((row) => ({ runId: row.run_id, generationAttempt: row.generation_attempt, outcome: "RETRYING" as const })),
  ];
}

export async function claimNextConversationTask(): Promise<AgentTaskRow | null> {
  const span = getTracer().startSpan("db.agent_task_runs.SELECT", {
    kind: SpanKind.CLIENT,
    attributes: {
      "db.system": "postgresql",
      "db.operation": "SELECT",
      "db.sql.table": "agent_task_runs",
    },
  });
  try {
    const rows = await rawDb.unsafe<Array<{ id: string }>>(
      CLAIM_CONVERSATION_SQL,
      [randomUUID(), agentTaskConfig.leaseSeconds],
    );
    if (!rows[0]) {
      safeSetAttribute(span, "db.outcome", "empty");
      return null;
    }
    const [run] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, rows[0].id)).limit(1);
    safeSetAttribute(span, "db.outcome", run ? "success" : "failure");
    return run ?? null;
  } catch (err) {
    safeSetAttribute(span, "db.outcome", "failure");
    recordSpanError(err);
    throw err;
  } finally {
    span.end();
  }
}

export async function renewTaskLease(runId: string, leaseToken: string): Promise<boolean> {
  const rows = await db.update(agentTaskRuns).set({
    leaseExpiresAt: new Date(Date.now() + agentTaskConfig.leaseSeconds * 1000),
    updatedAt: new Date(),
  }).where(and(
    eq(agentTaskRuns.id, runId),
    eq(agentTaskRuns.leaseToken, leaseToken),
    eq(agentTaskRuns.status, "RUNNING"),
  )).returning({ id: agentTaskRuns.id });
  return rows.length === 1;
}

export async function taskCancellationRequested(runId: string, leaseToken: string): Promise<boolean> {
  const [run] = await db.select({
    status: agentTaskRuns.status,
    leaseToken: agentTaskRuns.leaseToken,
  }).from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).limit(1);
  return !run || run.leaseToken !== leaseToken || run.status === "CANCEL_REQUESTED";
}

export async function loadConversationTaskInput(run: AgentTaskRow) {
  if (!run.threadId || !run.userMessageId) throw new Error("Conversation task references are incomplete");
  const [message] = await db.select().from(chatMessages)
    .where(and(eq(chatMessages.id, run.userMessageId), eq(chatMessages.threadId, run.threadId)))
    .limit(1);
  if (!message || message.role !== "USER") throw new Error("Conversation USER message is unavailable");

  const rows = await db.select({
    role: chatMessages.role,
    redactedSummary: chatMessages.redactedSummary,
    messageSequence: chatMessages.messageSequence,
  }).from(chatMessages)
    .where(and(
      eq(chatMessages.threadId, run.threadId),
      eq(chatMessages.markedSharedByOwner, true),
    ))
    .orderBy(desc(chatMessages.messageSequence))
    .limit(20);
  const history = rows.reverse()
    .filter((row) => row.role === "USER" || row.role === "ASSISTANT")
    .map((row) => ({
      role: row.role as "USER" | "ASSISTANT",
      content: row.redactedSummary?.trim().slice(0, 1000) ?? "",
    }))
    .filter((row) => row.content.length > 0);
  return { question: message.body, history, place: taskPlace(run), intent: run.intent ?? undefined };
}

export async function completeConversationTask(params: {
  ctx: RequestContext;
  run: AgentTaskRow;
  leaseToken: string;
  content: string;
  responseMode: "MODEL" | "SAFE_REFUSAL";
}): Promise<OwnerConversationMessage> {
  if (!params.run.threadId) throw new Error("Conversation task has no thread");
  const span = getTracer().startSpan("db.agent_task_runs.UPDATE", {
    kind: SpanKind.CLIENT,
    attributes: {
      "db.system": "postgresql",
      "db.operation": "UPDATE",
      "db.sql.table": "agent_task_runs",
    },
  });
  try {
    const result = await db.transaction(async (tx) => {
      const [assistant] = await tx.insert(chatMessages).values({
        threadId: params.run.threadId!,
        senderUserId: null,
        role: "ASSISTANT",
        body: params.content,
        markedSharedByOwner: false,
        redactedSummary: null,
      }).returning();
      const [completed] = await tx.update(agentTaskRuns).set({
        status: "COMPLETED",
        assistantMessageId: assistant.id,
        leaseToken: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
        errorCode: null,
      }).where(and(
        eq(agentTaskRuns.id, params.run.id),
        eq(agentTaskRuns.leaseToken, params.leaseToken),
        eq(agentTaskRuns.status, "RUNNING"),
      )).returning();
      if (!completed) throw new LostTaskLeaseError();

      await tx.update(idempotencyRecords).set({
        entityId: params.run.id,
        resultPayload: {
          runId: params.run.id,
          assistantMessageId: assistant.id,
          responseMode: params.responseMode,
        },
      }).where(eq(idempotencyRecords.idempotencyKey, conversationIdempotencyKey(params.run.threadId!, params.run.requestId)));
      await tx.insert(outboxEvents).values({
        eventId: randomUUID(),
        eventType: "AGENT_TASK_COMPLETED",
        payload: { taskId: params.run.id, operation: params.run.operation },
      });
      await recordAudit({
        ctx: params.ctx,
        action: "CHAT_MESSAGE_APPEND",
        actorUserId: params.run.createdByUserId,
        summary: {
          threadId: params.run.threadId!,
          messageId: assistant.id,
          role: "ASSISTANT",
          responseMode: params.responseMode,
        },
        tx,
      });
      await recordAudit({
        ctx: params.ctx,
        action: "AGENT_TASK",
        actorUserId: params.run.createdByUserId,
        summary: { taskId: params.run.id, operation: params.run.operation, status: "COMPLETED" },
        tx,
      });
      return toOwnerMessage(assistant);
    });
    safeSetAttribute(span, "db.outcome", "success");
    return result;
  } catch (err) {
    safeSetAttribute(span, "db.outcome", "failure");
    recordSpanError(err);
    throw err;
  } finally {
    span.end();
  }
}

export async function finishCancelledTask(runId: string, leaseToken: string): Promise<boolean> {
  const rows = await db.update(agentTaskRuns).set({
    status: "CANCELLED",
    leaseToken: null,
    leaseExpiresAt: null,
    finishedAt: new Date(),
    updatedAt: new Date(),
    errorCode: "CANCELLED",
  }).where(and(
    eq(agentTaskRuns.id, runId),
    eq(agentTaskRuns.leaseToken, leaseToken),
    eq(agentTaskRuns.status, "CANCEL_REQUESTED"),
  )).returning({ id: agentTaskRuns.id });
  return rows.length === 1;
}

export async function failOrRetryTask(params: {
  run: AgentTaskRow;
  leaseToken: string;
  code: string;
  retryable: boolean;
}): Promise<"RETRYING" | "FAILED" | "LOST"> {
  const canRetry = params.retryable && params.run.attemptCount < params.run.maxAttempts;
  const delayMs = Math.min(8_000, 500 * 2 ** Math.max(0, params.run.attemptCount - 1));
  const rows = await db.update(agentTaskRuns).set(canRetry ? {
    status: "QUEUED",
    leaseToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: new Date(Date.now() + delayMs),
    updatedAt: new Date(),
    errorCode: params.code,
  } : {
    status: "FAILED",
    leaseToken: null,
    leaseExpiresAt: null,
    finishedAt: new Date(),
    updatedAt: new Date(),
    errorCode: params.code,
  }).where(and(
    eq(agentTaskRuns.id, params.run.id),
    eq(agentTaskRuns.leaseToken, params.leaseToken),
    eq(agentTaskRuns.status, "RUNNING"),
  )).returning({ id: agentTaskRuns.id });
  if (rows.length === 0) return "LOST";
  return canRetry ? "RETRYING" : "FAILED";
}

function acceptedResponse(run: AgentTaskRow, userMessage: OwnerConversationMessage): ConversationTurnAcceptedResponse {
  return conversationTurnAcceptedResponseSchema.parse({
    threadId: run.threadId,
    runId: run.id,
    operation: "CONVERSATION",
    status: "QUEUED",
    generationAttempt: 0,
    userMessage,
  });
}

async function loadAcceptedConversationTask(
  threadId: string,
  ownerUserId: string,
  requestId: string,
): Promise<ConversationTurnAcceptedResponse | null> {
  const [run] = await db.select().from(agentTaskRuns).where(and(
    eq(agentTaskRuns.threadId, threadId),
    eq(agentTaskRuns.requestId, requestId),
    eq(agentTaskRuns.createdByUserId, ownerUserId),
  )).limit(1);
  if (!run?.userMessageId) return null;
  const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, run.userMessageId)).limit(1);
  return message ? acceptedResponse(run, toOwnerMessage(message)) : null;
}

async function requireThreadOwner(tx: Tx, threadId: string, ownerUserId: string) {
  // Delegates to the shared helper that enforces both ownership AND
  // trip membership in a single transaction.  Returns the locked row
  // so callers can persist server-derived trip_id onto related rows.
  return await requireOwnedTripThread(tx, threadId, ownerUserId);
}

function toOwnerMessage(row: typeof chatMessages.$inferSelect): OwnerConversationMessage {
  return {
    id: row.id,
    role: row.role as "USER" | "ASSISTANT",
    content: row.body,
    sequence: row.messageSequence,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRunResponse(run: AgentTaskRow): AgentRunResponse {
  return agentRunResponseSchema.parse({
    runId: run.id,
    operation: run.operation,
    status: run.status,
    generationAttempt: run.generationAttempt,
    attemptCount: run.attemptCount,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    errorCode: run.errorCode,
    assistantMessageId: run.assistantMessageId,
    resultPlanId: run.resultPlanId,
  });
}

function placeColumns(place: ConversationPlace | undefined) {
  return place ? {
    placeSourceId: place.sourceId ?? null,
    placeName: place.name,
    placeLatitude: place.latitude,
    placeLongitude: place.longitude,
    placeSourceType: place.sourceType,
  } : {};
}

function taskPlace(run: AgentTaskRow): ConversationPlace | undefined {
  if (
    run.placeName === null
    || run.placeLatitude === null
    || run.placeLongitude === null
    || (run.placeSourceType !== "REFERENCE" && run.placeSourceType !== "INSPIRATION")
  ) return undefined;
  return {
    ...(run.placeSourceId ? { sourceId: run.placeSourceId } : {}),
    name: run.placeName,
    latitude: run.placeLatitude,
    longitude: run.placeLongitude,
    sourceType: run.placeSourceType,
  };
}

function conversationIdempotencyKey(threadId: string, requestId: string) {
  return "chat_turn:" + threadId + ":" + requestId;
}
