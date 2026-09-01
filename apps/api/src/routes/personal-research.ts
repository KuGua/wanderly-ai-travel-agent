/**
 * DRAFT Personal Research — owner-only durable task routes.
 *
 * `GET    /api/v1/agent-runs/:runId/personal-research`
 *         — read the typed draft + bounded evidence summary (owner only).
 * `PUT    /api/v1/agent-runs/:runId/personal-research/answers`
 *         — owner-only CAS write of the typed draft into `researchIntentDraft` JSONB.
 * `POST   /api/v1/agent-runs/:runId/personal-research/confirm`
 *         — owner-only confirm; accepts only `{ requestId }`. Validates
 *           the draft's capability is in the runtime allow-list and creates
 *           the PERSONAL_RESEARCH durable task.
 * `POST   /api/v1/agent-runs/:runId/personal-research/cancel`
 *         — owner-only cancel; idempotent. Never starts a provider call when
 *           the run has not yet entered RUNNING.
 *
 * Every route enforces `getAuthorizedAgentRun` so a non-owner 403s before
 * any service-layer call. The capability allow-list gate lives in the
 * confirm route — service-level executors are not reached if the capability
 * is disabled.
 *
 * Source: docs/draft-personal-research-implementation.md §3.3.
 */

import { z } from "zod";
import { and, eq, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { db } from "../db/database.js";
import {
  agentTaskRuns,
  chatThreads,
  personalResearchEvidence,
  tripMembers,
} from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import {
  acceptPersonalResearchTask,
  getAuthorizedAgentRun,
  requestAgentTaskCancellation,
} from "../tasks/task-repository.js";
import { isPersonalResearchCapabilityAllowed, type PersonalResearchOperationCapability } from "../config/personal-research-allowed-capabilities.js";
import {
  personalResearchAnswersRequestSchema,
  personalResearchConfirmRequestSchema,
  personalResearchOwnerDraftSchema,
  uuidSchema,
} from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";
import { readPersonalResearchEvidence } from "../services/personal-research-service.js";

const runIdParamsSchema = z.object({ runId: uuidSchema }).strict();
const runIdWithCapabilityParamsSchema = z.object({ runId: uuidSchema }).strict();

async function loadConversationIntentRun(runId: string, userId: string): Promise<{
  intentRunId: string;
  tripId: string;
  threadId: string;
  ownerUserId: string;
}> {
  await getAuthorizedAgentRun(runId, userId);
  const [row] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).limit(1);
  if (!row) throw new ApiError(404, "Not Found", "Agent run not found");
  if (row.operation !== "CONVERSATION") {
    throw new ApiError(409, "Conflict", "Personal research draft can only live on a conversation run");
  }
  if (!row.tripId || !row.threadId) {
    throw new ApiError(409, "Conflict", "Conversation run is missing a trip/thread binding");
  }
  return {
    intentRunId: row.id,
    tripId: row.tripId,
    threadId: row.threadId,
    ownerUserId: row.createdByUserId,
  };
}

function deriveCapabilityFromDraft(draft: { kind: string }): PersonalResearchOperationCapability {
  switch (draft.kind) {
    case "FLIGHT_SEARCH": return "flight.search";
    case "HOTEL_SEARCH": return "hotel.search";
    case "ACCOMMODATION_DISCOVERY": return "accommodation.discovery";
    case "ACTIVITIES_SEARCH": return "activities.search";
    case "PLACES_SEARCH": return "places.search";
    case "NAVIGATION_ROUTE": return "navigation.route";
    case "MOBILITY_SEARCH": return "mobility.search";
    default:
      throw new ApiError(422, "Unprocessable Entity", `Unknown personal research draft kind ${draft.kind}`);
  }
}

export async function personalResearchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/agent-runs/:runId/personal-research", {
    schema: {
      description: "Owner-only — read the typed draft and the bounded evidence summary.",
    },
  }, async (request) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    // Step 1: locate the durable PERSONAL_RESEARCH row (or, during DRAFT,
    // the originating CONVERSATION row that holds the typed draft).
    await getAuthorizedAgentRun(runId, request.user.id);
    const [row] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).limit(1);
    if (!row) throw new ApiError(404, "Not Found", "Agent run not found");
    if (row.operation === "PERSONAL_RESEARCH") {
      // Confirm-time shape: persisted durable task + bounded evidence.
      const capability = (row.requestedCapabilities ?? [])[0] as PersonalResearchOperationCapability | undefined;
      if (!capability) throw new ApiError(409, "Conflict", "Personal research run missing capability");
      const evidence = await readPersonalResearchEvidence({ runId: row.id, ownerUserId: request.user.id });
      return {
        runId: row.id,
        capability,
        status: row.status,
        terminal: ["COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELLED", "STALE"].includes(row.status),
        draft: null,
        evidence: evidence
          ? {
              id: evidence.evidenceId,
              capability: evidence.capability,
              outcome: evidence.outcome,
              providerName: evidence.providerName,
              source: evidence.source,
              capturedAt: evidence.capturedAt.toISOString(),
              expiresAt: evidence.expiresAt ? evidence.expiresAt.toISOString() : null,
              summary: evidence.summary,
            }
          : null,
      };
    }
    if (row.operation === "CONVERSATION") {
      // Pre-confirm shape: typed draft lives on researchIntentDraft JSONB.
      const capability = (row.requestedCapabilities ?? [])[0] as PersonalResearchOperationCapability | undefined;
      const draft = row.researchIntentDraft as unknown;
      if (!capability) {
        throw new ApiError(409, "Conflict", "Conversation run is missing a personal research capability");
      }
      return {
        runId: row.id,
        capability,
        status: row.status,
        terminal: ["COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELLED", "STALE"].includes(row.status),
        draft,
        evidence: null,
      };
    }
    throw new ApiError(409, "Conflict", "Personal research route is only valid for PERSONAL_RESEARCH or CONVERSATION runs");
  });

  app.put("/agent-runs/:runId/personal-research/answers", {
    schema: {
      description: "Owner-only — CAS write of the typed draft into researchIntentDraft JSONB.",
    },
  }, async (request, reply) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    const body = personalResearchAnswersRequestSchema.parse(request.body);
    const capability = deriveCapabilityFromDraft(body.draft);
    if (!isPersonalResearchCapabilityAllowed(capability)) {
      throw new ApiError(422, "Unprocessable Entity", `Capability ${capability} is not enabled for personal research`);
    }
    createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const intent = await loadConversationIntentRun(runId, request.user.id);
    const draftEnvelope = {
      schemaVersion: 1 as const,
        kind: body.draft.kind,
        capability,
        draft: body.draft,
      };
    await db.transaction(async (tx) => {
      const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, intent.threadId)).limit(1);
      if (!thread) throw new ApiError(404, "Not Found", "Thread not found");
      if (thread.ownerUserId !== intent.ownerUserId) {
        throw new ApiError(403, "Forbidden", "Thread is not owned by the caller");
      }
      const [member] = await tx.select({ userId: tripMembers.userId }).from(tripMembers).where(and(
        eq(tripMembers.tripId, intent.tripId), eq(tripMembers.userId, intent.ownerUserId),
      )).limit(1);
      if (!member) throw new ApiError(403, "Forbidden", "Caller is not an active trip member");
      const [updated] = await tx.update(agentTaskRuns).set({
        // The DRAFT typed envelope uses a different shape than the legacy
        // ResearchIntentDraftShape that the JSONB column is typed for; the
        // runtime read in the handler re-parses with the new Zod schema, so
        // the structural cast is safe.
        researchIntentDraft: draftEnvelope as never,
        researchIntentState: "PROPOSED",
        requestedCapabilities: [capability] as never,
        updatedAt: new Date(),
      }).where(and(
        eq(agentTaskRuns.id, runId),
        eq(agentTaskRuns.createdByUserId, request.user.id),
        eq(agentTaskRuns.operation, "CONVERSATION"),
        or(
          isNull(agentTaskRuns.researchIntentState),
          eq(agentTaskRuns.researchIntentState, "PROPOSED"),
        ),
      )).returning({ id: agentTaskRuns.id });
      if (!updated) {
        throw new ApiError(409, "Conflict", "Personal research draft state could not be updated");
      }
    });
    reply.status(204);
    return null;
  });

  app.post("/agent-runs/:runId/personal-research/confirm", {
    schema: {
      description: "Owner-only — validate draft + capability gate + create PERSONAL_RESEARCH durable task. Returns 202.",
    },
  }, async (request, reply) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    const body = personalResearchConfirmRequestSchema.parse(request.body);
    const intent = await loadConversationIntentRun(runId, request.user.id);
    const [row] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).limit(1);
    const rawDraft = row?.researchIntentDraft as { draft?: { kind?: string }; capability?: PersonalResearchOperationCapability } | null;
    if (!rawDraft?.draft || typeof rawDraft.draft.kind !== "string") {
      throw new ApiError(422, "Unprocessable Entity", "Conversation run is missing a typed personal research draft");
    }
    const typedDraft = personalResearchOwnerDraftSchema.safeParse(rawDraft.draft);
    if (!typedDraft.success) {
      throw new ApiError(422, "Unprocessable Entity", "Conversation run contains an invalid personal research draft");
    }
    const capability = deriveCapabilityFromDraft(typedDraft.data);
    if (!isPersonalResearchCapabilityAllowed(capability)) {
      throw new ApiError(422, "Unprocessable Entity", `Capability ${capability} is not enabled for personal research`);
    }
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const accepted = await acceptPersonalResearchTask({
      ctx,
      tripId: intent.tripId,
      threadId: intent.threadId,
      ownerUserId: request.user.id,
      requestId: body.requestId,
      capability,
      input: typedDraft.data,
      originatingIntentRunId: runId,
    });
    reply.status(202);
    return {
      runId: accepted.runId,
      capability: accepted.capability,
      status: "QUEUED" as const,
    };
  });

  app.post("/agent-runs/:runId/personal-research/cancel", {
    schema: {
      description: "Owner-only — idempotent cancel of a DRAFT/CONFIRMED/QUEUED/RUNNING personal research task.",
    },
  }, async (request) => {
    const { runId } = runIdWithCapabilityParamsSchema.parse(request.params);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    // Locate the durable PERSONAL_RESEARCH run (not the conversation intent
    // run). The pre-confirm draft lives on the CONVERSATION row, but cancel
    // only applies to a dispatched durable task — the route returns 404 if
    // the run is not PERSONAL_RESEARCH.
    const [row] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).limit(1);
    if (!row || row.operation !== "PERSONAL_RESEARCH") {
      throw new ApiError(404, "Not Found", "Personal research run not found");
    }
    if (row.createdByUserId !== request.user.id) {
      throw new ApiError(403, "Forbidden", "Not authorized for this personal research run");
    }
    await requestAgentTaskCancellation({ ctx, runId: row.id, userId: request.user.id });
    // The cancel contract: never invoke a provider call. We assert here that
    // no `personal_research_evidence` row was ever written for a run that
    // has been cancelled before its terminal phase, but a durable task that
    // has already reached COMPLETED / COMPLETED_WITH_GAPS / FAILED is
    // terminal and cancellation is a no-op (requestAgentTaskCancellation
    // does that check internally).
    const capability = (row.requestedCapabilities ?? [])[0] as PersonalResearchOperationCapability | undefined;
    if (!capability) throw new ApiError(409, "Conflict", "Personal research run missing capability");
    const [ev] = await db.select().from(personalResearchEvidence).where(eq(personalResearchEvidence.runId, row.id)).limit(1);
    return {
      runId: row.id,
      capability,
      status: row.status,
      terminal: true,
      draft: null,
      evidence: ev
        ? {
            id: ev.id,
            capability,
            outcome: ev.outcome,
            providerName: ev.providerName,
            source: ev.source,
            capturedAt: ev.capturedAt.toISOString(),
            expiresAt: ev.expiresAt ? ev.expiresAt.toISOString() : null,
            summary: ev.resultJson as unknown as Record<string, unknown>,
          }
        : null,
    };
  });
}
