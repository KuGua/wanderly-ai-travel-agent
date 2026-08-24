import { z } from "zod";
import type { Skill } from "../../agents/contracts.js";

const SENSITIVE_FIELDS = ["passportNumber", "dateOfBirth"];

export const profileChangeProposalInputSchema = z.object({
  userId: z.string().uuid(),
  field: z.string().min(1).max(64)
    .refine(field => !SENSITIVE_FIELDS.includes(field), {
      message: "Sensitive fields (passportNumber, dateOfBirth) cannot be proposed via Personal Agent",
    }),
  value: z.unknown(),
  source: z.enum(["profile", "this_trip"]),
}).strict().superRefine((data, ctx) => {
  if (data.field === "nationality" && data.source !== "this_trip") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["field"],
      message: "nationality may only be proposed for this trip, not stable profile",
    });
  }
});

export const profileChangeProposalOutputSchema = z.object({
  field: z.string(),
  value: z.unknown(),
  source: z.enum(["profile", "this_trip"]),
  proposedAt: z.string().datetime(),
}).strict();

export type ProfileChangeProposalInput = z.infer<typeof profileChangeProposalInputSchema>;
export type ProfileChangeProposalOutput = z.infer<typeof profileChangeProposalOutputSchema>;

export const profileChangeProposalSkill: Skill<ProfileChangeProposalInput, ProfileChangeProposalOutput> = {
  name: "profile.change_proposal",
  agent: "personal",
  version: "1.0.0",
  allowedTools: ["profile:write:propose"],
  timeoutMs: 1000,
  needsConfirm: true,
  input: profileChangeProposalInputSchema,
  output: profileChangeProposalOutputSchema,
  async handler(_ctx, input) {
    return {
      field: input.field,
      value: input.value,
      source: input.source,
      proposedAt: new Date().toISOString(),
    };
  },
};