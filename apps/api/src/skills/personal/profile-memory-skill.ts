import { z } from "zod";
import type { Skill } from "../../agents/contracts.js";
import { listActiveFacts } from "../../services/preference-fact-service.js";
import { listSurfaceableProposals } from "../../services/memory-proposal-service.js";
import { memoryFieldDefinition } from "../../memory/memory-field-catalog.js";

/**
 * `profile.memory` — the Personal Agent's read into long-term memory.
 *
 * Per §5.2 this is an owner-only read of active preference facts. It is
 * deliberately *not* gated on trip consent: consent governs what may be
 * exported to the Shared Agent, not whether an owner's own agent may recall
 * what the owner told it. Cross-trip recall is what makes memory persist
 * across sessions.
 *
 * Pending proposals are returned as clearly-marked suggestions so the agent can
 * ask, but never as established facts. The behavioural evidence behind them —
 * counts aside — is not exposed.
 *
 * The owner comes from the authenticated context and is not an input. Skill
 * input is model-supplied, so a `userId` field would be a request the model
 * could write, and "always the authenticated caller" would be a convention
 * rather than a rule. Long-term memory is the last place to leave that to
 * convention.
 */

export const profileMemoryInputSchema = z.object({
  /** Optional correlation only; it does not widen or narrow what is returned. */
  tripId: z.string().uuid().optional(),
  fields: z.array(z.string()).default([]),
  includeSuggestions: z.boolean().default(false),
}).strict();

export const profileMemoryOutputSchema = z.object({
  items: z.array(z.object({
    field: z.string(),
    value: z.unknown(),
    category: z.enum(["PREFERENCE", "CONSTRAINT"]),
    source: z.enum(["PROFILE_FORM", "PROPOSAL_CONFIRMATION"]),
    updatedAt: z.string(),
  })),
  /** Unconfirmed candidates. Never treat these as true. */
  suggestions: z.array(z.object({
    field: z.string(),
    value: z.unknown(),
    /** Aggregate evidence only — no dates, trips, activation or score (§5.4). */
    observationCount: z.number().int().nonnegative(),
    distinctTripCount: z.number().int().nonnegative(),
  })).default([]),
}).strict();

export type ProfileMemoryInput = z.infer<typeof profileMemoryInputSchema>;
export type ProfileMemoryOutput = z.infer<typeof profileMemoryOutputSchema>;

export const profileMemorySkill: Skill<ProfileMemoryInput, ProfileMemoryOutput> = {
  name: "profile.memory",
  agent: "personal",
  version: "2.0.0",
  allowedTools: ["profile:read"],
  timeoutMs: 2000,
  needsConfirm: false,
  input: profileMemoryInputSchema,
  output: profileMemoryOutputSchema,
  async handler({ ctx }, input) {
    // The owner is whoever the task authenticated as, never anything the model
    // asked for. Absent means the skill was invoked outside an authenticated
    // task, which must fail rather than read a default.
    const ownerUserId = ctx.actorUserId;
    if (!ownerUserId) {
      throw new Error("Skill invoked without an authenticated actor");
    }

    const wanted = new Set(input.fields);
    const matches = (field: string) => wanted.size === 0 || wanted.has(field);

    const facts = await listActiveFacts(ownerUserId);
    const items = facts
      .filter((fact) => matches(fact.fieldKey))
      // Unregistered keys can exist from older rows; skip rather than emit a
      // field the catalogue no longer vouches for.
      .filter((fact) => memoryFieldDefinition(fact.fieldKey) !== null)
      .map((fact) => ({
        field: fact.fieldKey,
        value: fact.value,
        category: fact.category,
        source: fact.source,
        updatedAt: fact.updatedAt.toISOString(),
      }));

    if (!input.includeSuggestions) return { items, suggestions: [] };

    // Only candidates that have cleared the full trigger rule are shown.
    const proposals = await listSurfaceableProposals(ownerUserId);
    const suggestions = proposals
      .filter((proposal) => matches(proposal.fieldKey))
      .map((proposal) => ({
        field: proposal.fieldKey,
        value: proposal.proposedValue,
        observationCount: proposal.observationCount,
        distinctTripCount: proposal.distinctTripCount,
      }));

    return { items, suggestions };
  },
};
