import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

import { DefaultPolicyGate } from "../../agents/policy-gate.js";
import { db } from "../../db/database.js";
import { personalResearchEvidence, sharedTrips, tripMembers } from "../../db/schema.js";
import { ApiError } from "../../middleware/error-handler.js";
import { metrics } from "../../observability/metrics.js";
import { isPersonalResearchCapabilityAllowed } from "../../config/personal-research-allowed-capabilities.js";
import {
  containsUnsupportedOperationalClaim,
} from "../../policy/conversation-safety.js";
import { buildConversationContext } from "../../services/conversation-context-service.js";
import { buildConversationMemoryContext } from "../../services/conversation-memory-context.js";
import { loadLatestResearchEvidence } from "../../services/research-evidence-service.js";
import { proposeTripBriefFromTurn } from "../../services/trip-brief-proposal-service.js";
import { executePersonalResearch } from "../../services/personal-research-service.js";
import {
  executeTravelConversation,
  travelConversationSkill,
  travelConversationInputSchema,
  travelConversationOutputSchema,
} from "../../skills/personal/travel-conversation-skill.js";
import { personalTripContextSchema, type PersonalTripContext } from "../../skills/personal/personal-trip-context-schema.js";
import type { AgentStreamEvent } from "../../types/schemas.js";
import { personalResearchHotelDraftSchema } from "../../types/schemas.js";
import type { ModelToolDefinition, ModelToolDispatcher } from "../../providers/model-gateway.js";
import type { RequestContext } from "../../utils/context.js";
import { agentTaskConfig } from "../config.js";
import { publishAgentStreamEvent } from "../task-stream-publisher.js";
import type { AgentTaskRow } from "../task-repository.js";
import { loadConversationTurnInput } from "../task-repository.js";
import { buildProactiveIntro } from "../../i18n/proactive-intro.js";

/**
 * Phase 4: the LLM-facing tool definition for live hotel evidence. The
 * model only ever calls this — no other tools are registered for the
 * Personal conversation worker. Server-side arguments validation lives in
 * `personalResearchHotelDraftSchema`, but the `kind` discriminator is
 * injected by the dispatch closure (the LLM never sends it).
 */
const HOTEL_SEARCH_TOOL: ModelToolDefinition = {
  name: "hotel.search",
  description: "Search live hotel evidence for one controlled destination. Server binds city/date/occupancy/currency; never invent authority fields.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["cityCode", "checkIn", "checkOut", "occupancy", "currency"],
    properties: {
      cityCode: { type: "string" },
      checkIn: { type: "string", format: "date" },
      checkOut: { type: "string", format: "date" },
      occupancy: {
        type: "object",
        additionalProperties: false,
        required: ["adults", "rooms"],
        properties: {
          adults: { type: "integer", minimum: 1, maximum: 8 },
          rooms: { type: "integer", minimum: 1, maximum: 8 },
        },
      },
      currency: { type: "string", minLength: 3, maxLength: 3 },
    },
  },
};

/**
 * Returns `true` when the conversation worker should hand the `hotel.search`
 * tool definition + dispatcher to the streaming gateway. The flag is the
 * rollout lever: keep it off in `.env.example`, flip it on per-environment
 * after a deploy. Both the feature flag AND the capability allow-list must
 * be on; either one alone keeps the conversation prose-only.
 */
function conversationToolDispatchEnabled(): boolean {
  if (process.env.PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED !== "true") return false;
  if (process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED !== "true") return false;
  return isPersonalResearchCapabilityAllowed("hotel.search");
}

/**
 * Canonicalises an object so the hash is order-stable. Mirrors the helper
 * in `apps/api/src/agents/skill-registry.ts:20`. Duplicated locally so the
 * worker does not need to import the registry just for one helper.
 */
function canonicalizeForHash(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeForHash).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeForHash(v)}`).join(",")}}`;
}

/**
 * Builds the conversation worker's tool dispatch closure for `hotel.search`.
 *   - Validates arguments against `personalResearchHotelDraftSchema`.
 *   - Probes `personal_research_evidence` by `(run_id, capability)` — the
 *     existing unique index `personal_research_evidence_run_capability_unique`
 *     makes a second invocation on the same run a no-op (no Nuitee call).
 *   - When a fresh search runs, emits a `run.phase RESEARCHING` SSE event
 *     so the UI shows a loading state during the provider roundtrip.
 *   - Returns the bounded `PersonalResearchEvidenceSummary` JSON to the
 *     LLM. The summary shape is what the model already receives as
 *     `researchEvidence` on the next turn, so the second LLM turn has all
 *     the grounded context it needs.
 */
function buildHotelSearchDispatcher(params: {
  run: AgentTaskRow;
  signal: AbortSignal;
  traceparent?: string;
}): ModelToolDispatcher {
  return async (call) => {
    if (call.name !== "hotel.search") {
      throw new Error(`Unsupported tool call from conversation: ${call.name}`);
    }
    // Inject the discriminator the LLM does not send, then validate.
    const parsed = personalResearchHotelDraftSchema.safeParse({
      kind: "HOTEL_SEARCH",
      ...(typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {}),
    });
    if (!parsed.success) {
      throw new Error(`Invalid hotel.search arguments: ${parsed.error.message}`);
    }
    const draft = parsed.data;
    const fingerprint = createHash("sha256")
      .update(canonicalizeForHash(draft))
      .digest("hex");

    // Dedup probe: existing row on this run for `hotel.search` wins.
    const [existing] = await db.select({
      resultJson: personalResearchEvidence.resultJson,
      capturedAt: personalResearchEvidence.capturedAt,
    })
      .from(personalResearchEvidence)
      .where(and(
        eq(personalResearchEvidence.runId, params.run.id),
        eq(personalResearchEvidence.capability, "hotel.search"),
      ))
      .orderBy(desc(personalResearchEvidence.capturedAt))
      .limit(1);
    if (existing) {
      return { ...(existing.resultJson as Record<string, unknown>), draftHash: fingerprint, deduped: true };
    }

    // Tell the UI a tool-driven search is in flight so the chat can show a
    // loading state. Mirrors `personal-research-task-handler.ts:81`.
    await publishPhase(params.run, "RESEARCHING", params.traceparent);

    // Use the orchestrator, not the raw executor — it persists the bounded
    // summary into `personal_research_evidence` so the next conversation
    // turn (and any other reader) can see the result.
    const result = await executePersonalResearch({
      run: params.run,
      draft,
      signal: params.signal,
    });
    return { ...result.summary, draftHash: fingerprint, deduped: false, evidenceId: result.evidenceId };
  };
}

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

  const execution = new AbortController();
  const abortFromTask = () => execution.abort(params.signal.reason);
  if (params.signal.aborted) abortFromTask();
  else params.signal.addEventListener("abort", abortFromTask, { once: true });
  const timeout = setTimeout(() => {
    const error = new Error("Conversation Skill timed out");
    error.name = "AbortError";
    execution.abort(error);
  }, travelConversationSkill.timeoutMs);

  // Phase 4: build tool context when the rollout flag AND the capability
  // allow-list are both on. Outside that window, the call falls through to
  // the prose-only path with byte-identical behaviour to before Phase 4.
  const toolDispatchEnabled = conversationToolDispatchEnabled();
  const toolContext: {
    tools?: ModelToolDefinition[];
    dispatchTool?: ModelToolDispatcher;
    evidenceBacked?: boolean;
    userConfirmed?: boolean;
  } = {};
  // The user's most recent message expresses a "go" intent when it STARTS
  // with any of these markers. The marker may be followed by a currency
  // code, a punctuation mark, or whitespace (e.g. "确认搜索", "确认搜索 TWD",
  // "go ahead.", "yes, search"); anything longer is treated as a regular
  // question so off-topic replies do not slip through. Keep the list narrow
  // enough that an off-topic reply does not slip through.
  toolContext.userConfirmed = /^\s*(确认搜索|yes[\s,.]+(?:search|please|go)|go ahead|execute search|执行搜索|开始搜索|继续|search now|do it|ok\s+search|please search)([\s.,!?]|$)/i.test(
    input.question,
  );
  let evidenceDispatched = false;
  if (toolDispatchEnabled) {
    const baseDispatch = buildHotelSearchDispatcher({
      run: params.run,
      signal: execution.signal,
      traceparent: params.ctx.traceparent,
    });
    toolContext.tools = [HOTEL_SEARCH_TOOL];
    toolContext.dispatchTool = async (call) => {
      // Flip the flag the moment a tool call fires so the streaming gate
      // relaxes the price/hotel and availability/hotel safety rules for
      // the second stream's grounded summary. The flag starts false; only
      // an actual dispatch turns it on.
      evidenceDispatched = true;
      return baseDispatch(call);
    };
  }

  const gate = new SafeConversationDeltaGate(
    params.run,
    params.ctx.traceparent,
    () => evidenceDispatched,
  );

  let output;
  try {
    output = await executeTravelConversation({
      ctx: params.ctx,
      policyGate: new DefaultPolicyGate("personal"),
    }, input, execution.signal, (delta) => gate.push(delta), toolContext);
  } finally {
    clearTimeout(timeout);
    params.signal.removeEventListener("abort", abortFromTask);
  }

  await publishPhase(params.run, "VALIDATING", params.ctx.traceparent);
  const parsed = travelConversationOutputSchema.parse(output);
  if (
    parsed.responseMode === "MODEL"
    && containsUnsupportedOperationalClaim(parsed.content, { evidenceBacked: evidenceDispatched })
  ) {
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
  private readonly getEvidenceBacked: () => boolean;

  constructor(
    private readonly run: AgentTaskRow,
    traceparent: string | undefined,
    getEvidenceBacked: () => boolean,
  ) {
    this.traceparent = traceparent;
    // Read lazily on every segment so the gate reflects the latest
    // evidenceBacked state — flips from false to true mid-stream when the
    // dispatch closure fires for this turn.
    this.getEvidenceBacked = getEvidenceBacked;
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
    if (containsUnsupportedOperationalClaim(candidate, { evidenceBacked: this.getEvidenceBacked() })) {
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
