import { z } from "zod";

import type { Skill } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { modelGateway } from "../../providers/gateway-factory.js";

/**
 * Owner-triggered thread title suggest
 * (docs/thread-title-lifecycle-implementation.md §9.1).
 *
 * Inputs are owner USER messages only, server-truncated to ≤512 chars each
 * and capped at 3 entries. The skill does **not** do safety filtering — the
 * route runs the model output through the dedicated postprocess module
 * (services/thread-title-suggest-postprocess.ts) before any DB write, so a
 * rejected title never lands in the chat_threads row.
 *
 * Language authority follows LLM-GATEWAY.md §User-visible language
 * contract: this skill has no "current question" so the server-validated
 * `locale` is the sole authority.
 */
export const threadTitleSuggestInputSchema = z.object({
  threadId: z.string().uuid(),
  locale: z.enum(["en", "zh"]),
  messages: z.array(z.object({
    text: z.string().min(1).max(512),
  })).min(1).max(3),
}).strict();

export const threadTitleSuggestOutputSchema = z.object({
  title: z.string().min(1).max(40),
}).strict();

export type ThreadTitleSuggestInput = z.infer<typeof threadTitleSuggestInputSchema>;
export type ThreadTitleSuggestOutput = z.infer<typeof threadTitleSuggestOutputSchema>;

export const threadTitleSuggestSkill: Skill<ThreadTitleSuggestInput, ThreadTitleSuggestOutput> = {
  name: "thread.title.suggest",
  agent: "personal",
  version: "1.0.0",
  allowedTools: [],
  // User waits in the foreground, so this is more generous than the
  // trip.constraint.propose 1500ms — but a real LLM round-trip with retries
  // is bounded at a few seconds.
  timeoutMs: 4000,
  needsConfirm: false,
  input: threadTitleSuggestInputSchema,
  output: threadTitleSuggestOutputSchema,
  async handler(ctx, input, signal) {
    const gateway = modelGateway();
    if (!gateway.generateThreadTitle) {
      // The route maps UPSTREAM_FAILURE to the user-visible reason
      // `UNAVAILABLE`, so the user can retry or fall back to manual rename.
      throw new SkillError(
        "UPSTREAM_FAILURE",
        "thread.title.suggest: gateway does not implement generateThreadTitle",
      );
    }

    try {
      const raw = await gateway.generateThreadTitle({
        locale: input.locale,
        messages: input.messages,
        signal,
        ctx: ctx.ctx,
      });
      const parsed = threadTitleSuggestOutputSchema.safeParse(raw);
      if (!parsed.success) {
        throw new SkillError("OUTPUT_INVALID", `Invalid gateway output: ${parsed.error.message}`);
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof SkillError) throw err;
      throw new SkillError(
        "UPSTREAM_FAILURE",
        `thread.title.suggest: gateway call failed (${(err as Error).message ?? "unknown"})`,
      );
    }
  },
};
