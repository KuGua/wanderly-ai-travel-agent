import { z } from "zod";

import type { Skill } from "../../agents/contracts.js";
import {
  containsUnsupportedOperationalClaim,
  requestsUnsupportedOperationalFacts,
  safeConversationFallback,
} from "../../policy/conversation-safety.js";
import { modelGateway } from "../../providers/gateway-factory.js";
import {
  chatMessageRoleSchema,
  conversationPlaceSchema,
  conversationResponseModeSchema,
} from "../../types/schemas.js";

export const travelConversationInputSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  place: conversationPlaceSchema.optional(),
  history: z.array(z.object({
    role: chatMessageRoleSchema,
    content: z.string().min(1).max(1000),
  }).strict()).max(20),
}).strict();

export const travelConversationOutputSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  responseMode: conversationResponseModeSchema,
}).strict();

export type TravelConversationInput = z.infer<typeof travelConversationInputSchema>;
export type TravelConversationOutput = z.infer<typeof travelConversationOutputSchema>;

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
    if (requestsUnsupportedOperationalFacts(input.question)) {
      return safeConversationFallback();
    }

    const reply = await modelGateway().generateConversationReply({
      question: input.question,
      place: input.place,
      history: input.history,
      signal,
      ctx: ctx.ctx,
    });
    if (reply.responseMode === "MODEL" && containsUnsupportedOperationalClaim(reply.content)) {
      return safeConversationFallback();
    }
    return reply;
  },
};
