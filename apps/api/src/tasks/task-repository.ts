import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { SpanKind } from "@opentelemetry/api";

import { db, rawDb } from "../db/database.js";
import {
  agentTaskRuns,
  chatMessages,
  chatThreads,
  idempotencyRecords,
  outboxEvents,
  personalResearchRequests,
  tripMembers,
} from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { resolveConversationPlace } from "../policy/conversation-safety.js";
import { recordAudit } from "../services/audit-service.js";
import { requireOwnedTripThread } from "../services/chat-thread-service.js";
import { claimIdempotency } from "../services/idempotency-service.js";
import {
  agentRunErrorCodeSchema,
  agentRunResponseSchema,
  conversationTurnAcceptedResponseSchema,
  persistedResearchIntentDraftSchema,
  personalResearchOwnerDraftSchema,
  researchIntentStateSchema,
  type AgentRunResponse,
  type ConversationPlace,
  type ConversationTurnAcceptedResponse,
  type ConversationTurnRequest,
  type OwnerConversationMessage,
} from "../types/schemas.js";
import type { PersonalResearchOperationCapability } from "../config/personal-research-allowed-capabilities.js";
import type { HotelOfferProviderName } from "../providers/types.js";
import type { z } from "zod";
import { resolvePersistedHotelProviderName } from "../providers/live-provider-factory.js";
import { loadActiveQuoteNationality } from "../services/stay-search-provider-authorization.js";
import type { RequestContext } from "../utils/context.js";
import {
  getTracer,
  parseTraceparent,
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
 * Worker. `correlationId` and `traceId` are carried over verbatim so Worker
 * log lines join the API log lines for the same PLAN. When the column is
 * `null` (old rows, recovery, or background replay), `correlationId` falls
 * back to a freshly-minted UUID and the trace fields stay unset, so
 * `correlationChild` binds the Worker's own active span instead.
 */
export function ctxFromRun(run: AgentTaskRow): RequestContext {
  const tc = run.traceContext ?? null;
  const parsed = tc?.traceparent ? parseTraceparent(tc.traceparent) : null;
  // The W3C trace id of the originating HTTP request is what makes
  // `jq 'select(.trace_id == "<id>")'` return API *and* Worker lines for one
  // PLAN. Minting a fresh UUID here would put an id in `trace_id` that
  // matches neither the API log thread nor any span, so we reuse the
  // persisted one. `spanId` is deliberately left unset: `correlationChild`
  // then reads the *active* Worker span, so `span_id` always identifies the
  // Worker's own unit of work rather than the already-ended HTTP span.
  const ctx: RequestContext = {
    correlationId: tc?.correlationId ?? randomUUID(),
    actorUserId: run.createdByUserId,
  };
  if (parsed) ctx.traceId = parsed.traceId;
  if (tc?.traceparent) ctx.traceparent = tc.traceparent;
  if (tc?.tracestate) ctx.tracestate = tc.tracestate;
  return ctx;
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

const CLAIM_PLANNING_SQL = CLAIM_CONVERSATION_SQL
  .replace("operation = 'CONVERSATION'", "operation IN ('PLAN', 'REPLAN', 'RESEARCH', 'PERSONAL_RESEARCH')");

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
        // Pin the upper message-sequence boundary to the just-inserted
        // USER row's identity value so a retry can never widen the window
        // into messages appended after acceptance.  See
        // docs/thread-context-memory-implementation.md §4.1 and §1.6.
        contextMaxMessageSequence: userMessage.messageSequence,
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
      // The acceptance-time boundary MUST be a positive integer (the
      // USER row's identity-generated `message_sequence`). Anything else
      // is a schema/replication regression and would silently widen the
      // context window for retries.
      if (typeof run.contextMaxMessageSequence !== "number"
        || !Number.isInteger(run.contextMaxMessageSequence)
        || run.contextMaxMessageSequence <= 0) {
        throw new ApiError(500, "Internal Server Error", "Conversation task missing contextMaxMessageSequence");
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

/** Accept a Shared PLAN/REPLAN run.  The route has already frozen the
 * snapshot; this transaction persists only server-derived authority. */
export async function acceptPlanningTask(params: {
  ctx: RequestContext;
  tripId: string;
  userId: string;
  snapshotId: string;
  flightSearchPreferencesVersion: number;
  staySearchPreferencesVersion?: number;
  /**
   * Hotel provider bound to this task. Persisted from the resolved
   * `HOTEL_PROVIDER` env value at acceptance; never re-read mid-run
   * and never mutated by a later env reload. `null` when no real
   * adapter is configured (e.g. `disabled`, or `nuitee` before the
   * adapter ships in Phase C), or when the task simply does not
   * require hotel capability. Spec §3.1.
   */
  hotelProvider?: HotelOfferProviderName | null;
  originatingIntentRunId?: string;
  operation: "PLAN" | "REPLAN";
  requestId: string;
  tx?: Tx;
}): Promise<{ runId: string; operation: "PLAN" | "REPLAN"; status: "QUEUED"; generationAttempt: 0 }> {
  const runId = randomUUID();
  const expiresAt = new Date(Date.now() + agentTaskConfig.queueTtlSeconds * 1000);
  const hotelProvider = params.hotelProvider === undefined
    ? resolvePersistedHotelProviderName()
    : params.hotelProvider;
  const quoteAuthorization = hotelProvider === "nuitee_connect"
    ? await loadActiveQuoteNationality({ tripId: params.tripId, memberId: params.userId })
    : null;
  if (hotelProvider === "nuitee_connect" && !quoteAuthorization) {
    throw new ApiError(422, "Unprocessable Entity", "A confirmed Nuitee hotel quote nationality is required");
  }
  const accept = async (tx: Tx) => {
    const [active] = await tx.select({ id: agentTaskRuns.id }).from(agentTaskRuns).where(and(
      eq(agentTaskRuns.tripId, params.tripId),
      inArray(agentTaskRuns.status, ["QUEUED", "RUNNING", "CANCEL_REQUESTED"]),
    )).limit(1);
    if (active) {
      if (params.operation !== "REPLAN") {
        throw new ApiError(409, "Conflict", "This trip already has an active planning run");
      }
      // A new change-driven replan supersedes an older planning round. The
      // old Worker may still be in an upstream call, but its final guarded
      // transaction requires RUNNING plus its lease, so it cannot activate a
      // plan after this durable revocation.
      await tx.update(agentTaskRuns).set({
        status: "CANCELLED",
        cancelRequestedAt: new Date(),
        finishedAt: new Date(),
        updatedAt: new Date(),
        errorCode: "CANCELLED",
      }).where(and(
        eq(agentTaskRuns.id, active.id),
        inArray(agentTaskRuns.status, ["QUEUED", "RUNNING", "CANCEL_REQUESTED"]),
      ));
    }
    const [run] = await tx.insert(agentTaskRuns).values({
      id: runId,
      operation: params.operation,
      status: "QUEUED",
      createdByUserId: params.userId,
      tripId: params.tripId,
      snapshotId: params.snapshotId,
      flightSearchPreferencesVersion: params.flightSearchPreferencesVersion,
      staySearchPreferencesVersion: params.staySearchPreferencesVersion ?? null,
      hotelProvider,
      hotelQuoteNationalityAuthorizationId: quoteAuthorization?.id ?? null,
      hotelQuoteNationalityAuthorizationVersion: quoteAuthorization?.version ?? null,
      requestId: params.requestId,
      expiresAt,
      traceContext: buildTraceContextForTask(params.ctx),
    }).returning();
    await tx.insert(outboxEvents).values({
      eventId: randomUUID(), eventType: "AGENT_TASK_QUEUED",
      payload: { taskId: run.id, operation: run.operation },
    });
    await recordAudit({
      ctx: params.ctx, action: "AGENT_TASK", actorUserId: params.userId, tripId: params.tripId,
      summary: { taskId: run.id, operation: run.operation, status: run.status }, tx,
    });
    return { runId: run.id, operation: params.operation, status: "QUEUED" as const, generationAttempt: 0 as const };
  };
  return params.tx ? accept(params.tx) : db.transaction(accept);
}

/**
 * Phase 2 — accept a Personal Trip Orchestrator RESEARCH command.
 *
 * Mirrors `acceptPlanningTask` for the trip-scoped RESEARCH operation. The
 * caller (the research route) is the only authority; chat content and
 * `requestedCapabilities` are written verbatim so the Worker can read
 * `run.requestedCapabilities` later without re-querying the chat. The
 * idempotency contract is `agent_task_runs_trip_request_unique` — if the
 * same `(tripId, requestId)` already exists, the existing 202 envelope is
 * returned unchanged so the route can satisfy spec §4.2's "same requestId
 * returns the same result" invariant.
 */
export async function acceptResearchTask(params: {
  ctx: RequestContext;
  tripId: string;
  userId: string;
  snapshotId: string;
  flightSearchPreferencesVersion?: number;
  staySearchPreferencesVersion?: number;
  outputMode: "RESEARCH_ONLY" | "PROPOSE_PLAN";
  requestedCapabilities: readonly string[];
  /** See `acceptPlanningTask.hotelProvider`. */
  hotelProvider?: HotelOfferProviderName | null;
  originatingIntentRunId?: string;
  requestId: string;
  tx?: Tx;
}): Promise<{
  runId: string;
  operation: "RESEARCH";
  status: "QUEUED";
  generationAttempt: 0;
  snapshotId: string;
}> {
  const runId = randomUUID();
  const expiresAt = new Date(Date.now() + agentTaskConfig.queueTtlSeconds * 1000);
  const hotelProvider = params.hotelProvider === undefined
    ? resolvePersistedHotelProviderName()
    : params.hotelProvider;
  const quoteAuthorization = hotelProvider === "nuitee_connect"
    ? await loadActiveQuoteNationality({ tripId: params.tripId, memberId: params.userId })
    : null;
  if (hotelProvider === "nuitee_connect" && !quoteAuthorization) {
    throw new ApiError(422, "Unprocessable Entity", "A confirmed Nuitee hotel quote nationality is required");
  }
  const accept = async (tx: Tx) => {
    // Idempotency: the partial unique index `(tripId, requestId)` makes a
    // second insert a hard error. Catch the constraint violation and return
    // the existing envelope so the route stays a pure 202 responder.
    const [existing] = await tx.select().from(agentTaskRuns).where(and(
      eq(agentTaskRuns.tripId, params.tripId),
      eq(agentTaskRuns.requestId, params.requestId),
    )).limit(1);
    if (existing) {
      return {
        runId: existing.id,
        operation: "RESEARCH" as const,
        status: "QUEUED" as const,
        generationAttempt: 0 as const,
        snapshotId: existing.snapshotId ?? params.snapshotId,
      };
    }

    // Mirrors acceptPlanningTask: PLAN/REPLAN/RESEARCH share one active slot
    // per trip (the `agent_task_runs_one_active_planning` partial unique
    // index), so a second concurrent request must fail closed with 409
    // rather than surface the raw constraint violation as a 500.
    const [active] = await tx.select({ id: agentTaskRuns.id }).from(agentTaskRuns).where(and(
      eq(agentTaskRuns.tripId, params.tripId),
      inArray(agentTaskRuns.status, ["QUEUED", "RUNNING", "CANCEL_REQUESTED"]),
    )).limit(1);
    if (active) {
      throw new ApiError(409, "Conflict", "This trip already has an active planning run");
    }

    const [run] = await tx.insert(agentTaskRuns).values({
      id: runId,
      operation: "RESEARCH",
      status: "QUEUED",
      createdByUserId: params.userId,
      tripId: params.tripId,
      snapshotId: params.snapshotId,
      flightSearchPreferencesVersion: params.flightSearchPreferencesVersion,
      staySearchPreferencesVersion: params.staySearchPreferencesVersion ?? null,
      hotelProvider,
      hotelQuoteNationalityAuthorizationId: quoteAuthorization?.id ?? null,
      hotelQuoteNationalityAuthorizationVersion: quoteAuthorization?.version ?? null,
      requestId: params.requestId,
      researchMode: params.outputMode,
      requestedCapabilities: params.requestedCapabilities as string[],
      originatingIntentRunId: params.originatingIntentRunId ?? null,
      expiresAt,
      traceContext: buildTraceContextForTask(params.ctx),
    }).returning();

    await tx.insert(outboxEvents).values({
      eventId: randomUUID(),
      eventType: "AGENT_TASK_QUEUED",
      payload: { taskId: run.id, operation: run.operation },
    });

    await recordAudit({
      ctx: params.ctx,
      action: "RESEARCH_COMMAND_ACCEPTED",
      actorUserId: params.userId,
      tripId: params.tripId,
      summary: {
        taskId: run.id,
        operation: run.operation,
        outputMode: params.outputMode,
        capabilities: params.requestedCapabilities.length,
      },
      tx,
    });
    await recordAudit({
      ctx: params.ctx,
      action: "AGENT_TASK",
      actorUserId: params.userId,
      tripId: params.tripId,
      summary: { taskId: run.id, operation: run.operation, status: run.status },
      tx,
    });

    return {
      runId: run.id,
      operation: "RESEARCH" as const,
      status: "QUEUED" as const,
      generationAttempt: 0 as const,
      snapshotId: run.snapshotId ?? params.snapshotId,
    };
  };
  return params.tx ? accept(params.tx) : db.transaction(accept);
}

/**
 * Read the existing durable RESEARCH command while the caller holds the Trip
 * row lock.  Keeping this probe separate from snapshot creation prevents an
 * idempotent retry from allocating a snapshot that no task can reference.
 */
export async function findResearchTaskByRequestId(params: {
  tripId: string;
  requestId: string;
  tx: Tx;
}): Promise<{
  runId: string;
  operation: "RESEARCH";
  status: "QUEUED";
  generationAttempt: 0;
  snapshotId: string;
} | null> {
  const [existing] = await params.tx.select().from(agentTaskRuns).where(and(
    eq(agentTaskRuns.tripId, params.tripId),
    eq(agentTaskRuns.requestId, params.requestId),
  )).limit(1);
  if (!existing || existing.operation !== "RESEARCH" || !existing.snapshotId) return null;
  return {
    runId: existing.id,
    operation: "RESEARCH",
    status: "QUEUED",
    generationAttempt: 0,
    snapshotId: existing.snapshotId,
  };
}

/**
 * DRAFT Personal Research — accept a confirmed owner-only research command.
 *
 * Mirrors `acceptResearchTask` but explicitly drops every snapshot-bound
 * invariant: there is no `snapshotId`, no preference versions, no
 * `constraint_snapshot` is created, no `providerOffers` row is written.
 * The capability is stored as a single-element `requestedCapabilities` JSONB
 * array so the dispatcher / `requirePersonalResearchAuthority` and the
 * `personal_research_evidence` row can read it without a new column.
 *
 * The new partial unique index
 *   `agent_task_runs_personal_research_owner_request_unique`
 * enforces idempotency at the DB layer; we still probe first to avoid
 * surfacing the constraint violation as a 500.
 *
 * Source: docs/draft-personal-research-implementation.md §3.2, §3.3.
 */
export async function acceptPersonalResearchTask(params: {
  ctx: RequestContext;
  tripId: string;
  threadId: string;
  ownerUserId: string;
  requestId: string;
  capability: PersonalResearchOperationCapability;
  input: z.infer<typeof personalResearchOwnerDraftSchema>;
  originatingIntentRunId?: string;
  tx?: Tx;
}): Promise<{
  runId: string;
  capability: PersonalResearchOperationCapability;
  status: "QUEUED";
  generationAttempt: 0;
}> {
  const runId = randomUUID();
  const expiresAt = new Date(Date.now() + agentTaskConfig.queueTtlSeconds * 1000);
  const accept = async (tx: Tx) => {
    const [existing] = await tx.select().from(agentTaskRuns).where(and(
      eq(agentTaskRuns.createdByUserId, params.ownerUserId),
      eq(agentTaskRuns.requestId, params.requestId),
      eq(agentTaskRuns.operation, "PERSONAL_RESEARCH"),
    )).limit(1);
    if (existing) {
      const existingCapability = (existing.requestedCapabilities ?? [])[0] as
        | PersonalResearchOperationCapability
        | undefined;
      return {
        runId: existing.id,
        capability: existingCapability ?? params.capability,
        status: "QUEUED" as const,
        generationAttempt: 0 as const,
      };
    }

    // Owner is the creator; double-check the trip binding is consistent with
    // the locked thread row.
    const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, params.threadId)).limit(1);
    if (!thread) throw new ApiError(404, "Not Found", "Thread not found");
    if (thread.tripId !== params.tripId) {
      throw new ApiError(409, "Conflict", "Thread is not bound to the supplied trip");
    }
    if (thread.ownerUserId !== params.ownerUserId) {
      throw new ApiError(403, "Forbidden", "Thread is not owned by the caller");
    }
    const [member] = await tx.select({ userId: tripMembers.userId }).from(tripMembers).where(and(
      eq(tripMembers.tripId, params.tripId), eq(tripMembers.userId, params.ownerUserId),
    )).limit(1);
    if (!member) throw new ApiError(403, "Forbidden", "Caller is not an active trip member");

    // Supersede the originating CONVERSATION run so the thread's
    // `agent_task_runs_one_active_conversation` partial unique index
    // releases the slot for the new PERSONAL_RESEARCH row. The
    // CONVERSATION row's draft was already lifted into the new typed draft
    // by the earlier PUT, so we only need to flip state + finished_at.
    if (params.originatingIntentRunId) {
      await tx.update(agentTaskRuns).set({
        status: "COMPLETED",
        researchIntentState: "CONFIRMED",
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(agentTaskRuns.id, params.originatingIntentRunId),
        eq(agentTaskRuns.createdByUserId, params.ownerUserId),
        eq(agentTaskRuns.operation, "CONVERSATION"),
      ));
    }

    const [run] = await tx.insert(agentTaskRuns).values({
      id: runId,
      operation: "PERSONAL_RESEARCH",
      status: "QUEUED",
      createdByUserId: params.ownerUserId,
      threadId: params.threadId,
      tripId: params.tripId,
      snapshotId: null,
      flightSearchPreferencesVersion: null,
      staySearchPreferencesVersion: null,
      hotelProvider: null,
      hotelQuoteNationalityAuthorizationId: null,
      hotelQuoteNationalityAuthorizationVersion: null,
      requestId: params.requestId,
      userMessageId: null,
      // The capability is the single dispatch key for this run; we use the
      // existing JSONB column rather than introducing a new typed column.
      requestedCapabilities: [params.capability],
      originatingIntentRunId: params.originatingIntentRunId ?? null,
      // Personal runs do NOT extend the trip's planning lifecycle; we deliberately
      // skip `pinnedSessionId` writes here. Spec §3.4 forbids Personal evidence
      // from reaching Shared surfaces.
      expiresAt,
      traceContext: buildTraceContextForTask(params.ctx),
    }).returning();

    // The request is an immutable, task-owned copy of the exact Zod-validated
    // payload confirmed by the owner. The Worker must never re-read the
    // originating conversation draft, which can otherwise race with a later
    // browser edit.
    const inputJson = params.input as unknown as Record<string, unknown>;
    await tx.insert(personalResearchRequests).values({
      runId: run.id,
      originatingIntentRunId: params.originatingIntentRunId ?? run.id,
      capability: params.capability,
      inputJson,
      inputHash: createHash("sha256").update(JSON.stringify(inputJson)).digest("hex"),
      version: 1,
    });

    await tx.insert(outboxEvents).values({
      eventId: randomUUID(),
      eventType: "AGENT_TASK_QUEUED",
      payload: { taskId: run.id, operation: run.operation, capability: params.capability },
    });
    await recordAudit({
      ctx: params.ctx,
      action: "PERSONAL_RESEARCH_COMMAND_ACCEPTED",
      actorUserId: params.ownerUserId,
      tripId: params.tripId,
      summary: {
        taskId: run.id,
        capability: params.capability,
        threadId: params.threadId,
      },
      tx,
    });
    await recordAudit({
      ctx: params.ctx,
      action: "AGENT_TASK",
      actorUserId: params.ownerUserId,
      tripId: params.tripId,
      summary: { taskId: run.id, operation: run.operation, status: run.status },
      tx,
    });

    return {
      runId: run.id,
      capability: params.capability,
      status: "QUEUED" as const,
      generationAttempt: 0 as const,
    };
  };
  return params.tx ? accept(params.tx) : db.transaction(accept);
}

/**
 * Idempotent probe paired with `acceptPersonalResearchTask`. Mirrors
 * `findResearchTaskByRequestId` but keys by owner (creator) + requestId +
 * operation, since PERSONAL_RESEARCH never carries a tripId/snapshotId pair
 * we can rely on.
 */
export async function findPersonalResearchTaskByRequestId(params: {
  ownerUserId: string;
  requestId: string;
  tx: Tx;
}): Promise<{
  runId: string;
  capability: PersonalResearchOperationCapability;
  status: "QUEUED";
} | null> {
  const [existing] = await params.tx.select().from(agentTaskRuns).where(and(
    eq(agentTaskRuns.createdByUserId, params.ownerUserId),
    eq(agentTaskRuns.requestId, params.requestId),
    eq(agentTaskRuns.operation, "PERSONAL_RESEARCH"),
  )).limit(1);
  if (!existing) return null;
  const capability = (existing.requestedCapabilities ?? [])[0] as
    | PersonalResearchOperationCapability
    | undefined;
  if (!capability) return null;
  return { runId: existing.id, capability, status: "QUEUED" };
}

/**
 * Lease-guarded terminal write. AVAILABLE → COMPLETED, UNAVAILABLE →
 * COMPLETED_WITH_GAPS. Mirrors `completeResearchTask` but writes no plan id
 * (PERSONAL_RESEARCH has no `resultPlanId`). The `evidenceId` is recorded in
 * the audit summary so the operator can correlate the terminal row with
 * the projection stored in `personal_research_evidence`.
 */
export async function completePersonalResearchTask(params: {
  ctx: RequestContext;
  run: AgentTaskRow;
  leaseToken: string | undefined;
  outcome: "AVAILABLE" | "UNAVAILABLE";
  evidenceId: string;
}): Promise<void> {
  const nextStatus = params.outcome === "AVAILABLE" ? "COMPLETED" : "COMPLETED_WITH_GAPS";
  const result = await db.transaction(async (tx) => {
    const updated = await tx.update(agentTaskRuns).set({
      status: nextStatus,
      finishedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: null,
      updatedAt: new Date(),
    }).where(and(
      eq(agentTaskRuns.id, params.run.id),
      eq(agentTaskRuns.operation, "PERSONAL_RESEARCH"),
      eq(agentTaskRuns.leaseToken, params.leaseToken ?? "__no_lease__"),
      eq(agentTaskRuns.status, "RUNNING"),
    )).returning({ id: agentTaskRuns.id });
    if (updated.length === 0) throw new LostTaskLeaseError();
    return updated[0];
  });

  await db.insert(outboxEvents).values({
    eventId: randomUUID(),
    eventType: "AGENT_TASK_COMPLETED",
    payload: { taskId: result.id, operation: "PERSONAL_RESEARCH", outcome: params.outcome },
  });
  await recordAudit({
    ctx: params.ctx,
    action: "PERSONAL_RESEARCH_COMPLETED",
    actorUserId: params.run.createdByUserId,
    tripId: params.run.tripId ?? undefined,
    summary: {
      taskId: result.id,
      outcome: params.outcome,
      evidenceId: params.evidenceId,
      capability: (params.run.requestedCapabilities ?? [])[0] ?? null,
    },
  });
  await publishAgentStreamEvent({
    event: "turn.completed",
    runId: result.id,
    generationAttempt: params.run.generationAttempt,
  });
}

/**
 * Lease-guarded failure write. Mirrors `failOrRetryTask`'s retry decision:
 * retryable + under cap → status QUEUED, lease cleared, exponential
 * `nextAttemptAt`; otherwise FAILED. Only the PERSONAL_RESEARCH branch is
 * exercised here.
 */
export async function failPersonalResearchTask(params: {
  ctx: RequestContext;
  run: AgentTaskRow;
  leaseToken: string | undefined;
  code: z.infer<typeof agentRunErrorCodeSchema>;
}): Promise<"RETRYING" | "FAILED"> {
  const RETRYABLE: ReadonlySet<z.infer<typeof agentRunErrorCodeSchema>> = new Set([
    "NETWORK", "UPSTREAM_5XX", "UPSTREAM_FAILURE", "TIMEOUT", "SCHEMA_PARSE",
    "SEARCH_PREFERENCES_STALE", "PLANNING_DATA_UNAVAILABLE",
  ]);
  const retryable = RETRYABLE.has(params.code);
  const attemptCount = params.run.attemptCount + 1;
  if (retryable && attemptCount < params.run.maxAttempts) {
    const backoff = calculateRetryDelayMs(params.run.generationAttempt);
    const nextAttemptAt = new Date(Date.now() + backoff);
    const result = await db.transaction(async (tx) => {
      const updated = await tx.update(agentTaskRuns).set({
        status: "QUEUED",
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode: params.code,
        attemptCount,
        nextAttemptAt,
        updatedAt: new Date(),
      }).where(and(
        eq(agentTaskRuns.id, params.run.id),
        eq(agentTaskRuns.operation, "PERSONAL_RESEARCH"),
        eq(agentTaskRuns.leaseToken, params.leaseToken ?? "__no_lease__"),
        eq(agentTaskRuns.status, "RUNNING"),
      )).returning({ id: agentTaskRuns.id });
      if (updated.length === 0) throw new LostTaskLeaseError();
      return updated[0];
    });
    await publishAgentStreamEvent({
      event: "turn.failed",
      runId: result.id,
      generationAttempt: params.run.generationAttempt,
      code: params.code,
      retryable: true,
    });
    return "RETRYING";
  }
  const result = await db.transaction(async (tx) => {
    const updated = await tx.update(agentTaskRuns).set({
      status: "FAILED",
      finishedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: params.code,
      attemptCount,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(agentTaskRuns.id, params.run.id),
      eq(agentTaskRuns.operation, "PERSONAL_RESEARCH"),
      eq(agentTaskRuns.leaseToken, params.leaseToken ?? "__no_lease__"),
      eq(agentTaskRuns.status, "RUNNING"),
    )).returning({ id: agentTaskRuns.id });
    if (updated.length === 0) throw new LostTaskLeaseError();
    return updated[0];
  });
  await db.insert(outboxEvents).values({
    eventId: randomUUID(),
    eventType: "AGENT_TASK_FAILED",
    payload: { taskId: result.id, operation: "PERSONAL_RESEARCH", code: params.code },
  });
  await publishAgentStreamEvent({
    event: "turn.failed",
    runId: result.id,
    generationAttempt: params.run.generationAttempt,
    code: params.code,
    retryable: false,
  });
  return "FAILED";
}

export async function getAuthorizedAgentRun(runId: string, userId: string): Promise<AgentRunResponse> {
  const [run] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).limit(1);
  if (!run) throw new ApiError(404, "Not Found", "Agent run not found");
  await requireRunAccess(run, userId);
  // Setup session projection removed with the conversational setup pipeline
  // (migration 0049). The LLM tool loop (Phase 4) surfaces state via chat.
  return toRunResponse(run);
}

/**
 * Returns the most recent Shared planning task visible to a current trip
 * member. This is a recovery read for the Web workspace: the durable task
 * remains authoritative across refreshes and is never reconstructed from
 * browser state.
 */
export async function getLatestAuthorizedPlanningRun(tripId: string, userId: string): Promise<AgentRunResponse | null> {
  const [member] = await db.select({ userId: tripMembers.userId }).from(tripMembers).where(and(
    eq(tripMembers.tripId, tripId), eq(tripMembers.userId, userId),
  )).limit(1);
  if (!member) throw new ApiError(403, "Forbidden", "Not authorized for this planning run");
  const [run] = await db.select().from(agentTaskRuns).where(and(
    eq(agentTaskRuns.tripId, tripId), inArray(agentTaskRuns.operation, ["PLAN", "REPLAN"]),
  )).orderBy(desc(agentTaskRuns.createdAt)).limit(1);
  return run ? toRunResponse(run) : null;
}

export async function requestAgentTaskCancellation(params: {
  ctx: RequestContext;
  runId: string;
  userId: string;
}): Promise<AgentRunResponse> {
  const result = await db.transaction(async (tx) => {
    const [run] = await tx.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, params.runId)).limit(1);
    if (!run) throw new ApiError(404, "Not Found", "Agent run not found");
    await requireRunAccess(run, params.userId, tx);
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

// ─── Personal Research Intent Draft (Phase 0) ───────────────────────────────
// Non-executable persisted drafts. The lifecycle is PROPOSED →
// {DISMISSED, CONFIRMED, SUPERSEDED}. All four writes below are
// lease-guarded; the `WHERE` clause carries `lease_token = $X AND
// status = 'RUNNING'` so a worker that has lost the lease cannot mutate
// state out from under the next claim. See
// docs/personal-research-intent-routing-implementation.md §4.1, §7 Phase 0.

export type ResearchIntentState = "PROPOSED" | "DISMISSED" | "CONFIRMED" | "SUPERSEDED";

export type PersistedResearchIntentDraft = {
  schemaVersion: 1;
  kind: "RESEARCH_ONLY" | "PROPOSE_PLAN";
  requestedCapabilities: Array<
    "flight" | "accommodation" | "hotel" | "activities" |
    "places" | "navigation" | "mobility" | "readiness"
  >;
  classifierVersion: string;
  readiness: "READY" | "READY_WITH_WARNINGS" | "NEEDS_SETUP" | "NEEDS_PLACE_SELECTION";
  /** Hard blockers — research cannot start until these are resolved. */
  blockers: Array<
    "TRIP_NOT_ACTIVE" | "DESTINATION_NOT_CONFIGURED" | "DATES_MISSING" |
    "FLIGHT_PREFERENCES_MISSING" | "STAY_PREFERENCES_MISSING" |
    "HOTEL_PROVIDER_NOT_APPROVED" | "QUOTE_NATIONALITY_AUTHORIZATION_MISSING" |
    "ROUTE_ENDPOINTS_UNCONFIRMED" | "MODE_NOT_CHOSEN" |
    "BUDGET_HINT_MISSING"
  >;
  /** Soft warnings — research can start, but quality may degrade. */
  warnings: Array<
    "TRIP_NOT_ACTIVE" | "DESTINATION_NOT_CONFIGURED" | "DATES_MISSING" |
    "FLIGHT_PREFERENCES_MISSING" | "STAY_PREFERENCES_MISSING" |
    "HOTEL_PROVIDER_NOT_APPROVED" | "QUOTE_NATIONALITY_AUTHORIZATION_MISSING" |
    "ROUTE_ENDPOINTS_UNCONFIRMED" | "MODE_NOT_CHOSEN" |
    "BUDGET_HINT_MISSING"
  >;
  /** Union of `blockers ∪ warnings`. Retained for backward compatibility
   *  with older clients that still read `missing[]` directly. */
  missing: Array<
    "TRIP_NOT_ACTIVE" | "DESTINATION_NOT_CONFIGURED" | "DATES_MISSING" |
    "FLIGHT_PREFERENCES_MISSING" | "STAY_PREFERENCES_MISSING" |
    "HOTEL_PROVIDER_NOT_APPROVED" | "QUOTE_NATIONALITY_AUTHORIZATION_MISSING" |
    "ROUTE_ENDPOINTS_UNCONFIRMED" | "MODE_NOT_CHOSEN" |
    "BUDGET_HINT_MISSING"
  >;
  /** Quick orchestration — proactive intro marker. When true, the
   *  conversation worker bypasses the classifier + LLM path and renders
   *  the locale-aware greeting template. Strict optional so legacy
   *  drafts (which never had this marker) still parse. */
  proactiveIntro?: true;
};

/**
 * Persist (or supersede-existing-then-persist) the draft on the worker-held
 * RUNNING lease. Returns the new draft, or `null` if the lease was lost —
 * the caller must abandon the proposal branch in that case rather than
 * silently fall back to the LLM path.
 */
export async function persistResearchIntentDraft(params: {
  runId: string;
  leaseToken: string;
  draft: PersistedResearchIntentDraft;
  tx?: Tx;
}): Promise<PersistedResearchIntentDraft | null> {
  // Defensive Zod parse so an upstream bug never lets free text into JSONB.
  const draft = persistedResearchIntentDraftSchema.parse(params.draft);
  const dbHandle = params.tx ?? db;
  const updated = await dbHandle.update(agentTaskRuns)
    .set({
      researchIntentDraft: draft,
      researchIntentState: "PROPOSED",
      updatedAt: new Date(),
    })
    .where(and(
      eq(agentTaskRuns.id, params.runId),
      eq(agentTaskRuns.leaseToken, params.leaseToken),
      eq(agentTaskRuns.status, "RUNNING"),
    ))
    .returning({ id: agentTaskRuns.id });
  return updated.length === 1 ? draft : null;
}

/**
 * Move the draft through its lifecycle under a from-state guard. Returns
 * `true` on transition, `false` if the row was missing or already in a
 * different state (caller maps to 409).
 */
export async function transitionResearchIntentState(params: {
  runId: string;
  fromState: ResearchIntentState;
  toState: ResearchIntentState;
  leaseToken?: string;
  tx?: Tx;
}): Promise<boolean> {
  const dbHandle = params.tx ?? db;
  const where = params.leaseToken !== undefined
    ? and(
        eq(agentTaskRuns.id, params.runId),
        eq(agentTaskRuns.researchIntentState, params.fromState),
        eq(agentTaskRuns.leaseToken, params.leaseToken),
        eq(agentTaskRuns.status, "RUNNING"),
      )
    : and(
        eq(agentTaskRuns.id, params.runId),
        eq(agentTaskRuns.researchIntentState, params.fromState),
      );
  const updated = await dbHandle.update(agentTaskRuns)
    .set({ researchIntentState: params.toState, updatedAt: new Date() })
    .where(where)
    .returning({ id: agentTaskRuns.id });
  return updated.length === 1;
}

/**
 * Transition every PROPOSED draft for a thread (other than the just-inserted
 * `excludingRunId`) to SUPERSEDED. Intended to be called inside the same
 * transaction that inserts a new draft, so a thread never carries two
 * PROPOSED drafts concurrently.
 */
export async function supersedePriorProposedDraft(params: {
  threadId: string;
  excludingRunId: string;
  tx: Tx;
}): Promise<number> {
  // The excludingRunId guard is enforced in the application layer because
  // Drizzle's column type is uuid (not literal-typed) — the runId we are
  // about to write to is excluded from the SET list returned below, then
  // counted.
  const updated = await params.tx.update(agentTaskRuns)
    .set({ researchIntentState: "SUPERSEDED", updatedAt: new Date() })
    .where(and(
      eq(agentTaskRuns.threadId, params.threadId),
      eq(agentTaskRuns.researchIntentState, "PROPOSED"),
    )).returning({ id: agentTaskRuns.id });
  return updated.filter((r) => r.id !== params.excludingRunId).length;
}

/**
 * Load the latest non-superseded draft for a thread. Used by the
 * dismiss / recovery paths. Returns `null` when the thread has no
 * PROPOSED draft (e.g. owner already dismissed or confirmed).
 */
export async function loadLatestProposedDraftForThread(params: {
  threadId: string;
  tx?: Tx;
}): Promise<{ runId: string; draft: PersistedResearchIntentDraft } | null> {
  const dbHandle = params.tx ?? db;
  const rows = await dbHandle.select({
    runId: agentTaskRuns.id,
    draft: agentTaskRuns.researchIntentDraft,
    state: agentTaskRuns.researchIntentState,
  }).from(agentTaskRuns).where(and(
    eq(agentTaskRuns.threadId, params.threadId),
    eq(agentTaskRuns.researchIntentState, "PROPOSED"),
  )).orderBy(desc(agentTaskRuns.createdAt)).limit(1);
  const row = rows[0];
  if (!row?.draft) return null;
  // Coerce legacy rows (Phase 1) where `blockers` / `warnings` were not
  // yet on the JSONB shape — they deserialize as `null` or `undefined`.
  // Default-fill to `[]` so downstream callers always receive arrays.
  return {
    runId: row.runId,
    draft: {
      schemaVersion: 1,
      kind: row.draft.kind,
      requestedCapabilities: row.draft.requestedCapabilities,
      classifierVersion: row.draft.classifierVersion,
      readiness: row.draft.readiness,
      blockers: row.draft.blockers ?? [],
      warnings: row.draft.warnings ?? [],
      missing: row.draft.missing,
    },
  };
}

// Re-export the Zod-inferred state schema for downstream consumers.
export { researchIntentStateSchema };

async function requireRunAccess(run: AgentTaskRow, userId: string, tx?: Tx): Promise<void> {
  if (run.operation === "CONVERSATION") {
    if (run.createdByUserId !== userId) throw new ApiError(403, "Forbidden", "Not authorized for this Agent run");
    return;
  }
  // PERSONAL_RESEARCH is owner-only by design (spec §3.3): the creator of
  // the run IS the owner, and trip members must NOT see Personal evidence.
  // Trip-membership check applies to PLAN/REPLAN/RESEARCH as before.
  if (run.operation === "PERSONAL_RESEARCH") {
    if (run.createdByUserId !== userId) throw new ApiError(403, "Forbidden", "Not authorized for this personal research run");
    return;
  }
  if (!run.tripId) throw new ApiError(403, "Forbidden", "Planning task is not trip-bound");
  const query = tx ?? db;
  const [member] = await query.select({ userId: tripMembers.userId }).from(tripMembers).where(and(
    eq(tripMembers.tripId, run.tripId), eq(tripMembers.userId, userId),
  )).limit(1);
  if (!member) throw new ApiError(403, "Forbidden", "Not authorized for this planning run");
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

export async function claimNextPlanningTask(): Promise<AgentTaskRow | null> {
  const rows = await rawDb.unsafe<Array<{ id: string }>>(CLAIM_PLANNING_SQL, [randomUUID(), agentTaskConfig.leaseSeconds]);
  if (!rows[0]) return null;
  const [run] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, rows[0].id)).limit(1);
  return run ?? null;
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
  // Any transition away from RUNNING revokes the Worker authority. This also
  // makes a superseded/cancelled planning run fail closed before finalization.
  return !run || run.leaseToken !== leaseToken || run.status !== "RUNNING";
}

/**
 * Load the current-turn input that the Worker hands to the conversation
 * Skill. Returns only the fields the route layer controls (the current
 * question, place, intent); the bounded same-thread history window is
 * built separately by `buildConversationContext` in
 * `apps/api/src/services/conversation-context-service.ts` so the two
 * read paths can evolve independently and so neither side has to
 * compose the other's contract.
 *
 * Fails closed when the run row's USER message has gone missing — the
 * Worker must not invent a question.
 */
export async function loadConversationTurnInput(run: AgentTaskRow): Promise<{
  question: string;
  place?: ConversationPlace;
  intent?: "auto_intro" | "user_typed";
}> {
  if (!run.threadId || !run.userMessageId) throw new Error("Conversation task references are incomplete");
  const [message] = await db.select().from(chatMessages)
    .where(and(eq(chatMessages.id, run.userMessageId), eq(chatMessages.threadId, run.threadId)))
    .limit(1);
  if (!message || message.role !== "USER") throw new Error("Conversation USER message is unavailable");
  const intent = run.intent === "auto_intro" || run.intent === "user_typed" ? run.intent : undefined;
  return { question: message.body, place: taskPlace(run), intent };
}

export async function completeConversationTask(params: {
  ctx: RequestContext;
  run: AgentTaskRow;
  leaseToken: string;
  content: string;
  responseMode: "MODEL" | "SAFE_REFUSAL" | "FALLBACK";
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
      // A member can be removed after Worker pickup. Re-check inside the
      // final write transaction so no assistant output is committed then.
      await requireOwnedTripThread(tx, params.run.threadId!, params.run.createdByUserId);
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

/**
 * Phase 2 — complete a Personal Trip Orchestrator RESEARCH run under lease.
 *
 * Lease-guarded write of `agent_task_runs.status = COMPLETED | COMPLETED_WITH_GAPS`,
 * clears the lease, fills the outbox + idempotency result, and writes the
 * `RESEARCH_COMPLETED` audit. The `researchResultId` is optional — Phase 3's
 * `personal-trip-orchestrator-service.runResearch` decides whether to persist a
 * `planning_research_results` row (RESEARCH_ONLY → yes, PROPOSE_PLAN → no
 * because the planner writes the plan first). When `outcome` is
 * `COMPLETED_WITH_GAPS` the run may also carry a `result_plan_id` (set by the
 * planner) — this function preserves it on the row.
 */
export async function completeResearchTask(params: {
  ctx: RequestContext;
  run: AgentTaskRow;
  leaseToken: string;
  outcome: "COMPLETED" | "COMPLETED_WITH_GAPS";
  researchResultId?: string;
  resultPlanId?: string;
}): Promise<{ runId: string; status: typeof params.outcome; researchResultId: string | null }> {
  const span = getTracer().startSpan("db.agent_task_runs.UPDATE", {
    kind: SpanKind.CLIENT,
    attributes: {
      "db.system": "postgresql",
      "db.operation": "UPDATE",
      "db.sql.table": "agent_task_runs",
    },
  });
  try {
    return await db.transaction(async (tx) => {
      const [completed] = await tx.update(agentTaskRuns).set({
        status: params.outcome,
        leaseToken: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
        errorCode: null,
        researchResultId: params.researchResultId ?? null,
        resultPlanId: params.resultPlanId ?? null,
      }).where(and(
        eq(agentTaskRuns.id, params.run.id),
        eq(agentTaskRuns.leaseToken, params.leaseToken),
        eq(agentTaskRuns.status, "RUNNING"),
      )).returning();
      if (!completed) throw new LostTaskLeaseError();

      await tx.insert(outboxEvents).values({
        eventId: randomUUID(),
        eventType: "AGENT_TASK_COMPLETED",
        payload: {
          taskId: params.run.id,
          operation: params.run.operation,
          outcome: params.outcome,
        },
      });

      await recordAudit({
        ctx: params.ctx,
        action: "RESEARCH_COMPLETED",
        actorUserId: params.run.createdByUserId,
        tripId: params.run.tripId ?? undefined,
        summary: {
          taskId: params.run.id,
          outcome: params.outcome,
          planCreated: Boolean(params.resultPlanId),
        },
        tx,
      });
      await recordAudit({
        ctx: params.ctx,
        action: "AGENT_TASK",
        actorUserId: params.run.createdByUserId,
        tripId: params.run.tripId ?? undefined,
        summary: { taskId: params.run.id, operation: params.run.operation, status: params.outcome },
        tx,
      });

      safeSetAttribute(span, "db.outcome", "success");
      return {
        runId: params.run.id,
        status: params.outcome,
        researchResultId: params.researchResultId ?? null,
      };
    });
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
  random?: () => number;
}): Promise<"RETRYING" | "FAILED" | "LOST"> {
  const canRetry = params.retryable && params.run.attemptCount < params.run.maxAttempts;
  const delayMs = calculateRetryDelayMs(params.run.attemptCount, params.random);
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

/** Bounded exponential retry delay with deterministic injectable jitter. */
export function calculateRetryDelayMs(attemptCount: number, random: () => number = Math.random): number {
  const ceilingMs = Math.min(8_000, 500 * 2 ** Math.max(0, attemptCount - 1));
  const unit = Math.max(0, Math.min(1, random()));
  return Math.floor(ceilingMs * (0.5 + unit * 0.5));
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

function toRunResponse(
  run: AgentTaskRow,
): AgentRunResponse {
  // Project the persisted draft down to the closed-shape owner-safe subset.
  // SUPERSEDED drafts are intentionally hidden — they are server-internal
  // bookkeeping (see docs/personal-research-intent-routing-implementation.md
  // §4.1) and never exposed to clients. DRAFT Personal Research (added via
  // 0047) writes a different envelope into the same JSONB column for the
  // typed-flight-input path — those rows are surfaced via the dedicated
  // `GET /agent-runs/:runId/personal-research` route, not via the run
  // DTO; this projector hides them here so the legacy DTO stays schema-
  // stable. Source: docs/draft-personal-research-implementation.md §3.3.
  const isLegacyDraftShape = (d: { kind?: string } | null | undefined) =>
    !!d && (d.kind === "RESEARCH_ONLY" || d.kind === "PROPOSE_PLAN");
  const draft = (run.researchIntentState === "SUPERSEDED"
    || run.researchIntentDraft === null
    || !isLegacyDraftShape(run.researchIntentDraft as { kind?: string } | null))
    ? null
    : {
        kind: run.researchIntentDraft.kind,
        requestedCapabilities: run.researchIntentDraft.requestedCapabilities,
        readiness: run.researchIntentDraft.readiness,
        // Coerce legacy rows (Phase 1) where `blockers` / `warnings` were not
        // yet on the JSONB shape — they deserialize as `undefined` / `null`.
        // Default-fill to `[]` so the client always receives explicit arrays.
        blockers: run.researchIntentDraft.blockers ?? [],
        warnings: run.researchIntentDraft.warnings ?? [],
        missing: run.researchIntentDraft.missing,
      };
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
    researchIntentDraft: draft,
    researchIntentState: run.researchIntentState === "SUPERSEDED" ? null : run.researchIntentState,
  });
}

function toIsoDate(value: string | Date): string {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(value);
    return parsed.toISOString().slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
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
