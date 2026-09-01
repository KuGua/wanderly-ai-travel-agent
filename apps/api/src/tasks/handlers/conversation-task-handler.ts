import { and, eq } from "drizzle-orm";

import { DefaultPolicyGate } from "../../agents/policy-gate.js";
import { db } from "../../db/database.js";
import { sharedTrips, tripMembers } from "../../db/schema.js";
import { ApiError } from "../../middleware/error-handler.js";
import { metrics } from "../../observability/metrics.js";
import {
  containsUnsupportedOperationalClaim,
} from "../../policy/conversation-safety.js";
import { buildConversationContext } from "../../services/conversation-context-service.js";
import { buildConversationMemoryContext } from "../../services/conversation-memory-context.js";
import { loadLatestResearchEvidence } from "../../services/research-evidence-service.js";
import { proposeTripBriefFromTurn } from "../../services/trip-brief-proposal-service.js";
import {
  executeTravelConversation,
  travelConversationSkill,
  travelConversationInputSchema,
  travelConversationOutputSchema,
} from "../../skills/personal/travel-conversation-skill.js";
import { personalTripContextSchema, type PersonalTripContext } from "../../skills/personal/personal-trip-context-schema.js";
import type { AgentStreamEvent } from "../../types/schemas.js";
import type { RequestContext } from "../../utils/context.js";
import { agentTaskConfig } from "../config.js";
import { publishAgentStreamEvent } from "../task-stream-publisher.js";
import type { AgentTaskRow } from "../task-repository.js";
import { loadConversationTurnInput } from "../task-repository.js";
import { buildProactiveIntro } from "../../i18n/proactive-intro.js";

export async function handleConversationTask(params: {
  run: AgentTaskRow;
  ctx: RequestContext;
  signal: AbortSignal;
}): Promise<{
  content: string;
  responseMode: import("../../types/schemas.js").ConversationResponseMode;
  tripBriefProposal?: { destinationCandidates?: string[]; travelDays?: number };
} | null> {
  // ─── Quick Orchestration — Proactive intro (no user message) ─────────────
  // The run was created server-side on trip activation; the conversation
  // worker renders the locale-aware greeting template and emits a single
  // `message.delta` SSE event. No LLM call. No setup session. The first
  // user turn will go through the normal classifier path below.
  if (isProactiveIntroRun(params.run)) {
    await handleProactiveIntro(params);
    return null;
  }

  // Re-check that the creator is still an active member of the
  // thread's Trip.  Membership may have changed between acceptance
  // (when the row was locked) and worker pick-up (now).  Per
  // docs/trip-scoped-private-threads-implementation.md §7, this
  // short-circuits the task before any Trip metadata is loaded and
  // any agent output is rendered.
  if (!params.run.threadId) {
    throw new ApiError(500, "Internal Server Error", "Conversation task missing threadId");
  }
  if (!params.run.tripId) {
    throw new ApiError(500, "Internal Server Error", "Conversation task missing tripId");
  }
  const [membership] = await db.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(
      eq(tripMembers.tripId, params.run.tripId),
      eq(tripMembers.userId, params.run.createdByUserId),
    ))
    .limit(1);
  if (!membership) {
    throw new ApiError(403, "Forbidden", "Thread owner is no longer a member of this trip");
  }

  const turnInput = await loadConversationTurnInput(params.run);
  const tripContext = await loadPersonalTripContext(params.run.tripId);
  // The bounded same-thread LLM context is built in its own service so
  // the read path stays pure and retryable (§3.1.4 / §6). Failures here
  // bubble up as a terminal task error before any model call.
  const context = await buildConversationContext(params.run);
  // Cross-thread long-term memory for the owner. `buildConversationContext`
  // covers only this thread; without this the assistant restarts from zero
  // in every new thread even though the facts are already stored.
  const memoryContext = await buildConversationMemoryContext(params.run.createdByUserId);
  // What this trip's own providers last returned. Without it the assistant
  // cannot refer to a search it ran itself: the offers were persisted and
  // never read back.
  const evidence = await loadLatestResearchEvidence(params.run.tripId);
  const input = travelConversationInputSchema.parse({
    ...turnInput,
    tripContext,
    threadContext: context.messages,
    memoryContext,
    researchEvidence: evidence?.offers ?? [],
  });

  const gate = new SafeConversationDeltaGate(params.run, params.ctx.traceparent);
  const execution = new AbortController();
  const abortFromTask = () => execution.abort(params.signal.reason);
  if (params.signal.aborted) abortFromTask();
  else params.signal.addEventListener("abort", abortFromTask, { once: true });
  const timeout = setTimeout(() => {
    const error = new Error("Conversation Skill timed out");
    error.name = "AbortError";
    execution.abort(error);
  }, travelConversationSkill.timeoutMs);

  let output;
  try {
    output = await executeTravelConversation({
      ctx: params.ctx,
      policyGate: new DefaultPolicyGate("personal"),
    }, input, execution.signal, (delta) => gate.push(delta));
  } finally {
    clearTimeout(timeout);
    params.signal.removeEventListener("abort", abortFromTask);
  }

  await publishPhase(params.run, "VALIDATING", params.ctx.traceparent);
  const parsed = travelConversationOutputSchema.parse(output);
  if (parsed.responseMode === "MODEL" && containsUnsupportedOperationalClaim(parsed.content)) {
    throw new Error("Final conversation safety validation failed");
  }
  if (gate.rawText === parsed.content) await gate.flush();
  if (parsed.responseMode !== "MODEL" || tripContext.tripStatus !== "DRAFT") return parsed;
  const tripBriefProposal = proposeTripBriefFromTurn(turnInput.question, turnInput.place);
  return travelConversationOutputSchema.parse({ ...parsed, ...(tripBriefProposal ? { tripBriefProposal } : {}) });
}

/**
 * Loads the server-derived PersonalTripContext for a single trip.
 * The result is the closed allow-list defined in
 * skills/personal/personal-trip-context-schema.ts — no other Trip data
 * (members, plans, consent, snapshots) is ever returned.
 *
 * Throws if the trip row no longer exists; the caller treats this as a
 * terminal task failure.
 */
async function loadPersonalTripContext(tripId: string): Promise<PersonalTripContext> {
  const [trip] = await db.select({
    id: sharedTrips.id,
    name: sharedTrips.name,
    status: sharedTrips.status,
    travelDateStart: sharedTrips.travelDateStart,
    travelDateEnd: sharedTrips.travelDateEnd,
    destinationCandidates: sharedTrips.destinationCandidates,
  }).from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
  if (!trip) {
    throw new ApiError(404, "Not Found", "Trip not found while loading PersonalTripContext");
  }
  // CONFIRMED, BOOKED, CANCELLED all map to "CONFIRMED" only for
  // personal-agent purposes; anything other than PLANNING/STALE is
  // surfaced as CONFIRMED so the agent has a stable, non-leaky label.
  const tripStatus: PersonalTripContext["tripStatus"] =
    trip.status === "DRAFT" || trip.status === "PLANNING" || trip.status === "STALE"
      ? trip.status
      : "CONFIRMED";
  return personalTripContextSchema.parse({
    tripId: trip.id,
    tripName: trip.name,
    tripStatus,
    travelDateStart: trip.travelDateStart,
    travelDateEnd: trip.travelDateEnd,
    destinationCandidates: trip.destinationCandidates,
  });
}

class SafeConversationDeltaGate {
  private pending = "";
  private approved = "";
  private sequence = 0;
  rawText = "";
  private readonly traceparent: string | undefined;

  constructor(private readonly run: AgentTaskRow, traceparent?: string) {
    this.traceparent = traceparent;
  }

  async push(delta: string): Promise<void> {
    if (!delta) return;
    this.rawText += delta;
    this.pending += delta;

    let boundary = completeSentenceBoundary(this.pending);
    while (boundary > 0) {
      const segment = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary);
      await this.approveAndPublish(segment);
      boundary = completeSentenceBoundary(this.pending);
    }
  }

  async flush(): Promise<void> {
    if (this.pending) {
      const segment = this.pending;
      this.pending = "";
      await this.approveAndPublish(segment);
    }
  }

  private async approveAndPublish(segment: string): Promise<void> {
    const candidate = this.approved + segment;
    if (containsUnsupportedOperationalClaim(candidate)) {
      // Keep unsafe text in volatile Worker memory only. The final policy gate
      // will replace the whole answer with a deterministic safe refusal.
      return;
    }
    this.approved = candidate;
    for (const delta of boundedTextChunks(segment, agentTaskConfig.maxDeltaBytes)) {
      await publishAgentStreamEvent({
        event: "message.delta",
        runId: this.run.id,
        generationAttempt: this.run.generationAttempt,
        sequence: this.sequence,
        delta,
        traceparent: this.traceparent,
      });
      this.sequence += 1;
    }
  }
}

function completeSentenceBoundary(value: string): number {
  let boundary = 0;
  const pattern = /[.!?。！？](?:\s+|$)|\n+/gu;
  for (const match of value.matchAll(pattern)) {
    boundary = (match.index ?? 0) + match[0].length;
  }
  return boundary;
}

function boundedTextChunks(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (chunk && Buffer.byteLength(chunk + character, "utf8") > maxBytes) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function publishPhase(
  run: AgentTaskRow,
  phase: Extract<AgentStreamEvent, { event: "run.phase" }>["phase"],
  traceparent?: string,
) {
  return publishAgentStreamEvent({
    event: "run.phase",
    runId: run.id,
    generationAttempt: run.generationAttempt,
    phase,
    traceparent,
  });
}

/**
 * Quick orchestration. A proactive intro run is server-enqueued on Solo
 * trip activation; it carries no user message and no conversation input.
 * We tag the run via `researchIntentDraft.proactiveIntro === true`. The
 * flag lives in the persisted draft JSON so we never need a separate
 * column or migration to gate this code path.
 */
function isProactiveIntroRun(run: AgentTaskRow): boolean {
  const draft = run.researchIntentDraft;
  if (!draft || typeof draft !== "object") return false;
  // The DB column type doesn't expose `proactiveIntro` (it's an optional
  // forward-looking flag), so we cast through unknown to a loose record.
  return (draft as unknown as Record<string, unknown>).proactiveIntro === true;
}

/**
 * Proactive intro worker. Deterministic template + one SSE event + a
 * persisted ASSISTANT message. No LLM, no setup session, no classifier,
 * no readiness evaluation. The first real user turn goes through the
 * normal pipeline.
 */
async function handleProactiveIntro(params: {
  run: AgentTaskRow;
  ctx: RequestContext;
}): Promise<void> {
  // No locale on RequestContext yet — default zh-CN for the deterministic
  // intro template. The i18n helper accepts undefined and falls back.
  const intro = buildProactiveIntro("zh-CN");
  metrics.inc("personal_research_proactive_intro_total", { outcome: "rendered" });

  await publishAgentStreamEvent({
    event: "message.delta",
    runId: params.run.id,
    generationAttempt: params.run.generationAttempt,
    sequence: 0,
    delta: intro.content,
    traceparent: params.ctx.traceparent,
  });
  await publishAgentStreamEvent({
    event: "turn.completed",
    runId: params.run.id,
    generationAttempt: params.run.generationAttempt,
    assistantMessageId: params.run.assistantMessageId ?? crypto.randomUUID(),
    traceparent: params.ctx.traceparent,
  });
}
