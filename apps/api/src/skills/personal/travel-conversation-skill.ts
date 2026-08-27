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

export const travelConversationInputSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  place: conversationPlaceSchema.optional(),
  intent: conversationIntentSchema.optional(),
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
}).strict();

export type TravelConversationInput = z.infer<typeof travelConversationInputSchema>;
export type TravelConversationOutput = z.infer<typeof travelConversationOutputSchema>;

export async function executeTravelConversation(
  ctx: SkillContext,
  input: TravelConversationInput,
  signal: AbortSignal,
  onDelta?: (delta: string) => void | Promise<void>,
): Promise<TravelConversationOutput> {
  if (requestsUnsupportedOperationalFacts(input.question)) {
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
          intent: input.intent,
          tripContext: input.tripContext,
          onDelta,
          signal,
          ctx: ctx.ctx,
        })
      : await gateway.generateConversationReply({
          question: input.question,
          place: input.place,
          threadContext: input.threadContext,
          intent: input.intent,
          tripContext: input.tripContext,
          signal,
          ctx: ctx.ctx,
        });
    if (onDelta && !gateway.streamConversationReply) await onDelta(reply.content);
  } catch (error) {
    if (error instanceof ModelGatewayError) {
      const code = modelErrorCode(error.code);
      throw new SkillError(code, "The conversation model is temporarily unavailable. Please retry.");
    }
    throw error;
  }
  if (reply.responseMode === "MODEL" && containsUnsupportedOperationalClaim(reply.content)) {
    return safeConversationRefusal();
  }
  return travelConversationOutputSchema.parse(reply);
}

function modelErrorCode(code: string): "TIMEOUT" | "NETWORK" | "UPSTREAM_5XX" | "SCHEMA_PARSE" | "UPSTREAM_FAILURE" {
  if (code === "TIMEOUT" || code === "NETWORK" || code === "UPSTREAM_5XX" || code === "SCHEMA_PARSE") return code;
  return "UPSTREAM_FAILURE";
}

export const travelConversationSkill: Skill<TravelConversationInput, TravelConversationOutput> = {
  name: "travel.conversation",
  agent: "personal",
  version: "1.0.0",
  allowedTools: ["chat:read"],
  timeoutMs: 15_000,
  needsConfirm: false,
  input: travelConversationInputSchema,
  output: travelConversationOutputSchema,
  async handler(ctx, input, signal) {
    return executeTravelConversation(ctx, input, signal);
  },
};