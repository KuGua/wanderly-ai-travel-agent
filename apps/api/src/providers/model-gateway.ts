import type { FlightOffer, StayOffer, PlanDiff } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";
import type { ConversationPlace, ConversationResponseMode } from "../types/schemas.js";
import type { PersonalTripContext } from "../skills/personal/personal-trip-context-schema.js";

export type ConversationIntent = "auto_intro" | "user_typed";

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
  source: "PROFILE_FORM" | "PROPOSAL_CONFIRMATION";
}

export interface ThreadContextMessage {
  role: "USER" | "ASSISTANT";
  content: string;
}

export interface ConversationReply {
  content: string;
  responseMode: ConversationResponseMode;
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
 * Output shape for `generateSetupFollowup`. The model picks ONE missing
 * code from the server-known set and produces a localized prompt. The
 * server validates against `requestedMissing` and falls back to a
 * deterministic template on any failure.
 */
export interface SetupFollowupResult {
  questionCode: string;
  promptText: string;
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
     * Server-derived minimal Trip context.  When provided, the gateway
     * MUST treat it as the sole Trip-side information available to
     * the model — never substitute a richer DB read.
     */
    tripContext?: PersonalTripContext;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<ConversationReply>;

  streamConversationReply?(params: {
    question: string;
    place?: ConversationPlace;
    threadContext: ThreadContextMessage[];
    memoryContext?: ConversationMemoryFact[];
    /** Evidence the agent's own providers returned for this trip. */
    researchEvidence?: ResearchEvidenceOffer[];
    intent?: ConversationIntent;
    tripContext?: PersonalTripContext;
    onDelta: ConversationDeltaHandler;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<ConversationReply>;
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
   * Personal Research Setup Sessions — generate ONE follow-up question
   * to ask the owner about a missing setup field. Bounded (≤200 token
   * input, ≤80 token output). Inputs come only from the server-known
   * missing-code enum and locale; never the original question, profile,
   * thread context, snapshot values, or PII.
   * Source: docs/personal-research-intent-routing-implementation.md §9.
   */
  generateSetupFollowup?(params: {
    locale: "zh-CN" | "zh-TW" | "en-US";
    requestedMissing: string[];
    /** Field names already filled in the session — values are NEVER included. */
    filledFieldNames: string[];
    /** Human-readable labels for each missing code, so the model can refer to them. */
    missingCodeLabels: Record<string, { zh: string; en: string }>;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<SetupFollowupResult>;
}
