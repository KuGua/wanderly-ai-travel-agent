import { pinoInstance } from "../../observability/telemetry.js";
import { z } from "zod";

import type { Skill, SkillContext } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import {
  containsUnsupportedOperationalClaim,
  requestsUnsupportedOperationalFacts,
  safeConversationRefusal,
} from "../../policy/conversation-safety.js";
import { modelGateway } from "../../providers/gateway-factory.js";
import { ModelGatewayError } from "../../providers/llm-gateway.js";
import {
  conversationIntentSchema,
  conversationPlaceSchema,
  conversationResponseModeSchema,
} from "../../types/schemas.js";
import { personalTripContextSchema } from "./personal-trip-context-schema.js";
import type { ConversationResponseConstraint } from "../../providers/model-gateway.js";

/**
 * Server-built same-thread context assembled by
 * `apps/api/src/services/conversation-context-service.ts`. The Skill MUST
 * NOT accept a browser-supplied history — any field carrying the same
 * name in the inbound HTTP request is rejected by the strict
 * `conversationTurnRequestSchema` before the Worker ever reaches this
 * module.
 *
 * Per-message cap is the streaming-output defense ceiling in the LLM
 * gateway (matches `parsedConversationCompletionSchema.reply.content`).
 * The aggregate `superRefine` mirrors the budget contract from
 * `docs/thread-context-memory-implementation.md` §3.2 so a builder
 * regression pushing too many characters is caught at the Skill boundary
 * rather than only at the model.
 */
const threadContextMessageSchema = z.object({
  role: z.enum(["USER", "ASSISTANT"]),
  content: z.string().min(1).max(8000),
}).strict();

/**
 * The owner's cross-thread long-term memory, built server-side by
 * `conversation-memory-context.ts` from the authenticated task's owner.
 * Like `threadContext` this is never browser-supplied — the strict request
 * schema rejects a same-named field before the Worker runs.
 */
const memoryContextFactSchema = z.object({
  field: z.string().min(1).max(64),
  value: z.unknown(),
  category: z.enum(["PREFERENCE", "CONSTRAINT"]),
  source: z.enum(["PROFILE_FORM", "PROPOSAL_CONFIRMATION", "HIGHLIGHT", "PERSONAL_NOTE", "TRIP_OVERRIDE"]),
}).strict();

/**
 * Normalized evidence from the trip's most recent research run, built
 * server-side by `research-evidence-service.ts`. This is what the agent
 * itself found through its providers; it is the only channel through
 * which a conversation reply may refer to a concrete offer.
 */
const researchEvidenceOfferSchema = z.object({
  category: z.enum(["activity", "hotel"]),
  providerName: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  price: z.object({
    amount: z.number(),
    currency: z.string().length(3),
  }).strict().nullable(),
  rating: z.number().nullable(),
  detail: z.string().max(128).nullable(),
  capturedAt: z.string().datetime(),
}).strict();

export const travelConversationInputSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  place: conversationPlaceSchema.optional(),
  intent: conversationIntentSchema.optional(),
  // Typed catalogue facts plus the traveller's own highlighted notes, which
  // share one array. Sized as the sum of both caps in
  // `conversation-memory-context.ts`: when this was 16 — the typed cap alone —
  // adding notes pushed a real profile past it and every turn failed input
  // validation, which reads as a reply that never comes.
  memoryContext: z.array(memoryContextFactSchema).max(36).default([]),
  researchEvidence: z.array(researchEvidenceOfferSchema).max(12).default([]),
  // Server-derived minimal Trip context, attached by the worker after
  // membership re-verification.  Optional so existing tests / non-trip
  // unit paths keep working; in production this is always present.
  tripContext: personalTripContextSchema.optional(),
  threadContext: z.array(threadContextMessageSchema).max(24)
    .superRefine((messages, ctx) => {
      const total = messages.reduce((sum, message) => sum + message.content.length, 0);
      if (total > 20_000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "threadContext exceeds conversation context character budget",
        });
      }
    }),
}).strict();

export const travelConversationOutputSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  responseMode: conversationResponseModeSchema,
  // Owner-stated departure/destination/date update, extracted from this turn
  // by a separate best-effort model call (see the gateway's
  // `extractTripBriefProposal`) — never fabricated by this Skill itself.
  tripBriefProposal: z.object({
    departureCities: z.array(z.string().trim().min(1).max(64)).min(1).max(3).optional(),
    destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(1).max(5).optional(),
    travelDateStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    travelDateEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    travelDays: z.number().int().min(1).max(365).optional(),
  }).strict().optional(),
}).strict();

export type TravelConversationInput = z.infer<typeof travelConversationInputSchema>;
export type TravelConversationOutput = z.infer<typeof travelConversationOutputSchema>;

/**
 * Phase 4 tool-calling context. None of these fields are part of the public
 * Skill input contract — they are passed by the conversation worker when the
 * env-gated `PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED` flag is on AND the
 * `hotel.search` capability is allowed. The Skill treats them as opaque:
 *   - `tools` / `dispatchTool` are forwarded to the streaming gateway.
 *   - `evidenceBacked` is plumbed into the OUTPUT-side safety filter so the
 *     LLM can summarise prices drawn from a fresh `personal_research_evidence`
 *     row without being rejected by the price/hotel rule.
 *   - `userConfirmed` is plumbed into the INPUT-side safety filter so a
 *     legitimate "确认搜索 / execute search" reply that happens to mention
 *     a currency or inventory term is not rejected before the LLM sees it.
 */
export interface TravelConversationToolContext {
  tools?: import("../../providers/model-gateway.js").ModelToolDefinition[];
  dispatchTool?: import("../../providers/model-gateway.js").ModelToolDispatcher;
  /**
   * Which search-readiness contracts to append to the system prompt for THIS
   * turn. The worker chooses them (`selectResponseConstraints`); an omitted
   * or empty list means the turn carries none.
   *
   * This was a module constant holding both, so every turn carried ~3.6k
   * characters of imperative "必须调用 hotel.search" detail — over six times
   * the base prompt's planning-priority text, and last in the prompt. A
   * traveller who said only "国庆带女朋友去新加坡玩4天" was answered with
   * airport codes, room counts and two search-confirmation buttons; the trip
   * brief never received its dates, so the handoff to planning could not
   * happen at all. Omitting the contract weakens no boundary: the base prose
   * still governs, and every safety rule lives outside these two blocks.
   */
  responseConstraints?: readonly ConversationResponseConstraint[];
  /**
   * Whether a supplier answered during this turn.
   *
   * A getter, not a value: the tools run inside the gateway call below, so at
   * the moment this context is built no evidence exists yet. Passing a
   * boolean captured beforehand always read false, and the output filter then
   * replaced answers that were fully grounded — the search happened, the
   * prices came back, and the traveller was told the chat cannot verify
   * prices.
   */
  isEvidenceBacked?: () => boolean;
  userConfirmed?: boolean;
  hotelSearchState?: import("../../providers/model-gateway.js").ConversationHotelSearchState | null;
  flightSearchState?: import("../../providers/model-gateway.js").ConversationFlightSearchState | null;
}

export async function executeTravelConversation(
  ctx: SkillContext,
  input: TravelConversationInput,
  signal: AbortSignal,
  onDelta?: (delta: string) => void | Promise<void>,
  toolContext: TravelConversationToolContext = {},
): Promise<TravelConversationOutput> {
  if (requestsUnsupportedOperationalFacts(input.question, { userConfirmed: toolContext.userConfirmed === true })) {
    const refusal = safeConversationRefusal(input.question);
    if (onDelta) await onDelta(refusal.content);
    return refusal;
  }

  let reply;
  try {
    const gateway = modelGateway();
    reply = onDelta && gateway.streamConversationReply
      ? await gateway.streamConversationReply({
          question: input.question,
          place: input.place,
          threadContext: input.threadContext,
          memoryContext: input.memoryContext,
          researchEvidence: input.researchEvidence,
          intent: input.intent,
          responseConstraints: toolContext.responseConstraints ?? [],
          tripContext: input.tripContext,
          hotelSearchState: toolContext.hotelSearchState,
          flightSearchState: toolContext.flightSearchState,
          onDelta,
          signal,
          ctx: ctx.ctx,
          tools: toolContext.tools,
          dispatchTool: toolContext.dispatchTool,
        })
      : await gateway.generateConversationReply({
          question: input.question,
          place: input.place,
          threadContext: input.threadContext,
          memoryContext: input.memoryContext,
          researchEvidence: input.researchEvidence,
          intent: input.intent,
          responseConstraints: toolContext.responseConstraints ?? [],
          tripContext: input.tripContext,
          hotelSearchState: toolContext.hotelSearchState,
          flightSearchState: toolContext.flightSearchState,
          signal,
          ctx: ctx.ctx,
        });
    if (onDelta && !gateway.streamConversationReply) await onDelta(reply.content);
  } catch (error) {
    // ModelGatewayError now only fires when the streaming connection aborts
    // mid-flight (partial chunks already delivered to the UI). The
    // retry-exhausted path returns a `responseMode: "FALLBACK"` reply that
    // we deliberately want to surface, so we let it pass through.
    if (!(error instanceof ModelGatewayError)) throw error;
    throw new SkillError(modelErrorCode(error.code), "The conversation stream was interrupted mid-flight.");
  }
  if (
    reply.responseMode === "MODEL"
    && containsUnsupportedOperationalClaim(reply.content, {
      evidenceBacked: toolContext.isEvidenceBacked?.() === true,
    })
  ) {
    // Diagnostic only: a refusal here discards a reply the model actually
    // produced, and when a metered tool has already run it also discards
    // results the traveller has paid for. Knowing which of the two rules
    // tripped — evidence not counted, or the wording itself — is the
    // difference between a config bug and a copy bug.
    pinoInstance.warn({
      event: "conversation.output_refused",
      evidenceBacked: toolContext.isEvidenceBacked?.() === true,
      contentSample: reply.content.slice(0, 300),
    }, "Conversation reply refused by the output safety check");
    return safeConversationRefusal(input.question);
  }

  let tripBriefProposal: TravelConversationOutput["tripBriefProposal"];
  if (reply.responseMode === "MODEL" && input.tripContext && input.tripContext.tripStatus === "DRAFT") {
    try {
      const gateway = modelGateway();
      const extracted = await gateway.extractTripBriefProposal?.({
        question: input.question,
        replyContent: reply.content,
        tripContext: input.tripContext,
        signal,
        ctx: ctx.ctx,
      });
      if (extracted && Object.keys(extracted).length > 0) tripBriefProposal = extracted;
    } catch {
      // Best-effort only — never fail the conversation turn over this.
    }
  }

  return travelConversationOutputSchema.parse({ ...reply, tripBriefProposal });
}

function modelErrorCode(code: string): "TIMEOUT" | "NETWORK" | "UPSTREAM_5XX" | "SCHEMA_PARSE" | "UPSTREAM_FAILURE" {
  if (code === "TIMEOUT" || code === "NETWORK" || code === "UPSTREAM_5XX" || code === "SCHEMA_PARSE") return code;
  return "UPSTREAM_FAILURE";
}

export const travelConversationSkill: Skill<TravelConversationInput, TravelConversationOutput> = {
  name: "travel.conversation",
  agent: "personal",
  version: "1.2.0",
  // Phase 4: `hotel:search` is added so the Personal Skill can register a
  // tool definition with the streaming gateway. The conversation worker
  // still gates the dispatcher on `PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED`
  // AND `isPersonalResearchCapabilityAllowed("hotel.search")`, so the
  // broader Personal agent never receives a tool call unless the feature
  // is on AND the capability is enabled.
  allowedTools: ["chat:read", "hotel:search"],
  timeoutMs: 15_000,
  needsConfirm: false,
  input: travelConversationInputSchema,
  output: travelConversationOutputSchema,
  async handler(ctx, input, signal) {
    return executeTravelConversation(ctx, input, signal);
  },
};
