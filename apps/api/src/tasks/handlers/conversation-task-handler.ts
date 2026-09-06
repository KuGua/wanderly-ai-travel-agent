import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { loadSharedPlanningState } from "../../services/shared-planning-state-service.js";
import { createHash } from "node:crypto";
import { z } from "zod";

import { DefaultPolicyGate } from "../../agents/policy-gate.js";
import { db } from "../../db/database.js";
import { personalResearchEvidence, sharedTrips, tripMembers } from "../../db/schema.js";
import { ApiError } from "../../middleware/error-handler.js";
import { metrics } from "../../observability/metrics.js";
import { logSafeRuntimeEvent } from "../../observability/telemetry.js";
import { isPersonalResearchCapabilityAllowed } from "../../config/personal-research-allowed-capabilities.js";
import {
  containsUnsupportedOperationalClaim,
  evidenceBackedConversationFallback,
} from "../../policy/conversation-safety.js";
import { buildConversationContext } from "../../services/conversation-context-service.js";
import { buildConversationMemoryContext } from "../../services/conversation-memory-context.js";
import { loadLatestResearchEvidence } from "../../services/research-evidence-service.js";
import {
  isBriefDestinationCountry,
  mergeTripBriefProposal,
  proposeTripBriefFromTurn,
  withoutDestinationCandidates,
  withoutImplicitDeparture,
} from "../../services/trip-brief-proposal-service.js";
import { resolveTitleDestinationLabel } from "../../services/trip-title-destination-label.js";
import { applyTitleDestinationLabel } from "../../services/trip-title-label-service.js";
import { executePersonalResearch } from "../../services/personal-research-service.js";
import {
  loadConversationHotelSearchState,
  saveConversationHotelSearchState,
} from "../../services/conversation-hotel-search-state-service.js";
import {
  loadConversationFlightSearchState,
  saveConversationFlightSearchState,
} from "../../services/conversation-flight-search-state-service.js";
import {
  executeTravelConversation,
  travelConversationSkill,
  travelConversationInputSchema,
  travelConversationOutputSchema,
} from "../../skills/personal/travel-conversation-skill.js";
import { personalTripContextSchema, type PersonalTripContext } from "../../skills/personal/personal-trip-context-schema.js";
import { extractConversationHandoffBatch } from "../../services/conversation-handoff-extraction-service.js";
import {
  decideDestinationCueForTurn,
  type ResolvedDestinationCueDecision,
} from "../../skills/personal/destination-cue-decision-skill.js";
import {
  type ResolvedOfferCueDecision,
} from "../../services/offer-cue-service.js";
import { getUserMessageSequenceForRun } from "../../services/personal-research-sequence.js";
import { listVisibleOfferCandidatesForThread } from "../../services/personal-research-offer-candidate-service.js";
import { modelGateway } from "../../providers/gateway-factory.js";
import {
  incrementOfferCueMetrics,
  observeOfferCueResolverDuration,
} from "../../observability/metrics-counters.js";
import type { AgentStreamEvent } from "../../types/schemas.js";
import { personalResearchHotelDraftSchema, personalResearchFlightDraftSchema } from "../../types/schemas.js";
import type { ConversationResponseConstraint, ModelToolDefinition, ModelToolDispatcher, TripBriefProposal } from "../../providers/model-gateway.js";
import type { PersonalResearchOperationCapability } from "../../config/personal-research-allowed-capabilities.js";
import type { RequestContext } from "../../utils/context.js";
import { agentTaskConfig } from "../config.js";
import { publishAgentStreamEvent } from "../task-stream-publisher.js";
import type { AgentTaskRow } from "../task-repository.js";
import { loadConversationTurnInput } from "../task-repository.js";
import { buildProactiveIntro } from "../../i18n/proactive-intro.js";
import { ToolCallDeduplicator, requiresOwnerConfirmation } from "../../agents/personal-research-tool-policy.js";
import { buildDeterministicFlightDraft } from "../../services/deterministic-flight-draft.js";
import {
  personalResearchOperationCapabilitySchema,
  toolSettledEventSchema,
} from "../../types/schemas.js";
import {
  explainToolFailure,
  PERSONAL_RESEARCH_TOOLS,
  createPersonalResearchDispatcher,
} from "../../agents/personal-research-tools.js";

/**
 * Phase 4: the LLM-facing tool definitions for live evidence. Server-side
 * arguments validation lives in the matching `personalResearch*DraftSchema`,
 * but the `kind` discriminator is injected by the dispatch closure (the LLM
 * never sends it). Which tools actually get registered for a given turn is
 * decided in `handleConversationTask` from the capability allow-list — a
 * definition existing here does not by itself expose it to the model.
 */
const HOTEL_SEARCH_TOOL: ModelToolDefinition = {
  name: "hotel.search",
  description:
    "Search live hotel evidence for one controlled destination. Server binds city/date/occupancy/currency; never invent authority fields. "
    + "cityCode is a single city (IATA city code or city name) — a country, prefecture or region is not one. "
    + "Fields you omit keep the value already stored for this thread, so when the traveller names a new destination you MUST send the new cityCode; "
    + "if their destination does not resolve to one city, ask which city instead of calling this tool, and never let a previously stored city stand in for it.",
  parameters: {
    type: "object",
    additionalProperties: false,
    // Only the city is required. Dates, occupancy and currency may be filled
    // in over several turns and inheriting them is harmless, but the city is
    // the identity of the search: inheriting it silently searched Shanghai
    // when the traveller had moved on to Japan, and the reply named the
    // wrong place with real prices attached.
    required: ["cityCode"],
    properties: {
      cityCode: { type: "string", description: "One city — IATA city code or city name. A country, prefecture or region is not a city." },
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

// This partial boundary deliberately validates only transport shape. The
// merged, complete draft is always checked by personalResearchHotelDraftSchema
// before it is persisted or reaches a provider. Keeping it separate avoids
// weakening the full schema's date-order refinement just to support `{}`.
const hotelSearchToolArgumentsSchema = z.object({
  cityCode: z.string().optional(),
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  occupancy: z.object({
    adults: z.number().optional(),
    rooms: z.number().optional(),
  }).strict().optional(),
  currency: z.string().optional(),
}).strict();

/**
 * Phase 4: the LLM-facing tool definition for live flight evidence.
 * Mirrors `HOTEL_SEARCH_TOOL` — no `required` array so an explicit
 * "确认搜索" can invoke it with `{}` and reuse the server-persisted state.
 */
const FLIGHT_SEARCH_TOOL: ModelToolDefinition = {
  name: "flight.search",
  description: "Search live flight evidence for one controlled origin/destination pair. Server binds route/date/passenger/cabin/currency; never invent authority fields.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      originId: { type: "string", minLength: 3, maxLength: 3 },
      destinationId: { type: "string", minLength: 3, maxLength: 3 },
      tripType: { type: "string", enum: ["ONE_WAY", "ROUND_TRIP"] },
      departureDate: { type: "string", format: "date" },
      returnDate: { type: "string", format: "date" },
      adults: { type: "integer", minimum: 1, maximum: 9 },
      cabin: { type: "string", enum: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] },
      currency: { type: "string", minLength: 3, maxLength: 3 },
    },
  },
};

// Mirrors `hotelSearchToolArgumentsSchema`: partial transport-shape boundary
// only. The merged, complete draft is always checked against
// `personalResearchFlightDraftSchema` before it is persisted or dispatched.
const flightSearchToolArgumentsSchema = z.object({
  originId: z.string().optional(),
  destinationId: z.string().optional(),
  tripType: z.enum(["ONE_WAY", "ROUND_TRIP"]).optional(),
  departureDate: z.string().optional(),
  returnDate: z.string().optional(),
  adults: z.number().optional(),
  cabin: z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]).optional(),
  currency: z.string().optional(),
}).strict();

/**
 * Returns `true` when the conversation worker should hand the given tool's
 * definition + dispatcher to the streaming gateway for this capability. The
 * env flags are the rollout lever: keep them off in `.env.example`, flip
 * them on per-environment after a deploy. Both feature flags AND the
 * capability allow-list must be on; any one alone keeps that capability
 * prose-only.
 */
function conversationToolDispatchEnabled(capability: PersonalResearchOperationCapability): boolean {
  if (process.env.PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED !== "true") return false;
  if (process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED !== "true") return false;
  return isPersonalResearchCapabilityAllowed(capability);
}

/**
 * Single global rollout flag for Flight / Hotel Offer Cue (commit b85da5a
 * design docs). When off, the conversation worker skips both cue promises
 * and no `flight.offer_cue_ready` / `hotel.offer_cue_ready` events fire.
 * Capability-scoped rollout lives in `OFFER_CUE_ENABLED_CAPABILITIES` (csv);
 * default value covers both flight and hotel.
 */
function offerCueEnabledFor(capability: "flight" | "hotel"): boolean {
  if (process.env.OFFER_CUE_ENABLED !== "true") return false;
  const allowList = (process.env.OFFER_CUE_ENABLED_CAPABILITIES ?? "flight,hotel")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return allowList.includes(capability);
}

/**
 * Resolver entry point for Flight / Hotel Offer Cue (Stage 3). Loads the
 * bounded visible-candidate projection, calls the model gateway, then
 * re-validates freshness / ownership / same-scope dedup before returning
 * a `ResolvedOfferCueDecision`. Always fail-closed: a resolver failure
 * must never block the conversation reply.
 */
async function resolveOfferCueForTurn(params: {
  ctx: { ctx: RequestContext; policyGate: DefaultPolicyGate };
  run: AgentTaskRow;
  capability: "flight" | "hotel";
  question: string;
  locale: "en" | "zh";
  messageSource?: "USER_TURN" | "ASSISTANT_REPLY";
  currentUserMessageSequence: number;
  signal: AbortSignal;
}): Promise<ResolvedOfferCueDecision | null> {
  if (!params.run.tripId || !params.run.threadId) return null;
  const visible = await listVisibleOfferCandidatesForThread({
    threadId: params.run.threadId,
    ownerUserId: params.run.createdByUserId,
    capability: params.capability,
    beforeMessageSequence: params.currentUserMessageSequence,
    now: new Date(),
  });
  if (visible.length === 0) {
    incrementOfferCueMetrics({ capability: params.capability, metric: "decision", outcome: "no_candidates" });
    return null;
  }
  const offerSetId = visible[0]!.offerSetId;
  const inputCandidates = visible.map((row) => ({
    candidateRef: row.candidateRef,
    ordinal: row.ordinal,
    ...(params.capability === "flight"
      ? {
          routeKey: row.routeKey ?? "",
          carrierCode: typeof row.normalizedOfferJson.carrierCode === "string" ? row.normalizedOfferJson.carrierCode : "",
          flightNumber: typeof row.normalizedOfferJson.flightNumber === "string" ? row.normalizedOfferJson.flightNumber : null,
          departureAt: typeof row.normalizedOfferJson.departureAt === "string" ? row.normalizedOfferJson.departureAt : "",
          arrivalAt: typeof row.normalizedOfferJson.arrivalAt === "string" ? row.normalizedOfferJson.arrivalAt : "",
          totalDuration: typeof row.normalizedOfferJson.totalDuration === "string" ? row.normalizedOfferJson.totalDuration : "",
          totalPrice: typeof row.normalizedOfferJson.totalPrice === "number" ? row.normalizedOfferJson.totalPrice : 0,
          currency: typeof row.normalizedOfferJson.currency === "string" ? row.normalizedOfferJson.currency : "USD",
          stopCount: typeof row.normalizedOfferJson.stopCount === "number" ? row.normalizedOfferJson.stopCount : 0,
        }
      : {
          stayKey: row.stayKey ?? "",
          propertyName: typeof row.normalizedOfferJson.propertyName === "string" ? row.normalizedOfferJson.propertyName : "",
          checkIn: typeof row.normalizedOfferJson.checkIn === "string" ? row.normalizedOfferJson.checkIn : "",
          checkOut: typeof row.normalizedOfferJson.checkOut === "string" ? row.normalizedOfferJson.checkOut : "",
          pricePerNight: typeof row.normalizedOfferJson.pricePerNight === "number" ? row.normalizedOfferJson.pricePerNight : 0,
          totalPrice: typeof row.normalizedOfferJson.totalPrice === "number" ? row.normalizedOfferJson.totalPrice : 0,
          currency: typeof row.normalizedOfferJson.currency === "string" ? row.normalizedOfferJson.currency : "USD",
          cancellationSummary: typeof row.normalizedOfferJson.cancellationSummary === "string" ? row.normalizedOfferJson.cancellationSummary : null,
          roomSummary: typeof row.normalizedOfferJson.roomSummary === "string" ? row.normalizedOfferJson.roomSummary : null,
          taxStatus: (row.normalizedOfferJson.taxStatus === "INCLUDED" || row.normalizedOfferJson.taxStatus === "PARTIAL" ? row.normalizedOfferJson.taxStatus : "UNKNOWN") as "INCLUDED" | "PARTIAL" | "UNKNOWN",
        }),
  }));

  const gateway = modelGateway();
  const start = Date.now();
  const timeoutSignal = AbortSignal.timeout(9_000);
  const signal = AbortSignal.any([params.signal, timeoutSignal]);
  let result: { decision: { decision: "PROPOSE" | "NO_CUE" | "NEEDS_CLARIFICATION"; candidates: Array<{ candidateRef: string; intent: "EXPLICIT_SELECT" | "STRONG_PREFERENCE" }>; reasonCode: string }; modelVersion: string; promptVersion: string } | null = null;
  try {
    if (params.capability === "flight") {
      const flightResult = await gateway.decideFlightOfferCue({
        question: params.question,
        offerSetId,
        candidates: inputCandidates as unknown as Parameters<typeof gateway.decideFlightOfferCue>[0]["candidates"],
        locale: params.locale,
        messageSource: params.messageSource ?? "USER_TURN",
        signal,
        ctx: params.ctx.ctx,
      });
      result = flightResult;
    } else {
      const hotelResult = await gateway.decideHotelOfferCue({
        question: params.question,
        offerSetId,
        candidates: inputCandidates as unknown as Parameters<typeof gateway.decideHotelOfferCue>[0]["candidates"],
        locale: params.locale,
        messageSource: params.messageSource ?? "USER_TURN",
        signal,
        ctx: params.ctx.ctx,
      });
      result = hotelResult;
    }
  } catch {
    observeOfferCueResolverDuration({ capability: params.capability, outcome: "upstream_failure", durationMs: Date.now() - start });
    return null;
  }
  if (!result) {
    observeOfferCueResolverDuration({ capability: params.capability, outcome: "upstream_failure", durationMs: Date.now() - start });
    return null;
  }
  observeOfferCueResolverDuration({ capability: params.capability, outcome: "success", durationMs: Date.now() - start });

  if (result.decision.decision === "NO_CUE" || result.decision.decision === "NEEDS_CLARIFICATION") {
    incrementOfferCueMetrics({
      capability: params.capability,
      metric: "decision",
      outcome: result.decision.decision === "NEEDS_CLARIFICATION" ? "needs_clarification" : "no_candidates",
    });
    return null;
  }

  const eligible: ResolvedOfferCueDecision["candidates"] = [];
  const seenScope = new Set<string>();
  for (const candidate of result.decision.candidates) {
    const row = visible.find((r) => r.candidateRef === candidate.candidateRef);
    if (!row) continue;
    const scopeKey = params.capability === "flight" ? row.routeKey : row.stayKey;
    if (scopeKey && seenScope.has(scopeKey)) {
      incrementOfferCueMetrics({ capability: params.capability, metric: "decision", outcome: "skipped_duplicate" });
      continue;
    }
    if (scopeKey) seenScope.add(scopeKey);
    eligible.push({
      ordinal: eligible.length,
      candidateRef: row.candidateRef,
      intent: candidate.intent,
      routeKey: row.routeKey,
      stayKey: row.stayKey,
    });
    if (eligible.length >= 5) break;
  }
  if (eligible.length === 0) return null;
  return {
    capability: params.capability,
    candidates: eligible,
    reasonCode: result.decision.reasonCode as ResolvedOfferCueDecision["reasonCode"],
    modelVersion: result.modelVersion,
    promptVersion: result.promptVersion,
  };
}

/**
 * A standalone confirmation at either end of a complete query — "…，CNY。确认
 * 搜索" and "CNY 确认搜索" both count — but never an embedded fragment such as
 * "如何确认搜索条件". A bare "确认" is included: the buttons send more, but a
 * person answering the model's own "请确认" naturally types just that.
 */
export const CONFIRMATION_PATTERN = /(?:^|[\s，,。.!！？])(?:确认搜索(?:机票|酒店)?|确认|yes[\s,.]+(?:search|please|go)|go ahead|execute search|执行搜索|开始搜索|继续搜索|search now|do it|ok\s+search|please search)(?=$|[\s，,。.!！？])/i;

/**
 * The capability a confirmation names, or `null` when it names none.
 *
 * `null` keeps the behaviour a typed "确认搜索" has always had: the model
 * chooses, because the traveller did not say. Only a confirmation that names
 * a capability narrows to it — which is what the buttons now send, so a
 * button cannot authorise a search other than its own.
 */
export function confirmedCapabilityFrom(question: string): "flight.search" | "hotel.search" | null {
  if (/确认搜索机票|confirm flight search/i.test(question)) return "flight.search";
  if (/确认搜索酒店|confirm hotel search/i.test(question)) return "hotel.search";
  return null;
}

/** Whether a dispatcher may treat this turn as authorised for its own capability. */
export function confirmedFor(
  capability: "flight.search" | "hotel.search",
  userConfirmed: boolean,
  confirmedCapability: "flight.search" | "hotel.search" | null,
): boolean {
  if (!userConfirmed) return false;
  return confirmedCapability === null || confirmedCapability === capability;
}

/**
 * Which search-readiness contracts belong in THIS turn's system prompt.
 *
 * Two rules, in order.
 *
 * A contract is only injected when its tool is actually registered for the
 * turn. Roughly all of each block is instructions for calling that tool —
 * "[Phase 4 — 服务端状态与强制工具调用] … 必须调用 `hotel.search`". Handing
 * those to a model that has no such tool is not merely noise; it is an
 * instruction it cannot carry out.
 *
 * In `DRAFT` a contract additionally requires that the traveller has already
 * engaged that capability — a persisted search state for it, or a
 * confirmation in this very turn. `DRAFT` is the phase whose designated next
 * step is completing the trip brief and pressing "开始规划", and these two
 * blocks were overriding it: a plain "国庆带女朋友去新加坡玩4天" produced four
 * turns of airport codes and room counts, two speculative tool calls, and a
 * pair of search-confirmation buttons, while the brief's own dates stayed
 * empty so the trip could never be activated.
 *
 * This gates the prompt, never the tools: `docs/draft-personal-research-implementation.md`
 * §1 requires that a query the owner explicitly asked for is not blocked for
 * being "not fully planned yet". The tools stay registered in `DRAFT`, so a
 * traveller who does ask for a search still gets one — the model reaches it
 * under the base prompt's own priority 2 ("只有当用户亲自明确提出…才收集其受控
 * 查询条件"), and from the next turn on the persisted state brings the full
 * contract back. Nothing here decides what may be claimed or spent; the
 * safety boundary, the confirmation gate and the capability allow-list are
 * all elsewhere and all unchanged.
 */
export function selectResponseConstraints(params: {
  tripStatus: PersonalTripContext["tripStatus"];
  registeredTools: readonly string[];
  hotelSearchStateExists: boolean;
  flightSearchStateExists: boolean;
  userConfirmed: boolean;
  confirmedCapability: "flight.search" | "hotel.search" | null;
}): ConversationResponseConstraint[] {
  const engaged: Record<"hotel.search" | "flight.search", boolean> = {
    "hotel.search": params.hotelSearchStateExists
      || confirmedFor("hotel.search", params.userConfirmed, params.confirmedCapability),
    "flight.search": params.flightSearchStateExists
      || confirmedFor("flight.search", params.userConfirmed, params.confirmedCapability),
  };
  const contracts = [
    ["hotel.search", "HOTEL_SEARCH_READINESS"],
    ["flight.search", "FLIGHT_SEARCH_READINESS"],
  ] as const;
  return contracts
    .filter(([capability]) => params.registeredTools.includes(capability))
    .filter(([capability]) => params.tripStatus !== "DRAFT" || engaged[capability])
    .map(([, constraint]) => constraint);
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
 *   - Merges model-supplied fields with server-persisted thread state, then
 *     validates the complete result against `personalResearchHotelDraftSchema`.
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
/**
 * How long the same brief goes unsearched after an attempt, whatever came back.
 * Matches the 30 minutes `computeExpiresAt` gives AVAILABLE evidence, so a
 * successful search is re-run exactly when its offers go stale and a failed one
 * is retried on the same rhythm instead of on every message.
 */
const PREFETCH_REPEAT_WINDOW_MS = 30 * 60_000;

/**
 * Runs this trip's flight search from the brief alone, once per set of facts.
 *
 * Reuses `buildFlightSearchDispatcher` rather than reaching for the executor
 * directly, so state persistence, the per-run dedup probe, the RESEARCHING
 * phase event and evidence writing all stay on one path. The only difference
 * from a model-issued call is who decided to make it.
 *
 * Three properties keep this safe to run on every turn:
 *   - the draft comes from the confirmed brief, so it changes only when the
 *     brief does, and `personal_research_evidence` is unique per (run,
 *     capability) — a turn cannot double-charge itself;
 *   - a gap is silent. Not every trip has an origin, a date, or an airport,
 *     and a conversation about temples must not become a conversation about
 *     why a search could not run;
 *   - a failure is silent for the same reason, and never reaches the caller.
 *     A supplier being down is not a reason the traveller cannot chat.
 */
async function prefetchDeterministicFlightEvidence(params: {
  run: AgentTaskRow;
  ctx: RequestContext;
  signal: AbortSignal;
  traceparent?: string;
  tripContext: PersonalTripContext;
}): Promise<void> {
  if (!conversationToolDispatchEnabled("flight.search")) return;
  if (!params.run.threadId || !params.run.tripId || !params.run.userMessageId) return;
  const built = buildDeterministicFlightDraft(params.tripContext);
  if (built.outcome !== "READY") {
    logSafeRuntimeEvent(params.ctx, {
      component: "worker", event: "flight_prefetch", operation: "conversation",
      // "cancelled" is this vocabulary's word for "decided not to run".
      outcome: "cancelled", errorCode: built.gap, relatedRunId: params.run.id,
    });
    return;
  }
  // Once per distinct set of facts, not once per turn. The dispatcher's own
  // dedup probe is keyed on `(run_id, capability)`, which only collapses a
  // repeat inside one turn — so every message was paying for a fresh supplier
  // round-trip, including the ones about temples. `requestFingerprint` already
  // records what was searched, so the same brief asked twice is a read.
  const fingerprint = createHash("sha256")
    .update(canonicalizeForHash(built.value.draft))
    .digest("hex");
  const [fresh] = await db.select({ id: personalResearchEvidence.id })
    .from(personalResearchEvidence)
    .where(and(
      eq(personalResearchEvidence.tripId, params.run.tripId),
      eq(personalResearchEvidence.capability, "flight.search"),
      eq(personalResearchEvidence.requestFingerprint, fingerprint),
      // On `capturedAt`, not `expiresAt`. Only AVAILABLE evidence is given an
      // expiry — everything else stores null, and `expiresAt > now` never
      // matches a null. So a trip whose search came back empty or whose
      // supplier was down deduplicated against nothing and paid for a fresh
      // round-trip on *every* later message, retrying a request already known
      // to fail. The question this asks is "did we just try these exact
      // facts", which has the same answer either way.
      gt(personalResearchEvidence.capturedAt, new Date(Date.now() - PREFETCH_REPEAT_WINDOW_MS)),
    ))
    .limit(1);
  if (fresh) return;

  try {
    const dispatch = buildFlightSearchDispatcher({
      run: params.run,
      ctx: params.ctx,
      signal: params.signal,
      traceparent: params.traceparent,
      // The traveller is not being asked, so record that they did not confirm.
      // The dispatcher consults `TOOL_INVOCATION_MODE`, which no longer
      // requires one for flights; if that ever changes back, this prefetch
      // correctly becomes a no-op instead of quietly spending on their behalf.
      userConfirmed: false,
    });
    // `kind` is the draft's own discriminator; the tool's argument schema is
    // strict and does not carry it, and the dispatcher re-adds it when it
    // merges against persisted state. Passing it through failed the parse and
    // returned INVALID_ARGUMENTS — which is why the outcome is logged below
    // rather than dropped. A dispatcher that declines by *returning* is
    // invisible to a try/catch, and this one went unnoticed through a full
    // browser run.
    const { kind: _kind, ...toolArguments } = built.value.draft;
    void _kind;
    const result = await dispatch({
      id: `prefetch:${params.run.id}`,
      name: "flight.search",
      arguments: toolArguments,
    }) as { outcome?: unknown };
    logSafeRuntimeEvent(params.ctx, {
      component: "worker", event: "flight_prefetch", operation: "conversation",
      outcome: result?.outcome === "AVAILABLE" || result?.outcome === "UNAVAILABLE"
        ? "success"
        : "failure",
      errorCode: typeof result?.outcome === "string" ? result.outcome : "INTERNAL",
      relatedRunId: params.run.id,
    });
  } catch (error) {
    logSafeRuntimeEvent(params.ctx, {
      component: "worker", event: "flight_prefetch", operation: "conversation",
      outcome: "failure",
      errorCode: error instanceof Error ? error.name : "INTERNAL",
      relatedRunId: params.run.id,
    });
  }
}

/**
 * Bookkeeping the model has no use for, removed before the result becomes a
 * tool message.
 *
 * These fields ride back from the dispatchers to carry signals between our own
 * layers — whether a supplier was reached, which evidence row was written. The
 * model read them as part of the answer and wrote a reply citing "由
 * providerDispatched 在 capturedAt 时提供", which is an internal flag quoted at
 * a traveller as though it were a source.
 */
const INTERNAL_TOOL_RESULT_FIELDS = ["providerDispatched", "evidenceId", "draftHash", "deduped"] as const;

function withoutInternalFields(result: unknown): unknown {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const visible = { ...(result as Record<string, unknown>) };
  for (const field of INTERNAL_TOOL_RESULT_FIELDS) delete visible[field];
  return visible;
}

function buildHotelSearchDispatcher(params: {
  run: AgentTaskRow;
  ctx: RequestContext;
  signal: AbortSignal;
  traceparent?: string;
}): ModelToolDispatcher {
  return async (call) => {
    if (call.name !== "hotel.search") {
      throw new Error(`Unsupported tool call from conversation: ${call.name}`);
    }
    const rawArguments = typeof call.arguments === "object" && call.arguments !== null
      ? call.arguments as Record<string, unknown>
      : null;
    if (!rawArguments) return { outcome: "INVALID_ARGUMENTS", code: "TOOL_ARGUMENTS_INVALID" };
    // Partial fields can reuse the server-owned thread state. Unknown fields
    // are rejected before merge; a provider call still requires a complete,
    // validated draft.
    const partial = hotelSearchToolArgumentsSchema.safeParse(rawArguments);
    if (!partial.success) return { outcome: "INVALID_ARGUMENTS", code: "TOOL_ARGUMENTS_INVALID" };
    if (!params.run.threadId || !params.run.tripId || !params.run.userMessageId) {
      throw new Error("Conversation hotel tool task is missing private-thread references");
    }
    const existingState = await loadConversationHotelSearchState({
      threadId: params.run.threadId,
      tripId: params.run.tripId,
      ownerUserId: params.run.createdByUserId,
    });
    const parsed = personalResearchHotelDraftSchema.safeParse({
      ...(existingState?.draft ?? { kind: "HOTEL_SEARCH" }),
      ...partial.data,
      kind: "HOTEL_SEARCH",
    });
    if (!parsed.success) return { outcome: "NEEDS_FIELDS", code: "HOTEL_SEARCH_FIELDS_INCOMPLETE" };
    const draft = parsed.data;
    await saveConversationHotelSearchState({
      ctx: params.ctx,
      threadId: params.run.threadId,
      tripId: params.run.tripId,
      ownerUserId: params.run.createdByUserId,
      userMessageId: params.run.userMessageId,
      draft,
      // Hotel lookup is automatic in the sandbox. Keep the legacy columns
      // unset rather than recording an owner confirmation that never occurred.
      confirmed: false,
    });
    const fingerprint = createHash("sha256")
      .update(canonicalizeForHash(draft))
      .digest("hex");

    // Dedup probe: existing row on this run for `hotel.search` wins.
    const [existingEvidence] = await db.select({
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
    if (existingEvidence) {
      return { ...(existingEvidence.resultJson as Record<string, unknown>), draftHash: fingerprint, deduped: true, providerDispatched: true };
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
    return { ...result.summary, draftHash: fingerprint, deduped: false, evidenceId: result.evidenceId, providerDispatched: true };
  };
}

/**
 * Builds the conversation worker's tool dispatch closure for `flight.search`.
 * Mirrors `buildHotelSearchDispatcher` field-for-field — same two-phase
 * confirm/persist state machine, same dedup-by-`(run_id, capability)` probe,
 * same `RESEARCHING` SSE phase, same bounded evidence-summary return shape.
 *
 * `returnDate` defaults to `null` before merging so a `ONE_WAY` draft with no
 * existing state and no model-supplied `returnDate` still satisfies
 * `personalResearchFlightDraftSchema`'s `.nullable()` (not `.optional()`)
 * field; an explicit value from prior state or this turn's arguments always
 * overrides that default.
 */
function buildFlightSearchDispatcher(params: {
  run: AgentTaskRow;
  ctx: RequestContext;
  signal: AbortSignal;
  traceparent?: string;
  userConfirmed: boolean;
}): ModelToolDispatcher {
  return async (call) => {
    if (call.name !== "flight.search") {
      throw new Error(`Unsupported tool call from conversation: ${call.name}`);
    }
    const rawArguments = typeof call.arguments === "object" && call.arguments !== null
      ? call.arguments as Record<string, unknown>
      : null;
    if (!rawArguments) return { outcome: "INVALID_ARGUMENTS", code: "TOOL_ARGUMENTS_INVALID" };
    // The tool intentionally has no JSON-schema required fields: a later
    // explicit confirmation can invoke it with `{}` and the dispatcher will
    // use the owner-reviewed state. Unknown fields are rejected before merge.
    const partial = flightSearchToolArgumentsSchema.safeParse(rawArguments);
    if (!partial.success) return { outcome: "INVALID_ARGUMENTS", code: "TOOL_ARGUMENTS_INVALID" };
    if (!params.run.threadId || !params.run.tripId || !params.run.userMessageId) {
      throw new Error("Conversation flight tool task is missing private-thread references");
    }
    const existingState = await loadConversationFlightSearchState({
      threadId: params.run.threadId,
      tripId: params.run.tripId,
      ownerUserId: params.run.createdByUserId,
    });
    const merged: Record<string, unknown> = {
      ...(existingState?.draft ?? {}),
      ...partial.data,
      kind: "FLIGHT_SEARCH",
    };
    if (merged.returnDate === undefined) merged.returnDate = null;
    const parsed = personalResearchFlightDraftSchema.safeParse(merged);
    if (!parsed.success) return { outcome: "NEEDS_FIELDS", code: "FLIGHT_SEARCH_FIELDS_INCOMPLETE" };
    const draft = parsed.data;
    const saved = await saveConversationFlightSearchState({
      ctx: params.ctx,
      threadId: params.run.threadId,
      tripId: params.run.tripId,
      ownerUserId: params.run.createdByUserId,
      userMessageId: params.run.userMessageId,
      draft,
      confirmed: params.userConfirmed,
    });
    // `TOOL_INVOCATION_MODE` is meant to have two readers — the loop decides
    // whether a call may be attempted, the dispatcher whether it may execute —
    // but this branch was hard-coded, so the table's flight entry was dead and
    // flipping it would have changed nothing. Read it here and the comment on
    // that table becomes true.
    if (requiresOwnerConfirmation("flight.search") && !params.userConfirmed) {
      return { outcome: "CONFIRMATION_REQUIRED", capability: "flight.search", stateVersion: saved.version };
    }
    const fingerprint = createHash("sha256")
      .update(canonicalizeForHash(draft))
      .digest("hex");

    // Dedup probe: existing row on this run for `flight.search` wins.
    const [existingEvidence] = await db.select({
      resultJson: personalResearchEvidence.resultJson,
      capturedAt: personalResearchEvidence.capturedAt,
    })
      .from(personalResearchEvidence)
      .where(and(
        eq(personalResearchEvidence.runId, params.run.id),
        eq(personalResearchEvidence.capability, "flight.search"),
      ))
      .orderBy(desc(personalResearchEvidence.capturedAt))
      .limit(1);
    if (existingEvidence) {
      return { ...(existingEvidence.resultJson as Record<string, unknown>), draftHash: fingerprint, deduped: true, providerDispatched: true };
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
    return { ...result.summary, draftHash: fingerprint, deduped: false, evidenceId: result.evidenceId, providerDispatched: true };
  };
}

export async function handleConversationTask(params: {
  run: AgentTaskRow;
  ctx: RequestContext;
  signal: AbortSignal;
}): Promise<{
  content: string;
  responseMode: import("../../types/schemas.js").ConversationResponseMode;
  tripBriefProposal?: TripBriefProposal;
  destinationCueDecision?: Promise<ResolvedDestinationCueDecision | null>;
  flightOfferCueDecision?: Promise<ResolvedOfferCueDecision | null>;
  hotelOfferCueDecision?: Promise<ResolvedOfferCueDecision | null>;
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
  const [membership] = await db.select({ userId: tripMembers.userId, role: tripMembers.role })
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
  const { context: tripContext, titleLocale } = await loadPersonalTripContext(params.run.tripId);
  // The bounded same-thread LLM context is built in its own service so
  // the read path stays pure and retryable (§3.1.4 / §6). Failures here
  // bubble up as a terminal task error before any model call.
  const context = await buildConversationContext(params.run);
  // Cross-thread long-term memory for the owner. `buildConversationContext`
  // covers only this thread; without this the assistant restarts from zero
  // in every new thread even though the facts are already stored.
  // Scoped to this trip, so an adjustment made for it wins over the profile
  // without touching what any other trip inherits.
  const memoryContext = await buildConversationMemoryContext(params.run.createdByUserId, params.run.tripId);
  // Run the trip's own flight search before reading evidence back, so this
  // turn already has it. Deliberately ahead of the model and independent of
  // what the traveller said: see `prefetchDeterministicFlightEvidence`.
  await prefetchDeterministicFlightEvidence({
    run: params.run,
    ctx: params.ctx,
    signal: params.signal,
    traceparent: params.ctx.traceparent,
    tripContext,
  });
  // What this trip's own providers last returned. Without it the assistant
  // cannot refer to a search it ran itself: the offers were persisted and
  // never read back.
  const evidence = await loadLatestResearchEvidence(params.run.tripId);
  const hotelSearchState = await loadConversationHotelSearchState({
    threadId: params.run.threadId,
    tripId: params.run.tripId,
    ownerUserId: params.run.createdByUserId,
  });
  const flightSearchState = await loadConversationFlightSearchState({
    threadId: params.run.threadId,
    tripId: params.run.tripId,
    ownerUserId: params.run.createdByUserId,
  });
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
  // The deterministic parser remains the source for non-destination brief
  // fields below. Destination cues deliberately do not use it as a fallback:
  // v2 needs the language classifier to distinguish a neutral city list from
  // actual destination interest.
  const directBriefProposal = proposeTripBriefFromTurn(turnInput.question);
  const destinationCuePromise = tripContext.tripStatus === "DRAFT" && membership.role === "CREATOR"
    ? decideDestinationCueForTurn({
      ctx: { ctx: params.ctx, policyGate: new DefaultPolicyGate("personal") },
      question: turnInput.question,
      currentDestinations: tripContext.destinationCandidates,
      locale: titleLocale ?? "en",
      signal: execution.signal,
    }).catch(() => null)
    : Promise.resolve(null);

  // Flight / Hotel Offer Cue promises (docs/flight-offer-cue-model-draft.md,
  // docs/hotel-offer-cue-model-draft.md). Stage 2/3 share the same resolver
  // path; OFFER_CUE_ENABLED is the rollout lever. fail-closed — model failure
  // must not delay the conversation reply.
  const canOfferCue = tripContext.tripStatus === "DRAFT" && membership.role === "CREATOR";
  const flightOfferCueCurrentSeq = canOfferCue && offerCueEnabledFor("flight") && params.run.tripId
    ? await getUserMessageSequenceForRun({ runId: params.run.id, tripId: params.run.tripId })
    : null;
  const hotelOfferCueCurrentSeq = canOfferCue && offerCueEnabledFor("hotel") && params.run.tripId
    ? await getUserMessageSequenceForRun({ runId: params.run.id, tripId: params.run.tripId })
    : null;
  const flightOfferCuePromise = canOfferCue && offerCueEnabledFor("flight") && flightOfferCueCurrentSeq !== null
    ? resolveOfferCueForTurn({
      ctx: { ctx: params.ctx, policyGate: new DefaultPolicyGate("personal") },
      run: params.run,
      capability: "flight",
      question: turnInput.question,
      locale: titleLocale ?? "en",
      messageSource: "USER_TURN",
      currentUserMessageSequence: flightOfferCueCurrentSeq,
      signal: execution.signal,
    }).catch(() => null)
    : Promise.resolve(null);
  const hotelOfferCuePromise = canOfferCue && offerCueEnabledFor("hotel") && hotelOfferCueCurrentSeq !== null
    ? resolveOfferCueForTurn({
      ctx: { ctx: params.ctx, policyGate: new DefaultPolicyGate("personal") },
      run: params.run,
      capability: "hotel",
      question: turnInput.question,
      locale: titleLocale ?? "en",
      messageSource: "USER_TURN",
      currentUserMessageSequence: hotelOfferCueCurrentSeq,
      signal: execution.signal,
    }).catch(() => null)
    : Promise.resolve(null);
  // The Skill's timeout is a budget for *model* time, not for wall clock. A
  // tool-calling turn spends most of its wall clock inside a live supplier — a
  // hotel search runs 10s+ on its own — so charging that to the same 15s budget
  // aborted the turn while the search was still in flight: the offers were
  // fetched and persisted, the cards rendered, and the traveller was told the
  // model was unreachable.
  //
  // Pausing alone is not a bound, though: a chain of slow suppliers can hold a
  // turn open until the hard cap while the model never runs short. So the
  // paused windows are also metered against `toolBudgetMs` (§5.1 of the
  // planner-resilience design). Exhausting that budget aborts nothing — the
  // dispatcher below short-circuits with a structured UNAVAILABLE and the model
  // still answers with what it already has.
  const { withPausedModelBudget, isToolBudgetExhausted, clear: clearTurnDeadline } = createTurnDeadline({
    modelBudgetMs: travelConversationSkill.timeoutMs,
    toolBudgetMs: agentTaskConfig.conversationToolBudgetMs,
    onAbort: (reason) => {
      const error = new Error(reason);
      error.name = "AbortError";
      execution.abort(error);
    },
    isAborted: () => execution.signal.aborted,
  });

  // Phase 4: build tool context per-capability, from the rollout flag AND
  // the capability allow-list. Each capability is independent — one being
  // off leaves the other's tool dispatch untouched, and both off falls
  // through to the prose-only path with byte-identical behaviour to before
  // Phase 4.
  const toolContext: {
    tools?: ModelToolDefinition[];
    dispatchTool?: ModelToolDispatcher;
    isEvidenceBacked?: () => boolean;
    userConfirmed?: boolean;
    responseConstraints?: readonly ConversationResponseConstraint[];
    hotelSearchState?: import("../../providers/model-gateway.js").ConversationHotelSearchState | null;
    flightSearchState?: import("../../providers/model-gateway.js").ConversationFlightSearchState | null;
  } = {};
  // Server-side explicit confirmation detector. It accepts a standalone
  // confirmation at either end of a complete natural-language query (for
  // example “...，CNY。确认搜索” and “CNY 确认搜索”), but does not treat an
  // embedded phrase such as “如何确认搜索条件” as authorization.
  //
  // A bare “确认” is included: the flight/hotel confirm button sends the
  // full “确认搜索”, but a person replying to the model's own “请确认”
  // prompt by hand naturally just types “确认” — the word-boundary anchors
  // still keep it from matching an embedded fragment like “确认搜索条件”.
  // Read at check time, after the tools have run. A snapshot taken here
  // would always be false.
  toolContext.isEvidenceBacked = () => evidenceDispatched;
  toolContext.userConfirmed = CONFIRMATION_PATTERN.test(input.question);
  // Which search the traveller authorised, when they said. A confirm button
  // means one specific search, and sending it as the bare phrase left the
  // model to guess which: in a thread that had also discussed hotels, the
  // hotel readiness rule won and pressing "search flights" ran a hotel
  // search instead. Naming the capability makes the button's authority as
  // narrow as the button is.
  const confirmedCapability = confirmedCapabilityFrom(input.question);
  toolContext.hotelSearchState = hotelSearchState ? {
    ...hotelSearchState.draft,
    confirmed: hotelSearchState.confirmed,
    version: hotelSearchState.version,
  } : null;
  toolContext.flightSearchState = flightSearchState ? {
    ...flightSearchState.draft,
    confirmed: flightSearchState.confirmed,
    version: flightSearchState.version,
  } : null;
  let evidenceDispatched = false;
  const dispatchers = new Map<string, ModelToolDispatcher>();
  const tools: ModelToolDefinition[] = [];
  const registerToolDispatch = (
    capability: PersonalResearchOperationCapability,
    tool: ModelToolDefinition,
    baseDispatch: ModelToolDispatcher,
  ) => {
    if (!conversationToolDispatchEnabled(capability)) return;
    tools.push(tool);
    dispatchers.set(tool.name, async (call) => {
      await publishToolEvent(params.run, { phase: "started", name: call.name }, params.ctx.traceparent);
      const result = await withPausedModelBudget(() => baseDispatch(call));
      // A readiness save/confirmation prompt is not evidence. Only the
      // server-side provider branch may unlock grounded price/inventory prose.
      // Sticky: a later CONFIRMATION_REQUIRED call in the same turn must not
      // revert a flag an earlier dispatch (or the freshness check below)
      // already earned.
      evidenceDispatched = evidenceDispatched || (result as { providerDispatched?: unknown }).providerDispatched === true;
      // The Skill's own output-side safety check reads `toolContext.isEvidenceBacked()`
      // — a getter closing over this same `evidenceDispatched` variable (set up
      // once, below, before any dispatch runs) — so mutating `evidenceDispatched`
      // here is all that's needed; there's no separate flag to keep in sync.
      await publishToolEvent(params.run, { phase: "settled", name: call.name, ...settledSummary(result) }, params.ctx.traceparent);
      return result;
    });
  };
  registerToolDispatch("hotel.search", HOTEL_SEARCH_TOOL, buildHotelSearchDispatcher({
    run: params.run,
    ctx: params.ctx,
    signal: execution.signal,
    traceparent: params.ctx.traceparent,
  }));
  registerToolDispatch("flight.search", FLIGHT_SEARCH_TOOL, buildFlightSearchDispatcher({
    run: params.run,
    ctx: params.ctx,
    signal: execution.signal,
    traceparent: params.ctx.traceparent,
    userConfirmed: confirmedFor("flight.search", toolContext.userConfirmed === true, confirmedCapability),
  }));
  // Research capabilities (places / accommodation discovery / activities)
  // route through a separate, generic dispatcher — same loop, separate
  // route, neither owns the other's rules. `flight.search` is deliberately
  // excluded from this list: it already has its own dedicated dispatcher and
  // confirm/persist state machine above (mirroring hotel), which supports
  // partial-argument reuse via the stored `flightSearchState` and returns
  // richer per-offer evidence than this generic path does. Registering it
  // twice would let whichever dispatcher runs second silently shadow the
  // other's tool definition.
  if (
    process.env.PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED === "true"
    && process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED === "true"
  ) {
    const researchDispatch = createPersonalResearchDispatcher({
      ctx: params.ctx,
      // The same server-side detection the hotel route uses. Read here rather
      // than trusted from the model: a metered call must wait for a person,
      // and the model asking for permission is not the person giving it.
      //
      // A confirmation naming flights or a hotel is not permission to spend
      // an activities-search quota, so a named capability withholds it here.
      userConfirmed: toolContext.userConfirmed === true && confirmedCapability === null,
      ownerUserId: params.run.createdByUserId,
      tripId: params.run.tripId,
      threadId: params.run.threadId,
      runId: params.run.id,
      signal: execution.signal,
    });
    // One guard per turn. A model cannot see it already ran a search, so it
    // runs it again — the cost is not a wrong answer but a silently doubled
    // supplier bill.
    const deduplicator = new ToolCallDeduplicator();
    for (const tool of PERSONAL_RESEARCH_TOOLS) {
      if (tool.name === "flight.search") continue;
      if (!isPersonalResearchCapabilityAllowed(tool.name as PersonalResearchOperationCapability)) continue;
      tools.push(tool);
      dispatchers.set(tool.name, async (call) => {
        await publishToolEvent(params.run, { phase: "started", name: call.name }, params.ctx.traceparent);
        const result = deduplicator.claim(call.name, call.arguments).duplicate
          // Answered rather than thrown: the model has to learn it already
          // ran this exact search.
          ? { outcome: "UNAVAILABLE", reason: "DUPLICATE_CALL" }
          : await withPausedModelBudget(() => researchDispatch(call));
        if ((result as { providerDispatched?: unknown })?.providerDispatched === true) {
          evidenceDispatched = true;
        }
        await publishToolEvent(params.run, { phase: "settled", name: call.name, ...settledSummary(result) }, params.ctx.traceparent);
        return result;
      });
    }
  }
  // A capability's own evidence, still within its freshness window, is just
  // as trustworthy as one dispatched THIS turn — the model routinely needs
  // to answer a plain follow-up ("筛选到 5000 CNY 左右") about a search it
  // ran a few turns ago without re-invoking the provider. Without this, the
  // safety gate treated every non-dispatching turn as unbacked and replaced
  // any price-mentioning reply with the canned refusal, even when real,
  // unexpired evidence already existed for this trip. Scoped to hotel/flight
  // only — the only two capabilities with a persisted evidence row today.
  const persistedCapabilities = tools
    .map((tool) => tool.name)
    .filter((name): name is "hotel.search" | "flight.search" => name === "hotel.search" || name === "flight.search");
  if (persistedCapabilities.length > 0 && params.run.tripId) {
    const [freshEvidence] = await db.select({ id: personalResearchEvidence.id })
      .from(personalResearchEvidence)
      .where(and(
        eq(personalResearchEvidence.tripId, params.run.tripId),
        inArray(personalResearchEvidence.capability, persistedCapabilities),
        gt(personalResearchEvidence.expiresAt, new Date()),
      ))
      .limit(1);
    if (freshEvidence) {
      evidenceDispatched = true;
    }
  }
  if (tools.length > 0) {
    toolContext.tools = tools;
    toolContext.dispatchTool = async (call) => {
      // Post-P2: when the tool budget is exhausted, do NOT abort the model
      // signal. Return a structured UNAVAILABLE answer so the model can
      // keep talking. Matches the `dispatchPlanningTool` discipline in
      // `services/planning-service.ts` (the planner never aborts the model
      // either — it converts failures to gaps).
      if (isToolBudgetExhausted()) {
        return { outcome: "UNAVAILABLE", reason: "TOOL_BUDGET_EXHAUSTED" };
      }
      const dispatch = dispatchers.get(call.name);
      // Answered rather than thrown. A model that invents a tool name gets
      // told so and can correct itself; throwing here used to end the turn.
      if (!dispatch) return { outcome: "UNAVAILABLE", reason: "UNKNOWN_TOOL" };
      // Every route leaves through here, so this is where a reason a person
      // can read goes in. The tool budget itself is charged inside
      // `withPausedModelBudget`, which already brackets exactly the dispatch
      // window — metering it again here would double-count every call.
      return explainToolFailure(withoutInternalFields(await dispatch(call)));
    };
  }
  // Spec §7.2 / §D4: extract the chat-side candidate once and reuse it for
  // the city-required constraint below and the label trigger point further
  // down. The deterministic parser is cheap (pure regex on the owner's
  // own text); calling it twice would be both wasted CPU and a hazard for
  // divergent shape assumptions across the two use sites.
  const chatExtractedCandidate = proposeTripBriefFromTurn(turnInput.question)?.destinationCandidates?.[0];
  toolContext.responseConstraints = [
    ...selectResponseConstraints({
      tripStatus: tripContext.tripStatus,
      registeredTools: tools.map((tool) => tool.name),
      hotelSearchStateExists: hotelSearchState !== null,
      flightSearchStateExists: flightSearchState !== null,
      userConfirmed: toolContext.userConfirmed === true,
      confirmedCapability,
    }),
    // Spec §7.2: extend the city-required prompt to chat text as well as
    // map pickers. `chatExtractedCandidate` is computed once and reused by
    // the label trigger point below.
    ...(isBriefDestinationCountry(turnInput.place?.name)
        || isBriefDestinationCountry(chatExtractedCandidate)
      ? ["DESTINATION_CITY_REQUIRED" as const] : []),
  ];
  // Post-P2 (§5.2): the safety gate asks `isEvidenceBacked()` once at the
  // end of the turn. We expose both the *this-turn* dispatch flag and any
  // *persisted* evidence the trip already has (hotel/flight only — the two
  // capabilities that can produce one). The deterministic template path in
  // step 2-2 reads the same predicate.
  toolContext.isEvidenceBacked = () => evidenceDispatched;

  const gate = new SafeConversationDeltaGate(
    params.run,
    params.ctx.traceparent,
    () => evidenceDispatched,
    input.intent === "brief_saved" || input.intent === "preferences_saved",
  );

  let output;
  try {
    output = await executeTravelConversation({
      ctx: params.ctx,
      policyGate: new DefaultPolicyGate("personal"),
    }, input, execution.signal, (delta) => gate.push(delta), toolContext);
  } catch (err) {
    // Post-P2 (§5.2): if the model call failed (timeout, network, anything)
    // but the turn *did* capture persisted evidence, do NOT surface a model
    // failure. Persist a deterministic assistant message that names what
    // was gathered so the user knows the price search worked but the reply
    // formatting did not. This closes finding #32 where a real hotel price
    // was logged and the user was told "the model is down".
    if (!evidenceDispatched) throw err;
    const evidenceRows = evidence?.offers ?? [];
    const providerNames = [...new Set(evidenceRows.map((row) => row.providerName))].filter(Boolean).join(", ");
    const latestCapturedAt = evidenceRows
      .map((row) => row.capturedAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? new Date().toISOString();
    const templateBody = evidenceRows.length === 0
      ? "Wanderly captured search results but could not finish the reply."
      : `Wanderly gathered ${evidenceRows.length} result${evidenceRows.length === 1 ? "" : "s"} from ${providerNames || "a travel provider"} (latest captured at ${latestCapturedAt}) but could not finish the reply.`;
    logSafeRuntimeEvent(params.ctx, {
      component: "worker", event: "evidence_without_reply",
      operation: "conversation", outcome: "failure",
      errorCode: err instanceof Error ? err.name : "INTERNAL",
    });
    output = travelConversationOutputSchema.parse({
      content: templateBody,
      responseMode: "FALLBACK",
    });
  } finally {
    // Both clocks and the task-abort bridge belong to this turn only. A turn
    // that ends normally used to leave the model timer, the hard-cap timer and
    // the abort listener behind; `finally` is the one path every outcome takes.
    clearTurnDeadline();
    params.signal.removeEventListener("abort", abortFromTask);
  }

  await publishPhase(params.run, "VALIDATING", params.ctx.traceparent);
  const parsedReply = travelConversationOutputSchema.parse(output);
  // A tool ran, its results are saved and already on screen as offer cards, and
  // only the summarising model call failed. The generic "I can't reach the
  // model" line contradicts those cards, so name what actually happened.
  const parsed = parsedReply.responseMode === "FALLBACK" && evidenceDispatched
    ? travelConversationOutputSchema.parse({
      ...parsedReply,
      content: evidenceBackedConversationFallback().content,
    })
    : parsedReply;
  if (
    parsed.responseMode === "MODEL"
    && containsUnsupportedOperationalClaim(parsed.content, {
      evidenceBacked: evidenceDispatched,
      tripMutationBacked: input.intent === "brief_saved" || input.intent === "preferences_saved",
    })
  ) {
    throw new Error("Final conversation safety validation failed");
  }
  // Trailing text that never met a clause boundary is shipped here, and the
  // guard is what keeps it from contradicting the persisted reply: a FALLBACK
  // or a safe refusal replaces the answer wholesale, and streaming its tail
  // anyway would leave the traveller reading half of an answer that was
  // withdrawn.
  //
  // It compared raw bytes, and the output schema is `z.string().trim()`. A
  // model reply ending in a newline — which is most of them — therefore failed
  // the comparison, skipped the flush, and lost everything after its last
  // clause boundary: 「…备齐了所有关键信息：从」 stopped exactly there.
  if (gate.rawText.trim() === parsed.content) await gate.flush();
  // Draft brief extraction is private exploration behaviour. It remains
  // independent from the Shared handoff lifecycle below.
  // Destination cue classification is also the language-aware boundary for
  // destination, flight and hotel turns. Those turns own their respective
  // confirmation cards; never create the generic brief-review card from a
  // departure/date phrase embedded in one of them.
  const destinationCueDecision = await destinationCuePromise;
  // Each field scope is independent. A destination decision must not suppress
  // an explicit origin/date/duration from the same owner turn (for example
  // “从上海去北京三天”). Destination is stripped below and persists only via
  // Destination Cue; the remaining brief fields keep their own confirmation.
  // Not gated on `responseMode`. The two sources below have different
  // authorities and only one of them is the assistant: `directBriefProposal`
  // is deterministic parsing of the owner's own message, and it stays valid
  // however the reply turned out. Gating both on MODEL made the trip-mutation
  // guard self-defeating — a reply claiming "已更新" becomes a SAFE_REFUSAL
  // reading "请在下方确认卡片", and the same branch then suppressed the card it
  // had just told the traveller to confirm. That is exactly the turn on which
  // the owner states a change, so the card was missing when it mattered most.
  const generatedTripBriefProposal = tripContext.tripStatus === "DRAFT" || tripContext.tripStatus === "PLANNING"
    ? mergeTripBriefProposal(
      // Direct owner statements are parsed conservatively and destination
      withoutDestinationCandidates(directBriefProposal),
      // The model extractor is retained only for an owner accepting a
      // concrete date/duration the assistant resolved in this same turn.
      // It can never introduce a destination, departure, or other free-text
      // trip fact from a reply — nor a date that contradicts the one parsed
      // above, which is how an end date two years before its start reached
      // the card and made it unsavable.
      //
      // This half *is* assistant-derived — it exists for the owner accepting a
      // date the assistant resolved — so a withdrawn or fallback reply must
      // not contribute one.
      parsed.responseMode === "MODEL" ? parsedReply.tripBriefProposal : undefined,
    )
    : undefined;
  // Do not let an assistant extractor (or a future proposal source) infer an
  // origin from a bare city mention. The card can show a departure only when
  // this owner turn explicitly states one.
  const tripBriefProposal = withoutImplicitDeparture(
    // Destination candidates have exactly one owner: Destination Cue. Never
    // persist one on the generic brief card, where an origin guard could make
    // its unrelated disappearance look like the destination was rejected.
    withoutDestinationCandidates(generatedTripBriefProposal),
    turnInput.question,
  );

  // User-originated decisions always win for this turn. Only when the user
  // classifier found nothing do we inspect the final persisted reply as a
  // narrow fallback. This keeps the Personal Agent's prose non-authoritative:
  // it may request a confirmation card, but can never write the Trip itself.
  const assistantDestinationCueDecision = destinationCueDecision
    || parsed.responseMode !== "MODEL"
    || tripContext.tripStatus !== "DRAFT"
    || membership.role !== "CREATOR"
    ? Promise.resolve(destinationCueDecision)
    : decideDestinationCueForTurn({
      ctx: { ctx: params.ctx, policyGate: new DefaultPolicyGate("personal") },
      question: parsed.content,
      currentDestinations: tripContext.destinationCandidates,
      locale: titleLocale ?? "en",
      messageSource: "ASSISTANT_REPLY",
      signal: execution.signal,
    }).catch(() => null);

  const assistantFlightOfferCueDecision = flightOfferCuePromise.then((userDecision) => {
    if (userDecision || parsed.responseMode !== "MODEL" || !canOfferCue || flightOfferCueCurrentSeq === null) {
      return userDecision;
    }
    return resolveOfferCueForTurn({
      ctx: { ctx: params.ctx, policyGate: new DefaultPolicyGate("personal") },
      run: params.run,
      capability: "flight",
      question: parsed.content,
      locale: titleLocale ?? "en",
      messageSource: "ASSISTANT_REPLY",
      currentUserMessageSequence: flightOfferCueCurrentSeq,
      signal: execution.signal,
    });
  }).catch(() => null);
  const assistantHotelOfferCueDecision = hotelOfferCuePromise.then((userDecision) => {
    if (userDecision || parsed.responseMode !== "MODEL" || !canOfferCue || hotelOfferCueCurrentSeq === null) {
      return userDecision;
    }
    return resolveOfferCueForTurn({
      ctx: { ctx: params.ctx, policyGate: new DefaultPolicyGate("personal") },
      run: params.run,
      capability: "hotel",
      question: parsed.content,
      locale: titleLocale ?? "en",
      messageSource: "ASSISTANT_REPLY",
      currentUserMessageSequence: hotelOfferCueCurrentSeq,
      signal: execution.signal,
    });
  }).catch(() => null);
  // Spec §7.1: derive a display-only destination label from this turn.
  // The label is country/region only — never a city — and lives in
  // shared_trips.title_destination_label, not in destinationCandidates or
  // any planner input. Must run outside any DB transaction so the future
  // P1 LLM call can keep this trigger point unchanged when the label
  // source becomes LLM (D7). For now the call is fully deterministic and
  // awaited inline; P1 will move it to fire-and-forget after migration.
  if (tripContext.tripStatus === "DRAFT" && titleLocale) {
    const candidate = turnInput.place?.name ?? chatExtractedCandidate;
    if (candidate) {
      const resolved = resolveTitleDestinationLabel({ candidate, locale: titleLocale });
      if (resolved) {
        await applyTitleDestinationLabel({
          ctx: params.ctx,
          tripId: tripContext.tripId,
          label: resolved.label,
          source: resolved.source,
          locale: titleLocale,
        }).catch((err) => {
          // Fail-soft: a label write must never break the conversation
          // reply. Log the error in trace context, keep the metric counter
          // honest (no implicit "applied" claim), and let the conversation
          // continue. AGENTS.md observability.
          logSafeRuntimeEvent(params.ctx, {
            component: "planner",
            event: "apply_title_label",
            operation: "trip.destination.label",
            outcome: "failure",
            errorCode: (err as Error)?.name ?? "UNKNOWN",
          });
        });
      }
    }
  }
  // Shared handoff is a collaboration command. Draft trips are private
  // exploration only; completed/cancelled trips must not create fresh shared
  // constraints. PLANNING and STALE are the two states that can safely accept
  // a new snapshot-backed PLAN/REPLAN.
  if (!shouldExtractConversationHandoff(
    parsed.responseMode, tripContext.tripStatus, params.run.conversationSurface,
  )) {
    const conversation = travelConversationOutputSchema.parse({ ...parsed, ...(tripBriefProposal ? { tripBriefProposal } : {}) });
    return { ...conversation, destinationCueDecision: assistantDestinationCueDecision, flightOfferCueDecision: assistantFlightOfferCueDecision, hotelOfferCueDecision: assistantHotelOfferCueDecision };
  }

  // Phase 6 / member conversation handoff — fire-and-forget candidate
  // extraction. The skill registry's timeout / catalog validation handles
  // safety; failures here never affect the conversation reply. On a
  // successful extraction we publish a single bounded `handoff_ready` SSE
  // event with the batchId so the chat UI can pull and render the
  // member-private candidate card (docs/member-conversation-handoff-implementation.md §5).
  try {
    const extraction = await extractConversationHandoffBatch({
      ctx: params.ctx,
      run: params.run,
      currentTurnQuestion: turnInput.question,
      tripBrief: {
        departureCities: tripContext.departureCities,
        destinationCandidates: tripContext.destinationCandidates,
        ...(tripContext.travelDateStart && tripContext.travelDateEnd
          ? { travelDateWindow: { start: tripContext.travelDateStart, end: tripContext.travelDateEnd } }
          : {}),
      },
      ownerProfileHints: input.tripContext && "ownerProfileHints" in input.tripContext
        ? (input.tripContext as { ownerProfileHints?: { interests?: string[]; accommodationStyle?: string; noRedEye?: boolean; budgetMaxUsd?: number } }).ownerProfileHints
        : undefined,
      signal: params.signal,
    });
    if (extraction) {
      await publishAgentStreamEvent({
        event: "conversation.handoff_ready",
        runId: params.run.id,
        generationAttempt: params.run.generationAttempt,
        batchId: extraction.batchId,
        candidateVersion: extraction.candidateVersion,
        fieldKeys: extraction.fieldKeys,
        traceparent: params.ctx.traceparent,
      });
    }
  } catch {
    // extractConversationHandoffBatch swallows its own errors; the catch is a
    // belt-and-braces guard against a future refactor that throws.
  }

  const conversation = travelConversationOutputSchema.parse({ ...parsed, ...(tripBriefProposal ? { tripBriefProposal } : {}) });
  return { ...conversation, destinationCueDecision: assistantDestinationCueDecision, flightOfferCueDecision: assistantFlightOfferCueDecision, hotelOfferCueDecision: assistantHotelOfferCueDecision };
}

/**
 * Kept pure so the lifecycle boundary is directly regression-testable.
 *
 * `surface` keeps exploration out of long-term memory. Someone turning the
 * globe and asking about Kyoto is browsing, not stating how they travel, and
 * nothing about the trip row can tell the two apart: the first message from
 * the globe creates a DRAFT trip that is listed and openable immediately, so
 * the same trip is reachable from both surfaces. Only the turn knows where it
 * was typed, so the client sends it.
 *
 * Trusting the client here is safe because the field can only narrow. An
 * absent or unrecognised surface reads as exploration and extracts nothing, so
 * neither an old client nor a forged value can make the server remember more
 * than it otherwise would — the failure direction is always forgetting.
 */
export function shouldExtractConversationHandoff(
  responseMode: "MODEL" | "SAFE_REFUSAL" | "FALLBACK",
  tripStatus: PersonalTripContext["tripStatus"],
  surface: string | null | undefined,
): boolean {
  if (surface !== "TRIP_WORKSPACE") return false;
  return responseMode === "MODEL" && (tripStatus === "PLANNING" || tripStatus === "STALE");
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
async function loadPersonalTripContext(tripId: string): Promise<{
  context: PersonalTripContext;
  titleLocale: "en" | "zh" | null;
}> {
  const [trip] = await db.select({
    id: sharedTrips.id,
    name: sharedTrips.name,
    status: sharedTrips.status,
    travelDateStart: sharedTrips.travelDateStart,
    travelDateEnd: sharedTrips.travelDateEnd,
    travelDays: sharedTrips.travelDays,
    departureCities: sharedTrips.departureCities,
    destinationCandidates: sharedTrips.destinationCandidates,
    titleLocale: sharedTrips.titleLocale,
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

  // Mirrors the web client's `canStartSharedPlanning` predicate at
  // apps/web/src/components/explore/travel-agent-chat.tsx — the
  // Personal Agent must speak the same truth as the UI CTA. The flag
  // never authorizes activation on its own; the only DRAFT→PLANNING
  // write boundary is `POST /trips/:tripId/activate`, owned by the UI.
  const canStartSharedPlanning =
    tripStatus === "DRAFT"
    && trip.departureCities.length > 0
    && trip.destinationCandidates.length > 0
    && Boolean(trip.travelDateStart)
    && Boolean(trip.travelDateEnd || trip.travelDays);

  const missingFields: PersonalTripContext["missingFields"] = [];
  if (tripStatus === "DRAFT") {
    if (trip.departureCities.length === 0) missingFields.push("departure_city");
    if (trip.destinationCandidates.length === 0) missingFields.push("destination_city");
    if (!trip.travelDateStart || !(trip.travelDateEnd || trip.travelDays)) {
      missingFields.push("travel_dates");
    }
  }

  const sharedPlanningState = await loadSharedPlanningState({
    tripId: trip.id,
    tripStatus: trip.status,
  });

  return { context: personalTripContextSchema.parse({
    tripId: trip.id,
    tripName: trip.name,
    tripStatus,
    travelDateStart: trip.travelDateStart,
    travelDateEnd: trip.travelDateEnd,
    travelDays: trip.travelDays,
    departureCities: trip.departureCities,
    destinationCandidates: trip.destinationCandidates,
    canStartSharedPlanning,
    missingFields,
    sharedPlanningState,
  }), titleLocale: trip.titleLocale };
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
    private readonly tripMutationBacked: boolean,
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

    let boundary = completeClauseBoundary(this.pending);
    while (boundary > 0) {
      const segment = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary);
      await this.approveAndPublish(segment);
      boundary = completeClauseBoundary(this.pending);
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
    if (containsUnsupportedOperationalClaim(candidate, {
      evidenceBacked: this.getEvidenceBacked(),
      tripMutationBacked: this.tripMutationBacked,
    })) {
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

/**
 * Longest complete clause the gate may approve out of `value`.
 *
 * The unit used to be a whole sentence, which made the SSE stream arrive in
 * one or two jumps: a reply like "巴黎是个不错的选择" has no terminator at
 * all and only shipped from the final `flush()` — after generation had
 * already finished — and "好的，我来帮你规划这次法国之旅。" produced exactly
 * one delta. Clauses keep the same contract (a complete unit is approved
 * before any of it is published, per docs/agent-streaming-implementation.md
 * §4) while cutting the granularity several times finer.
 *
 * CJK punctuation is unambiguous, so it ends a clause on its own. ASCII
 * punctuation must be followed by real whitespace, because it also appears
 * inside values the reply is allowed to contain: `1,000`, `3.5`, `10:30`,
 * `https://…`.
 *
 * Note there is deliberately no `$` alternative for the ASCII branch. This
 * runs against a buffer that grows one token at a time, so end-of-text
 * matches on *every* intermediate state — `$` would fire on the `,` of
 * `1,000` the instant it arrived, before the `000` existed to disprove it.
 * Trailing text with no boundary is shipped by `flush()` instead.
 */
export function completeClauseBoundary(value: string): number {
  let boundary = 0;
  for (const match of value.matchAll(CLAUSE_BOUNDARY_PATTERN)) {
    boundary = (match.index ?? 0) + match[0].length;
  }
  return boundary;
}

const CLAUSE_BOUNDARY_PATTERN = /[。！？，、；：]\s*|[.!?,;:]\s+|\n+/gu;

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

/**
 * Publishes tool progress. A name the capability enum does not know is
 * dropped rather than guessed at: it would fail the strict event schema at
 * the relay and take the whole SSE stream with it, and losing the reply over
 * a status message is the worse failure.
 */
function publishToolEvent(
  run: AgentTaskRow,
  event: {
    phase: "started"; name: string;
  } | {
    phase: "settled"; name: string; outcome: string; reason?: string;
    currency?: unknown; flightOffers?: unknown; hotelOffers?: unknown;
  },
  traceparent?: string,
) {
  const capability = personalResearchOperationCapabilitySchema.safeParse(event.name);
  if (!capability.success) return Promise.resolve();
  const base = { runId: run.id, generationAttempt: run.generationAttempt, capability: capability.data, traceparent };
  if (event.phase === "started") return publishAgentStreamEvent({ event: "tool.started", ...base });
  const outcome = toolSettledEventSchema.shape.outcome.safeParse(event.outcome);
  const currency = toolSettledEventSchema.shape.currency.safeParse(event.currency);
  const flightOffers = toolSettledEventSchema.shape.flightOffers.safeParse(event.flightOffers);
  const hotelOffers = toolSettledEventSchema.shape.hotelOffers.safeParse(event.hotelOffers);
  return publishAgentStreamEvent({
    event: "tool.settled",
    ...base,
    outcome: outcome.success ? outcome.data : "UNAVAILABLE",
    ...(event.reason ? { reason: event.reason } : {}),
    ...(currency.success && currency.data ? { currency: currency.data } : {}),
    ...(flightOffers.success && flightOffers.data ? { flightOffers: flightOffers.data } : {}),
    ...(hotelOffers.success && hotelOffers.data ? { hotelOffers: hotelOffers.data } : {}),
  });
}

/**
 * The reportable part of a tool result: outcome, a bounded code if it
 * failed, and — for hotel.search/flight.search specifically — the same
 * bounded top-offer list (plus the search's single currency) already
 * persisted into evidence, so the chat panel can render a result card
 * instead of waiting for the reply text.
 */
function settledSummary(result: unknown): {
  outcome: string; reason?: string; currency?: unknown; flightOffers?: unknown; hotelOffers?: unknown;
} {
  const rawOutcome = (result as { outcome?: unknown })?.outcome;
  // The flight dispatcher and generic confirmed tools use
  // `CONFIRMATION_REQUIRED`; the SSE vocabulary is `NEEDS_CONFIRMATION`.
  // Hotel search is automatic in the sandbox and never returns that outcome.
  const outcome = rawOutcome === "CONFIRMATION_REQUIRED" ? "NEEDS_CONFIRMATION" : rawOutcome;
  const reason = (result as { reason?: unknown })?.reason;
  const flight = (result as { flight?: { currency?: unknown; topOffers?: unknown } })?.flight;
  const hotel = (result as { hotel?: { currency?: unknown; topOffers?: unknown } })?.hotel;
  const currency = flight?.currency ?? hotel?.currency;
  return {
    outcome: typeof outcome === "string" ? outcome : "AVAILABLE",
    ...(typeof reason === "string" && /^[A-Z_]{3,40}$/.test(reason) ? { reason } : {}),
    ...(typeof currency === "string" ? { currency } : {}),
    ...(Array.isArray(flight?.topOffers) ? { flightOffers: flight.topOffers } : {}),
    ...(Array.isArray(hotel?.topOffers) ? { hotelOffers: hotel.topOffers } : {}),
  };
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


/**
 * The deadline for one conversation turn, split into three clocks.
 *
 * `modelBudgetMs` is the Skill's timeout, and it measures *model* time only:
 * `withPausedModelBudget` stops it for exactly as long as a tool dispatch runs,
 * so a slow supplier spends its own latency rather than the model's. Without
 * that split a hotel search — 10s+ inside Nuitee — consumed most of the 15s
 * budget and the turn was aborted mid-summary, discarding offers that had
 * already been fetched and persisted.
 *
 * `toolBudgetMs` is the aggregate of those paused windows. Pausing on its own
 * bounds nothing: three slow suppliers in a row hold the turn open to the hard
 * cap while the model never runs short. Exhausting this budget aborts nothing —
 * `isToolBudgetExhausted()` lets the dispatcher answer a structured UNAVAILABLE
 * so the model still replies with what it has, the same discipline
 * `dispatchPlanningTool` follows in `services/planning-service.ts`.
 *
 * `hardCapMs` is plain wall clock and is never paused, so a supplier that never
 * answers still cannot hold a turn open indefinitely.
 *
 * See §5.1 of docs/planner-resilience-and-reflection-implementation.md.
 */
export function createTurnDeadline(params: {
  modelBudgetMs: number;
  /** Aggregate tool time allowed per turn. Omitted → tools are not metered. */
  toolBudgetMs?: number;
  onAbort: (reason: string) => void;
  isAborted: () => boolean;
  hardCapMs?: number;
  now?: () => number;
}): {
  withPausedModelBudget: <T>(run: () => Promise<T>) => Promise<T>;
  isToolBudgetExhausted: () => boolean;
  clear: () => void;
} {
  const now = params.now ?? Date.now;
  let remainingMs = params.modelBudgetMs;
  let startedAt = now();
  let remainingToolMs = params.toolBudgetMs ?? Number.POSITIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => params.onAbort("Conversation Skill timed out"),
    remainingMs,
  );
  const hardCapTimer = setTimeout(
    () => params.onAbort("Conversation turn exceeded its hard cap"),
    params.hardCapMs ?? CONVERSATION_TURN_HARD_CAP_MS,
  );
  return {
    withPausedModelBudget: async <T>(run: () => Promise<T>): Promise<T> => {
      const pausedAt = now();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        remainingMs -= pausedAt - startedAt;
      }
      try {
        return await run();
      } finally {
        // The paused window is exactly the dispatch window, so it is also the
        // honest unit to charge the tool budget for. Charged even when the
        // dispatch threw: a supplier that fails slowly still spent the time.
        remainingToolMs = Math.max(0, remainingToolMs - Math.max(0, now() - pausedAt));
        // An already-aborted turn gets no fresh timer: rearming one would fire
        // a second abort against a signal that has already settled.
        if (!timer && !params.isAborted()) {
          startedAt = now();
          timer = setTimeout(
            () => params.onAbort("Conversation Skill timed out"),
            Math.max(remainingMs, 0),
          );
        }
      }
    },
    isToolBudgetExhausted: () => remainingToolMs <= 0,
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      clearTimeout(hardCapTimer);
    },
  };
}

export const CONVERSATION_TURN_HARD_CAP_MS = 120_000;
