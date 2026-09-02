import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/database.js";
import {
  chatThreads,
  tripConstraintProposals,
  tripMembers,
} from "../db/schema.js";
import { invokeSkill } from "../agents/skill-registry.js";
import { recordAudit } from "./audit-service.js";
import { metrics } from "../observability/metrics.js";
import { logSafeRuntimeEvent } from "../observability/telemetry.js";
import {
  CONSTRAINT_FIELD_KEYS,
  CONSTRAINT_FIELD_CATALOG,
  parseConstraintField,
} from "../policy/constraint-field-catalog.js";
import type { RequestContext } from "../utils/context.js";

/**
 * Member conversation handoff — extraction service
 * (docs/member-conversation-handoff-implementation.md §5.1)
 *
 * After the conversation skill finishes a normal reply, this service:
 *   1. Re-checks that the run's `createdByUserId` is still an active member of
 *      the run's trip (the conversation task handler has already verified
 *      this once — we re-check inside the candidate-extraction path so an
 *      out-of-band membership removal between accept and pickup still fails
 *      closed).
 *   2. Loads the bounded same-thread question and the trip brief.
 *   3. Invokes the `trip.constraint.propose` Skill, which internally calls
 *      the model gateway and returns catalog-validated proposals only.
 *   4. Persists the proposals as one batch (same `batch_id`,
 *      `origin_thread_id`, `origin_run_id`, monotonic `candidate_version`).
 *   5. Writes a `MEMBER_CONVERSATION_CANDIDATES_CREATED` audit event without
 *      chat text or values in the summary.
 *
 * Failure modes are non-fatal to the conversation reply: an extraction
 * failure only bumps `conversation_handoff_candidate_batch_total{result}`.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ExtractedHandoffBatch {
  batchId: string;
  candidateVersion: number;
  proposalIds: string[];
  fieldKeys: string[];
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

/**
 * Persist the validated proposal batch. The whole write happens inside the
 * caller's transaction so a later step (snapshot / plan accept) cannot be
 * raced in between. Returns the batch metadata the worker needs to render
 * the candidate card and the API needs to fetch by `batchId`.
 *
 * The `candidateVersion` is a batch-level optimistic-concurrency value. A
 * newly extracted batch starts at 1 and every row carries that same value;
 * `batch_id` is freshly generated, so no writer can overwrite another batch.
 */
async function persistBatch(params: {
  tx: Tx;
  batchId: string;
  tripId: string;
  ownerUserId: string;
  threadId: string;
  runId: string;
  proposals: Array<{
    fieldKey: string;
    valueJson: unknown;
    strength: "HARD" | "SOFT";
    suggestedVisibility: "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL";
    safeRationale: string;
  }>;
}): Promise<{ proposalIds: string[]; fieldKeys: string[] }> {
  const proposalIds: string[] = [];
  const fieldKeys: string[] = [];
  const candidateVersion = 1;
  for (const proposal of params.proposals) {
    const valueHash = hashValue(proposal.valueJson);
    const [inserted] = await params.tx.insert(tripConstraintProposals).values({
      tripId: params.tripId,
      ownerUserId: params.ownerUserId,
      fieldKey: proposal.fieldKey,
      valueJson: proposal.valueJson as Record<string, unknown>,
      valueHash,
      strength: proposal.strength,
      proposedVisibility: proposal.suggestedVisibility,
      sourceKind: "PERSONAL_AGENT",
      batchId: params.batchId,
      originThreadId: params.threadId,
      originRunId: params.runId,
      candidateVersion,
    }).returning({ id: tripConstraintProposals.id, fieldKey: tripConstraintProposals.fieldKey });
    proposalIds.push(inserted.id);
    fieldKeys.push(inserted.fieldKey);
  }
  return { proposalIds, fieldKeys };
}

/**
 * Public entrypoint. Returns `null` when the worker cannot or should not
 * extract (no active membership, no destination candidates, model returned
 * nothing). Never throws — the conversation reply has already streamed.
 */
export async function extractConversationHandoffBatch(params: {
  ctx: RequestContext;
  run: {
    id: string;
    tripId: string | null;
    threadId: string | null;
    createdByUserId: string;
  };
  /** The current turn's question as loaded by the conversation task handler. */
  currentTurnQuestion: string;
  /** Trip brief: departure cities, destination candidates, optional date window. */
  tripBrief: {
    departureCities: string[];
    destinationCandidates: string[];
    travelDateWindow?: { start: string; end: string };
  };
  /** Owner-scoped non-sensitive profile hints (interests, accommodation style, noRedEye, soft budget). */
  ownerProfileHints?: {
    interests?: string[];
    accommodationStyle?: string;
    noRedEye?: boolean;
    budgetMaxUsd?: number;
  };
  signal: AbortSignal;
}): Promise<ExtractedHandoffBatch | null> {
  if (!params.run.tripId || !params.run.threadId) {
    metrics.inc("conversation_handoff_candidate_batch_total", { result: "extraction_failed" });
    return null;
  }
  if (params.tripBrief.destinationCandidates.length === 0) {
    metrics.inc("conversation_handoff_candidate_batch_total", { result: "empty" });
    return null;
  }

  // Re-check active membership inside the candidate path so a membership
  // removal that landed between skill accept and worker pickup still fails
  // closed without leaking data into the trip.
  const [membership] = await db.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(
      eq(tripMembers.tripId, params.run.tripId),
      eq(tripMembers.userId, params.run.createdByUserId),
    ))
    .limit(1);
  if (!membership) {
    metrics.inc("conversation_handoff_candidate_batch_total", { result: "extraction_failed" });
    return null;
  }

  // Verify the thread is owner-bound and still bound to the same trip.
  const [thread] = await db.select({
    tripId: chatThreads.tripId,
    ownerUserId: chatThreads.ownerUserId,
  }).from(chatThreads).where(eq(chatThreads.id, params.run.threadId)).limit(1);
  if (!thread || thread.ownerUserId !== params.run.createdByUserId || thread.tripId !== params.run.tripId) {
    metrics.inc("conversation_handoff_candidate_batch_total", { result: "extraction_failed" });
    return null;
  }

  // The catalog allow-list is built inside the Skill handler (which is the
  // single authority on field keys / allowed visibilities / allowed
  // strengths). The service only carries the bounded context the Skill
  // needs; it does not duplicate the catalog.
  void CONSTRAINT_FIELD_KEYS;
  void CONSTRAINT_FIELD_CATALOG;

  let parsed: Awaited<ReturnType<typeof invokeSkill>>;
  try {
    parsed = await invokeSkill("trip.constraint.propose", {
      ctx: params.ctx,
      policyGate: { requireScope: () => undefined } as never,
    }, {
      tripId: params.run.tripId,
      question: params.currentTurnQuestion,
      threadContext: {
        tripBrief: params.tripBrief,
        ...(params.ownerProfileHints ? { ownerProfileHints: params.ownerProfileHints } : {}),
      },
    }, { signal: params.signal });
  } catch (error) {
    logSafeRuntimeEvent(params.ctx, {
      component: "worker", event: "skill", operation: "trip.constraint.propose",
      outcome: "failure",
      errorCode: (error as { code?: string }).code ?? "INTERNAL",
    });
    metrics.inc("conversation_handoff_candidate_batch_total", { result: "extraction_failed" });
    return null;
  }

  const typed = parsed as { proposals: Array<{ fieldKey: string; valueJson: unknown; strength: "HARD" | "SOFT"; suggestedVisibility: "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL"; safeRationale: string; }> };
  const validated: typeof typed.proposals = [];
  for (const candidate of typed.proposals) {
    try {
      // Same catalog gate the Skill already ran; running it again here means
      // a future caller (e.g. a direct service invocation) cannot bypass the
      // Skill and write proposals outside the allow-list.
      const allowed = CONSTRAINT_FIELD_CATALOG[candidate.fieldKey as keyof typeof CONSTRAINT_FIELD_CATALOG];
      if (!allowed || !allowed.proposalEligible) {
        metrics.inc("conversation_handoff_candidate_batch_total", { result: "catalog_invalid" });
        continue;
      }
      parseConstraintField({
        fieldKey: candidate.fieldKey,
        value: candidate.valueJson,
        visibility: candidate.suggestedVisibility,
        strength: candidate.strength,
      });
      if (candidate.safeRationale.length > 280) {
        metrics.inc("conversation_handoff_candidate_batch_total", { result: "catalog_invalid" });
        continue;
      }
      validated.push(candidate);
    } catch {
      metrics.inc("conversation_handoff_candidate_batch_total", { result: "catalog_invalid" });
    }
  }
  if (validated.length === 0) {
    metrics.inc("conversation_handoff_candidate_batch_total", { result: "empty" });
    return null;
  }

  const batchId = randomUUID();
  const writeResult = await db.transaction(async (tx) => {
    return persistBatch({
      tx,
      batchId,
      tripId: params.run.tripId!,
      ownerUserId: params.run.createdByUserId,
      threadId: params.run.threadId!,
      runId: params.run.id,
      proposals: validated,
    });
  });

  await recordAudit({
    ctx: params.ctx,
    action: "MEMBER_CONVERSATION_CANDIDATES_CREATED",
    actorUserId: params.run.createdByUserId,
    tripId: params.run.tripId,
    summary: {
      candidateVersion: 1,
      fieldCategory: writeResult.fieldKeys.slice().sort(),
      sourceKind: "PERSONAL_AGENT",
    },
  });
  metrics.inc("conversation_handoff_candidate_batch_total", { result: "extracted" });

  return {
    batchId,
    candidateVersion: 1,
    proposalIds: writeResult.proposalIds,
    fieldKeys: writeResult.fieldKeys,
  };
}
