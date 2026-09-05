import { z } from "zod";

import type { Skill } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { modelGateway } from "../../providers/gateway-factory.js";

/**
 * Owner-triggered trip destination label suggest
 * (docs/trip-title-destination-label-implementation.md §8.1 / §8.2).
 *
 * Inputs are owner USER messages only, server-truncated to ≤512 chars each
 * and capped at 3 entries (mirroring the thread-title contract). The skill
 * does **not** do safety filtering — the route runs the model output
 * through `trip-destination-label-postprocess` before any DB write, so a
 * rejected or free-text label never lands in the trip row.
 *
 * Language authority follows LLM-GATEWAY.md §User-visible language
 * contract: this skill has no "current question" so the server-validated
 * `locale` is the sole authority.
 */
export const tripDestinationLabelSuggestInputSchema = z.object({
  tripId: z.string().uuid(),
  locale: z.enum(["en", "zh"]),
  messages: z.array(z.object({
    text: z.string().min(1).max(512),
  })).min(1).max(3),
}).strict();

export const tripDestinationLabelSuggestOutputSchema = z.object({
  kind: z.enum(["COUNTRY", "CITY"]),
  value: z.string().min(1).max(64),
}).strict();

export type TripDestinationLabelSuggestInput = z.infer<typeof tripDestinationLabelSuggestInputSchema>;
export type TripDestinationLabelSuggestOutput = z.infer<typeof tripDestinationLabelSuggestOutputSchema>;

export const tripDestinationLabelSuggestSkill: Skill<TripDestinationLabelSuggestInput, TripDestinationLabelSuggestOutput> = {
  name: "trip.destination.label.suggest",
  agent: "personal",
  version: "1.0.0",
  allowedTools: [],
  // Owner waits in the foreground with a title that is currently bare.
  // A few-second round-trip is acceptable; longer must yield to manual rename.
  timeoutMs: 4000,
  needsConfirm: false,
  input: tripDestinationLabelSuggestInputSchema,
  output: tripDestinationLabelSuggestOutputSchema,
  async handler(ctx, input, signal) {
    const gateway = modelGateway();
    try {
      const raw = await gateway.generateTripDestinationLabel({
        locale: input.locale,
        messages: input.messages,
        signal,
        ctx: ctx.ctx,
      });
      const parsed = tripDestinationLabelSuggestOutputSchema.safeParse(raw);
      if (!parsed.success) {
        throw new SkillError("OUTPUT_INVALID", `Invalid gateway output: ${parsed.error.message}`);
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof SkillError) throw err;
      throw new SkillError(
        "UPSTREAM_FAILURE",
        `trip.destination.label.suggest: gateway call failed (${(err as Error)?.message ?? "unknown"})`,
      );
    }
  },
};
