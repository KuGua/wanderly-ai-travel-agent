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
 * This is a capability-level behaviour contract, not a canned hotel reply.
 * The model activates it only when the current conversation is about lodging;
 * it must reuse the actual question and trusted thread context to decide what
 * is already known and what to ask next.
 */
const TRAVEL_CONVERSATION_RESPONSE_CONSTRAINTS: readonly ConversationResponseConstraint[] = [
  "HOTEL_SEARCH_READINESS",
];

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
  source: z.enum(["PROFILE_FORM", "PROPOSAL_CONFIRMATION"]),
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
  memoryContext: z.array(memoryContextFactSchema).max(16).default([]),
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
  evidenceBacked?: boolean;
  userConfirmed?: boolean;
  hotelSearchState?: import("../../providers/model-gateway.js").ConversationHotelSearchState | null;
}

export async function executeTravelConversation(
  ctx: SkillContext,
  input: TravelConversationInput,
  signal: AbortSignal,
  onDelta?: (delta: string) => void | Promise<void>,
  toolContext: TravelConversationToolContext = {},
): Promise<TravelConversationOutput> {
  if (requestsUnsupportedOperationalFacts(input.question, { userConfirmed: toolContext.userConfirmed === true })) {
    const refusal = safeConversationRefusal();
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
          responseConstraints: TRAVEL_CONVERSATION_RESPONSE_CONSTRAINTS,
          tripContext: input.tripContext,
          hotelSearchState: toolContext.hotelSearchState,
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
          responseConstraints: TRAVEL_CONVERSATION_RESPONSE_CONSTRAINTS,
          tripContext: input.tripContext,
          hotelSearchState: toolContext.hotelSearchState,
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
    && containsUnsupportedOperationalClaim(reply.content, { evidenceBacked: toolContext.evidenceBacked === true })
  ) {
    return safeConversationRefusal();
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
