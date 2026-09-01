import { and, eq } from "drizzle-orm";

import { DefaultPolicyGate } from "../../agents/policy-gate.js";
import { db } from "../../db/database.js";
import { sharedTrips, tripMembers } from "../../db/schema.js";
import { ApiError } from "../../middleware/error-handler.js";
import { metrics } from "../../observability/metrics.js";
import {
  containsUnsupportedOperationalClaim,
} from "../../policy/conversation-safety.js";
import {
  RESEARCH_INTENT_CLASSIFIER_VERSION,
  classifyResearchIntent,
} from "../../services/personal-research-intent-classifier.js";
import { evaluateReadiness } from "../../services/personal-research-readiness-service.js";
import { buildConversationContext } from "../../services/conversation-context-service.js";
import { proposeTripBriefFromTurn } from "../../services/trip-brief-proposal-service.js";
import {
  generateSetupFollowups,
} from "../../services/setup-followup-generator.js";
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
import {
  persistResearchIntentDraft,
  supersedePriorProposedDraft,
  type PersistedResearchIntentDraft,
} from "../task-repository.js";
import { publishAgentStreamEvent } from "../task-stream-publisher.js";
import type { AgentTaskRow } from "../task-repository.js";
import { loadConversationTurnInput } from "../task-repository.js";
import { getOrOpenSession } from "../../services/personal-research-setup-service.js";
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
  const input = travelConversationInputSchema.parse({
    ...turnInput,
    tripContext,
    threadContext: context.messages,
  });

  // ─── Personal Research Intent Routing — Phase 1 ─────────────────────────
  // High-confidence research requests (verb + travel object) skip the LLM
  // path entirely and persist a non-executable draft. The owner must then
  // explicitly confirm via POST /trips/:tripId/research, which rebuilds
  // every authority field from server-owned state. Spec §5.1, §5.3.
  const classified = classifyResearchIntent({
    question: turnInput.question,
    locale: "zh-CN",
  });
  if (classified.kind === "PROPOSED") {
    return handleClassifiedResearchRequest({
      run: params.run,
      ctx: params.ctx,
      input,
      classifiedIntent: classified.intent,
    });
  }

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

// ─── Personal Research Intent — classified branch ──────────────────────────

interface ClassifiedBranchParams {
  run: AgentTaskRow;
  ctx: RequestContext;
  input: ReturnType<typeof travelConversationInputSchema.parse>;
  classifiedIntent: {
    kind: "RESEARCH_ONLY" | "PROPOSE_PLAN";
    requestedCapabilities: Array<
      "flight" | "accommodation" | "hotel" | "activities" |
      "places" | "navigation" | "mobility" | "readiness"
    >;
  };
}

/**
 * Handle a high-confidence research request: persist the draft under the
 * worker-held lease, evaluate readiness, publish `research.intent_extracted`
 * SSE, and return a deterministic confirmation/setup/place-selection reply.
 *
 * The branch NEVER calls the LLM. If the lease is lost mid-write (returned
 * `null`), we abort the proposal branch without falling back to LLM — a
 * classified turn must never silently degrade to ordinary conversation.
 * Spec §5.3.
 */
async function handleClassifiedResearchRequest(
  params: ClassifiedBranchParams,
): Promise<ReturnType<typeof travelConversationOutputSchema.parse>> {
  if (!params.run.tripId) {
    // Classification requires a trip context; reject here rather than
    // pretend we can propose a draft.
    throw new ApiError(422, "Unprocessable Entity", "RESEARCH_PROPOSAL_REQUIRES_TRIP");
  }
  if (!params.run.leaseToken) {
    throw new ApiError(500, "Internal Server Error", "Conversation task missing leaseToken");
  }
  if (!params.run.threadId) {
    throw new ApiError(500, "Internal Server Error", "Conversation task missing threadId");
  }

  const readiness = await evaluateReadiness({
    tripId: params.run.tripId,
    ownerUserId: params.run.createdByUserId,
    intentRunId: params.run.id,
    requestedCapabilities: params.classifiedIntent.requestedCapabilities,
  });

  const draft: PersistedResearchIntentDraft = {
    schemaVersion: 1,
    kind: params.classifiedIntent.kind,
    requestedCapabilities: params.classifiedIntent.requestedCapabilities,
    classifierVersion: RESEARCH_INTENT_CLASSIFIER_VERSION,
    readiness: readiness.readiness,
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    missing: readiness.missing,
  };

  // Lease-guarded write: supersede prior PROPOSED drafts on the same
  // thread, then persist the new draft. Wrapped in a single transaction
  // so a thread never carries two PROPOSED rows concurrently.
  const persistedDraft = await db.transaction(async (tx) => {
    await supersedePriorProposedDraft({
      threadId: params.run.threadId!,
      excludingRunId: params.run.id,
      tx,
    });
    return persistResearchIntentDraft({
      runId: params.run.id,
      leaseToken: params.run.leaseToken!,
      draft,
      tx,
    });
  });

  if (!persistedDraft) {
    metrics.inc("personal_research_intent_confirmation_total", { outcome: "lease_lost" });
    // Lease lost mid-flight; abandon the proposal branch rather than
    // silently fall back to LLM. The standard lease-loss termination
    // path will record the terminal state.
    throw new ApiError(409, "Conflict", "RESEARCH_DRAFT_LEASE_LOST");
  }

  // Emit metrics — bounded labels only. Per-capability counters roll up
  // each capability once per classified turn; for multi-capability drafts
  // (PROPOSE_PLAN) we increment per capability so dashboards can filter by
  // surface without leaking the question.
  for (const capability of params.classifiedIntent.requestedCapabilities) {
    metrics.inc("personal_research_intent_total", {
      capability,
      disposition: "proposed",
    });
    metrics.inc("personal_research_readiness_total", {
      capability,
      outcome: readiness.readiness === "READY"
        ? "ready"
        : readiness.readiness === "NEEDS_PLACE_SELECTION"
          ? "needs_place_selection"
          : "needs_setup",
    });
  }

  // Publish `research.intent_extracted`. The event payload is the closed
  // shape from `researchIntentExtractedEventSchema` — never the original
  // question text, never place/profiling/provider raw data.
  await publishAgentStreamEvent({
    event: "research.intent_extracted",
    runId: params.run.id,
    generationAttempt: params.run.generationAttempt,
    intent: {
      kind: params.classifiedIntent.kind,
      requestedCapabilities: params.classifiedIntent.requestedCapabilities,
    },
    readiness: readiness.readiness,
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    missing: readiness.missing,
    schemaVersion: 1,
    classifierVersion: RESEARCH_INTENT_CLASSIFIER_VERSION,
    traceparent: params.ctx.traceparent,
  });

  // ─── §9 — Conversational setup followup (NEEDS_SETUP branch) ────────────
  // Eagerly open the setup session so the owner can fill in fields without
  // a separate API round-trip; generate ONE follow-up question via the
  // bounded LLM call (with deterministic fallback); persist it as the
  // ASSISTANT message and publish `research.setup.followup` SSE so the chat
  // surfaces a follow-up bubble alongside the existing confirmation card.
  let content = buildClassifiedResearchReply(readiness.readiness);
  if (readiness.readiness === "NEEDS_SETUP") {
    let setupFollowups: Awaited<ReturnType<typeof generateSetupFollowups>> = [];
    try {
      // Open (or refresh) the session. Eager so a refresh after the SSE
      // reconnects can recover the session from `GET /agent-runs/:runId`.
      await getOrOpenSession({
        ctx: params.ctx,
        runId: params.run.id,
        tripId: params.run.tripId,
        ownerUserId: params.run.createdByUserId,
        requestedCapabilities: params.classifiedIntent.requestedCapabilities,
      });
      // Multi-slot follow-up — generateSetupFollowups runs the existing
      // single-question generator in a loop (≤3 questions per turn),
      // preserving the wire shape (one SSE event per question). The
      // server-owned chat bubble renderer will dedupe by questionCode.
      setupFollowups = await generateSetupFollowups({
        ctx: params.ctx,
        tripId: params.run.tripId,
        ownerUserId: params.run.createdByUserId,
        locale: "zh-CN",
        requestedMissing: readiness.missing,
        filledFieldNames: [],
        maxQuestions: 3,
      });
    } catch {
      metrics.inc("personal_research_setup_session_total", { outcome: "open_failed" });
      // The session open failure MUST NOT block the draft — fall through
      // with no followup so the owner still sees the existing
      // ResearchSetupCard. The error is logged via the open_failed counter.
    }
    // Append the first followup's prompt text to the assistant content so
    // it surfaces in the chat bubble stream; additional followups ride
    // their own SSE events.
    const firstFollowupPrompt = setupFollowups[0]?.promptText;
    if (setupFollowups.length > 0) {
      for (const fu of setupFollowups) {
        await publishAgentStreamEvent({
          event: "research.setup.followup",
          runId: params.run.id,
          generationAttempt: params.run.generationAttempt,
          followup: {
            questionCode: fu.questionCode as Extract<
              Parameters<typeof publishAgentStreamEvent>[0],
              { event: "research.setup.followup" }
            >["followup"]["questionCode"],
            promptText: fu.promptText,
          },
          source: fu.source,
          traceparent: params.ctx.traceparent,
        });
      }
      if (firstFollowupPrompt) {
        content = `${buildClassifiedResearchReply(readiness.readiness)}\n${firstFollowupPrompt}`;
      }
    }
  }

  await publishAgentStreamEvent({
    event: "message.delta",
    runId: params.run.id,
    generationAttempt: params.run.generationAttempt,
    sequence: 0,
    delta: content,
    traceparent: params.ctx.traceparent,
  });
  return travelConversationOutputSchema.parse({
    content,
    responseMode: "MODEL",
  });
}

/**
 * Deterministic assistant copy for the classified branch. The string is
 * intentionally generic — the UI uses the persisted draft to render the
 * real confirmation / setup / place-selection card.
 */
function buildClassifiedResearchReply(
  readiness: "READY" | "READY_WITH_WARNINGS" | "NEEDS_SETUP" | "NEEDS_PLACE_SELECTION",
): string {
  if (readiness === "READY" || readiness === "READY_WITH_WARNINGS") {
    return "我已准备好发起研究。请在下方确认卡中检查研究范围后点击「确认运行」开始。";
  }
  if (readiness === "NEEDS_PLACE_SELECTION") {
    return "路线研究需要先选择出发地和目的地。请在下方确认卡中指定两个有效地点。";
  }
  return "发起研究前还需要补充一些行程设置。请在下方确认卡中查看并补全所缺项目。";
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
