import { z } from "zod";
import type { Skill } from "../../agents/contracts.js";
import { buildAuthorizedData } from "../../services/consent-service.js";

export const profileMemoryInputSchema = z.object({
  tripId: z.string().uuid(),
  userId: z.string().uuid(),
  fields: z.array(z.string()).default([]),
}).strict();

export const profileMemoryOutputSchema = z.object({
  items: z.array(z.object({
    field: z.string(),
    value: z.unknown(),
    source: z.enum(["profile", "this_trip"]),
  })),
}).strict();

export type ProfileMemoryInput = z.infer<typeof profileMemoryInputSchema>;
export type ProfileMemoryOutput = z.infer<typeof profileMemoryOutputSchema>;

export const profileMemorySkill: Skill<ProfileMemoryInput, ProfileMemoryOutput> = {
  name: "profile.memory",
  agent: "personal",
  version: "1.0.0",
  allowedTools: ["profile:read"],
  timeoutMs: 2000,
  needsConfirm: false,
  input: profileMemoryInputSchema,
  output: profileMemoryOutputSchema,
  async handler(_ctx, input) {
    const authorized = await buildAuthorizedData({ tripId: input.tripId, userId: input.userId });
    const items = Object.entries(authorized)
      .filter(([field]) => input.fields.length === 0 || input.fields.includes(field))
      .map(([field, value]) => ({
        field,
        value,
        source: "profile" as const,
      }));
    return { items };
  },
};