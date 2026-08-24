import { z } from "zod";
import type { Skill } from "../../agents/contracts.js";

export const readinessInputSchema = z.object({
  destination: z.string().min(1),
  memberIds: z.array(z.string().uuid()).min(1),
}).strict();

export const readinessOutputSchema = z.object({
  members: z.array(z.object({
    memberId: z.string().uuid(),
    status: z.enum(["PENDING", "OK"]),
    note: z.string(),
  })),
}).strict();

export type ReadinessInput = z.infer<typeof readinessInputSchema>;
export type ReadinessOutput = z.infer<typeof readinessOutputSchema>;

export const readinessSkill: Skill<ReadinessInput, ReadinessOutput> = {
  name: "readiness.check",
  agent: "shared",
  version: "1.0.0",
  allowedTools: ["readiness:read", "snapshot:read"],
  timeoutMs: 2_000,
  needsConfirm: false,
  input: readinessInputSchema,
  output: readinessOutputSchema,
  async handler(_ctx, input) {
    return {
      members: input.memberIds.map(memberId => ({
        memberId,
        status: "PENDING" as const,
        note: "Readiness pending — verify with official government sources",
      })),
    };
  },
};