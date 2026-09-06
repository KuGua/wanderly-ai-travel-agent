import type { FlightOffer, StayOffer, PlanDiff } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";
import type { ConversationPlace, ConversationResponseMode } from "../types/schemas.js";
import type { PersonalTripContext } from "../skills/personal/personal-trip-context-schema.js";
import type {
  FlightOfferCueInputCandidate,
  FlightOfferCueDecisionResult,
  HotelOfferCueInputCandidate,
  HotelOfferCueDecisionResult,
} from "./llm-gateway.js";

export type ConversationIntent = "auto_intro" | "user_typed" | "preferences_saved" | "brief_saved";

/**
 * The only long-term-memory shape a shared planning model may receive.  Values
 * in `confidentialConstraints` are planning-only: the plan validator rejects
 * any attempt to repeat their key or value in persisted output.
 */
export interface SharedPlanningMemoryInput {
  members: Record<string, {
    preferences: Record<string, unknown>;
    confidentialConstraints: Record<string, unknown>;
  }>;
  tripWidePreferences: Record<string, unknown>;
}

/**
 * Single entry in the bounded same-thread LLM context window. The shape
 * intentionally matches the `ThreadContextMessage` produced by
 * `apps/api/src/services/conversation-context-service.ts` so the Skill
 * can pass the builder's output straight through to the gateway without
 * a translation layer. Both modules define the type locally to keep the
 * service free of any dependency on the providers package.
 */
/**
 * A single active long-term memory fact for the authenticated owner,
 * produced by `apps/api/src/services/conversation-memory-context.ts`.
 * Deliberately structural (not a Zod import) so this provider-facing
 * contract stays free of service-layer dependencies, matching the way
 * `ThreadContextMessage` is declared below.
 */
export interface ResearchEvidenceOffer {
  category: "activity" | "hotel";
  providerName: string;
  title: string;
  price: { amount: number; currency: string } | null;
  rating: number | null;
  detail: string | null;
  capturedAt: string;
}

export interface ConversationMemoryFact {
  field: string;
  value: unknown;
  category: "PREFERENCE" | "CONSTRAINT";
  source: "PROFILE_FORM" | "PROPOSAL_CONFIRMATION" | "HIGHLIGHT" | "PERSONAL_NOTE" | "TRIP_OVERRIDE";
}

export interface ThreadContextMessage {
  role: "USER" | "ASSISTANT";
  content: string;
}

export interface ConversationReply {
  content: string;
  responseMode: ConversationResponseMode;
}

/**
 * Owner-stated update to the trip's departure cities, destination
 * candidates, and/or exact travel dates, extracted from a single
 * conversation turn. Every field is optional — only fields the owner
 * actually stated or changed in this turn are present.
 */
export interface TripBriefProposal {
  departureCities?: string[];
  destinationCandidates?: string[];
  travelDateStart?: string;
  travelDateEnd?: string;
  travelDays?: number;
}

export interface DestinationCueDecisionResult {
  decision: {
    candidates: Array<{
      mentionedText: string;
      ordinal: number;
      intent: "DESTINATION_INTEREST" | "EXPLICIT_SET_DESTINATION" | "EXPLICIT_EXCLUDE_DESTINATION";
      triggerContext:
        | "BARE_CITY"
        | "CITY_EXPLORATION"
        | "FLIGHT_DESTINATION"
        | "HOTEL_DESTINATION"
        | "EXPLICIT_DESTINATION_COMMAND"
        | "EXPLICIT_EXCLUSION_COMMAND";
    }>;
    isNeutralMultiCityList: boolean;
    reasonCode:
      | "EXPLICIT_DESTINATION_COMMAND"
      | "EXPLICIT_EXCLUSION_COMMAND"
      | "SINGLE_DESTINATION_INTEREST"
      | "NEUTRAL_MULTI_CITY_LIST"
      | "NO_DESTINATION"
      | "AMBIGUOUS_REFERENCE";
  };
  modelVersion: string;
  promptVersion: string;
}

/** Typed, private, server-owned readiness state for the hotel tool. */
export interface ConversationHotelSearchState {
  cityCode: string;
  checkIn: string;
  checkOut: string;
  occupancy: { adults: number; rooms: number };
  currency: string;
  confirmed: boolean;
  version: number;
}

/** Typed, private, server-owned readiness state for the flight tool. */
export interface ConversationFlightSearchState {
  originId: string;
  destinationId: string;
  tripType: "ONE_WAY" | "ROUND_TRIP";
  departureDate: string;
  returnDate: string | null;
  adults: number;
  cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  currency: string;
  confirmed: boolean;
  version: number;
}

export type ConversationDeltaHandler = (delta: string) => void | Promise<void>;

/** A provider-neutral OpenAI-compatible function declaration. */
export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Server-owned dispatcher invoked only after the gateway receives a tool call. */
export type ModelToolDispatcher = (call: {
  id: string;
  name: string;
  arguments: unknown;
}) => Promise<unknown>;

export interface LocationIntroductionResult {
  content: string;
  modelName: string;
  promptVersion: string;
}

/**
 * Application-layer interface for configured real-model interactions.
 * The model cannot access the database or execute irreversible operations.
 * Tests may inject a deterministic implementation through gateway-factory.
 */
export interface ModelGateway {
  generateStructuredPlan(params: {
    destination: string;
    flights: FlightOffer[];
    stays: StayOffer[];
    memberPreferences: Record<string, unknown>;
    signal?: AbortSignal;
    ctx?: { correlationId: string };
  }): Promise<Record<string, unknown>>;

  /**
   * Optional capability used exclusively by Shared durable planning.  Older
   * deterministic test gateways can omit it; production planning fails
   * closed rather than silently prefetching flight data.
   */
  generateStructuredPlanWithTools?(params: {
    destination: string;
    destinationCandidates?: string[];
    /**
     * Server-derived, non-private planning constraints. The model uses them
     * only to select a controlled route; the dispatcher binds every other
     * field before invoking the full Skill contract.
     */
    flightSearchConstraints: {
      originIds: string[];
      destinationIds: string[];
      tripType: "ONE_WAY" | "ROUND_TRIP";
      departureDate: string;
      returnDate?: string;
      adults: number;
      cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
      currency: string;
    };
    stays: StayOffer[];
    memberPreferences: Record<string, unknown>;
    planningMemory: SharedPlanningMemoryInput;
    tools: ModelToolDefinition[];
    dispatchTool: ModelToolDispatcher;
    /** Server-only gate evaluated before accepting a no-tool final response. */
    beforeFinal?: () => Promise<void>;
    maxTurns: number;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<Record<string, unknown>>;

  explainPlanDiff(params: {
    oldPlan: Record<string, unknown>;
    newPlan: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<PlanDiff>;

  generateConversationReply(params: {
    question: string;
    place?: ConversationPlace;
    /**
     * Server-built, bounded same-thread LLM context window.  Built only
     * by `apps/api/src/services/conversation-context-service.ts` from the
     * accepted task's `threadId` + `userMessageId`.  Browsers never see,
     * submit, or store this field.
     */
    threadContext: ThreadContextMessage[];
    /**
     * Server-built cross-thread long-term memory for the authenticated
     * owner.  Built only by
     * `apps/api/src/services/conversation-memory-context.ts`; browsers
     * never see, submit, or store this field.
     */
    memoryContext?: ConversationMemoryFact[];
    /** Evidence the agent's own providers returned for this trip. */
    researchEvidence?: ResearchEvidenceOffer[];
    intent?: ConversationIntent;
    /**
     * Server-owned behavioural constraints selected by the invoking Skill.
     * They are not supplied by the browser or included in the conversation
     * transcript, so user text cannot enable, disable, or rewrite them.
     */
    responseConstraints?: readonly ConversationResponseConstraint[];
    /**
     * Server-derived minimal Trip context.  When provided, the gateway
     * MUST treat it as the sole Trip-side information available to
     * the model — never substitute a richer DB read.
     */
    tripContext?: PersonalTripContext;
    hotelSearchState?: ConversationHotelSearchState | null;
    flightSearchState?: ConversationFlightSearchState | null;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<ConversationReply>;

  /**
   * Required, not optional. An optional method here is the shape that lets a
   * capability vanish silently: the caller's `gateway.streamConversationReply`
   * guard falls through to the non-streaming path, which then replays the
   * finished reply as a single `onDelta` call — the user sees one block and
   * nothing fails to compile. The same footgun is documented on
   * `generateThreadTitle` above. Test doubles live outside `tsconfig`'s
   * `include`, so they are unaffected.
   */
  streamConversationReply(params: {
    question: string;
    place?: ConversationPlace;
    threadContext: ThreadContextMessage[];
    memoryContext?: ConversationMemoryFact[];
    /** Evidence the agent's own providers returned for this trip. */
    researchEvidence?: ResearchEvidenceOffer[];
    intent?: ConversationIntent;
    responseConstraints?: readonly ConversationResponseConstraint[];
    tripContext?: PersonalTripContext;
    hotelSearchState?: ConversationHotelSearchState | null;
    flightSearchState?: ConversationFlightSearchState | null;
    onDelta: ConversationDeltaHandler;
    signal?: AbortSignal;
    ctx?: RequestContext;
    /**
     * Phase 4 LLM-driven tool calling. When supplied, the gateway
     * accumulates `delta.tool_calls`, dispatches each call via
     * `dispatchTool`, and re-streams a final answer with the tool result
     * inlined. When undefined, behaviour is byte-identical to the prose
     * path. Tool arguments never reach the conversation transcript;
     * dispatch results are bounded `unknown` projections from the worker.
     */
    tools?: ModelToolDefinition[];
    dispatchTool?: ModelToolDispatcher;
  }): Promise<ConversationReply>;

  /**
   * Best-effort, non-streaming side extraction: does this conversation turn
   * explicitly state a new/changed departure city, destination, or exact
   * travel date for the trip in `tripContext`? Returns `null` on anything
   * short of a positive extraction (including any provider failure) — this
   * must never fail or delay the conversation turn it accompanies.
   */
  /**
   * Turns a sentence the traveller highlighted into one catalogue field, or
   * `null` when it says nothing the catalogue can hold. Returning `null` is a
   * normal answer, not a failure: "京都真美" is worth keeping and is not a
   * preference about anything the schema models.
   */
  extractHighlightMemory?(params: {
    highlight: string;
    /** Field keys and their allowed shapes, so the model cannot invent one. */
    catalogue: Array<{ fieldKey: string; description: string }>;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<{ fieldKey: string; value: unknown } | null>;

  extractTripBriefProposal?(params: {
    question: string;
    replyContent: string;
    tripContext?: PersonalTripContext;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<TripBriefProposal | null>;

  /**
   * Best-effort owner-turn classifier for the destination confirmation cue.
   * It receives only the current user message and already-confirmed city names:
   * never assistant prose, transcript history or a selected globe place.
   *
   * Required, deliberately. Previously optional; the spec §B5 narrow makes it
   * mandatory so a partial gateway cannot silently answer UNAVAILABLE for
   * every environment without anything failing to compile. Test doubles live
   * outside `tsconfig`'s `include`; runtime guards on the consumer side
   * remain.
   */
  decideDestinationCue(params: {
    question: string;
    currentDestinations: string[];
    locale: "en" | "zh";
    /** The visible message being classified. Assistant replies are only a
     * fallback after the current user turn produced no cue. */
    messageSource?: "USER_TURN" | "ASSISTANT_REPLY";
    /** Immediate preceding final assistant reply, supplied only to let an
     * unambiguous user affirmation select the city it just proposed. */
    previousAssistantReply?: string;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<DestinationCueDecisionResult | null>;

  // Flight / Hotel Offer Cue (docs/flight-offer-cue-model-draft.md,
  // docs/hotel-offer-cue-model-draft.md). Required for the same reason as
  // `decideDestinationCue` — a partial gateway cannot silently answer
  // null for every DRAFT trip without surfacing in the build.
  decideFlightOfferCue(params: {
    question: string;
    offerSetId: string;
    candidates: FlightOfferCueInputCandidate[];
    locale: "en" | "zh";
    messageSource?: "USER_TURN" | "ASSISTANT_REPLY";
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<FlightOfferCueDecisionResult | null>;

  decideHotelOfferCue(params: {
    question: string;
    offerSetId: string;
    candidates: HotelOfferCueInputCandidate[];
    locale: "en" | "zh";
    messageSource?: "USER_TURN" | "ASSISTANT_REPLY";
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<HotelOfferCueDecisionResult | null>;

  /**
   * S4: generate a single non-personalized short introduction for a
   * server-versioned stable `sourceId`. Inputs come only from the
   * catalog — never user, Trip, thread, coordinates, or current time.
   */
  generateLocationIntroduction(params: {
    locale: "en" | "zh";
    place: {
      sourceId: string;
      canonicalPlaceId: string;
      name: string;
      country: string;
      countryCode: string;
      admin1: string;
      admin1Code: string;
      nearestCity: string;
      datasetVersion: string;
      contentVersion: string;
    };
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<LocationIntroductionResult>;

  /**
   * Member conversation handoff (docs/member-conversation-handoff-implementation.md §5.1):
   * extract a catalog-bounded candidate batch from one private-thread turn.
   * The model receives only the server-built bounded context and the field
   * catalog; it never sees chat transcript or PII. The returned envelope is
   * validated against `tripConstraintProposeOutputSchema` upstream of any
   * persistence, so an implementation may return either pre-parsed rows or
   * a raw string the caller parses through the same schema.
   */
  generateConstraintProposalBatch?(params: {
    catalog: ReadonlyArray<{
      fieldKey: string;
      allowedVisibilities: ReadonlyArray<"TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL">;
      allowedStrengths: ReadonlyArray<"HARD" | "SOFT">;
      /** Server-authored one-line description of the field's value shape. */
      valueShape: string;
    }>;
    tripBrief: {
      departureCities: string[];
      destinationCandidates: string[];
      travelDateWindow?: { start: string; end: string };
    };
    ownerProfileHints?: {
      interests?: string[];
      accommodationStyle?: string;
      noRedEye?: boolean;
      budgetMaxUsd?: number;
    };
    currentTurnQuestion: string;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<{
    proposals: Array<{
      fieldKey: string;
      valueJson: unknown;
      strength: "HARD" | "SOFT";
      suggestedVisibility: "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL";
      safeRationale: string;
    }>;
  }>;

  /**
   * Owner-triggered thread title suggestion (docs/thread-title-lifecycle-implementation.md §9.1).
   *
   * Required, deliberately. While this was optional the only concrete gateway
   * never implemented it, so the skill's absence guard fired on every call and
   * the feature answered UNAVAILABLE in every environment without anything
   * failing to compile. Test doubles live outside `tsconfig`'s `include`, so
   * they are unaffected; the skill keeps a runtime guard for the ones that
   * inject a partial gateway.
   */
  generateThreadTitle(params: {
    /** Server-validated language authority (LLM-GATEWAY.md §User-visible language contract). */
    locale: "en" | "zh";
    /** Owner USER messages only; assistant messages and other threads are never sent. */
    messages: ReadonlyArray<{ text: string }>;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<{ title: string }>;

  /**
   * Owner-triggered trip destination label suggestion
   * (docs/trip-title-destination-label-implementation.md §8.1).
   *
   * Output is a single closed-vocabulary slot: `{ kind, value }` where
   * `kind ∈ { COUNTRY, CITY }` and `value` is a re-resolvable canonical
   * name. The postprocess module re-resolves `value` against the location
   * reference data, so the route never writes a free-text string into
   * `shared_trips.title_destination_label`.
   *
   * Required, deliberately. Same compile-time discipline as
   * `generateThreadTitle` — optionality here was spec §B5's exact hazard,
   * so this method is mandatory on every `ModelGateway` implementation.
   * Test doubles live outside `tsconfig`'s `include`; the skill keeps a
   * runtime guard for partial gateways.
   */
  generateTripDestinationLabel(params: {
    /** Server-validated language authority (LLM-GATEWAY.md §User-visible language contract). */
    locale: "en" | "zh";
    /** Owner USER messages only; at most three, each ≤512 chars (server-side). */
    messages: ReadonlyArray<{ text: string }>;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<{ kind: "COUNTRY" | "CITY"; value: string }>;
}

/** Narrow, versioned conversation behaviours; add values deliberately. */
export type ConversationResponseConstraint = "HOTEL_SEARCH_READINESS" | "FLIGHT_SEARCH_READINESS" | "DESTINATION_CITY_REQUIRED";
