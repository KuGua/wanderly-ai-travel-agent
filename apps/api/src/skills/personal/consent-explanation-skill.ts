import { z } from "zod";
import type { Skill } from "../../agents/contracts.js";
import { getActiveConsents } from "../../services/consent-service.js";

export const consentExplanationInputSchema = z.object({
  tripId: z.string().uuid(),
  userId: z.string().uuid(),
}).strict();

export const consentExplanationOutputSchema = z.object({
  scopes: z.array(z.object({
    scope: z.string(),
    fields: z.array(z.string()),
  })),
}).strict();

export type ConsentExplanationInput = z.infer<typeof consentExplanationInputSchema>;
export type ConsentExplanationOutput = z.infer<typeof consentExplanationOutputSchema>;

export const consentExplanationSkill: Skill<ConsentExplanationInput, ConsentExplanationOutput> = {
  name: "consent.explanation",
  agent: "personal",
  version: "1.0.0",
  allowedTools: ["consent:read"],
  timeoutMs: 2000,
  needsConfirm: false,
  input: consentExplanationInputSchema,
  output: consentExplanationOutputSchema,
  async handler(_ctx, input) {
    const grants = await getActiveConsents({ tripId: input.tripId, userId: input.userId });
    return {
      scopes: grants.map(grant => ({ scope: grant.scope, fields: grant.fieldList })),
    };
  },
};