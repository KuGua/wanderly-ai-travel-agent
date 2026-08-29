import { z } from "zod";

import { memoryProjectionSchema, type MemoryProjection } from "../../types/schemas.js";

/**
 * The Shared Trip Agent's only view of personal memory
 * (docs/long-term-memory-implementation.md §4.4, §5.3).
 *
 * The Shared Agent has no repository access and no memory Skill. Everything it
 * knows about what members prefer arrives inside an immutable snapshot, and
 * this module is the single place that reads it. A Shared Skill that wants a
 * preference embeds `sharedMemoryInputSchema` and calls `readMemoryProjection`;
 * it never reaches into `authorized_data` itself.
 *
 * Reading through a parse rather than a cast is the point. A snapshot is a
 * JSONB blob, so anything that ends up in `_meta.memory` would otherwise be
 * handed to the model verbatim, including a field that was never supposed to be
 * exportable. Parsing turns that into a load-time failure.
 */

/** Members carry no user ids here — only the run-scoped aliases. */
export const sharedMemoryInputSchema = z.object({
  memory: memoryProjectionSchema,
}).strict();

export type SharedMemoryInput = z.infer<typeof sharedMemoryInputSchema>;

export class MemoryProjectionUnavailableError extends Error {
  constructor(reason: string) {
    super(`Memory projection is unavailable: ${reason}`);
    this.name = "MemoryProjectionUnavailableError";
  }
}

const EMPTY_PROJECTION: MemoryProjection = Object.freeze({
  members: {},
  groupDecisions: {},
});

/**
 * Extracts the memory namespace from a snapshot's `authorized_data`.
 *
 * Returns an empty projection for a snapshot taken before the namespace
 * existed: a Shared run over an older snapshot should plan without preferences,
 * not fail. A namespace that is present but malformed throws — that is a
 * projection bug, and planning on a half-understood shape is worse than
 * stopping.
 */
export function readMemoryProjection(authorizedData: unknown): MemoryProjection {
  if (!authorizedData || typeof authorizedData !== "object") return EMPTY_PROJECTION;

  const meta = (authorizedData as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return EMPTY_PROJECTION;

  const memory = (meta as Record<string, unknown>).memory;
  if (memory === undefined || memory === null) return EMPTY_PROJECTION;

  const parsed = memoryProjectionSchema.safeParse(memory);
  if (!parsed.success) {
    throw new MemoryProjectionUnavailableError(
      parsed.error.issues.map((issue) => issue.path.join(".") || "root").join(", "),
    );
  }
  return parsed.data;
}

/**
 * Preferences that apply to the whole trip: group decisions, plus anything
 * every member independently agrees on.
 *
 * A field only counts as unanimous when every member expresses it, so a trip
 * where one member stated nothing has no unanimous value — silence is not
 * assent. A group decision always wins over member preferences, because it is
 * the trip's own decision rather than an inference about it.
 */
export function tripWidePreferences(projection: MemoryProjection): Record<string, unknown> {
  const aliases = Object.keys(projection.members);
  const result: Record<string, unknown> = {};

  if (aliases.length > 0) {
    const counts = new Map<string, { value: unknown; agree: number }>();
    for (const alias of aliases) {
      const member = projection.members[alias];
      // A this-trip override is what the member wants for this trip, so it
      // takes precedence over their standing profile fact.
      const effective = { ...member.profileFacts, ...member.tripOverrides };
      for (const [fieldKey, value] of Object.entries(effective)) {
        const seen = counts.get(fieldKey);
        if (!seen) {
          counts.set(fieldKey, { value, agree: 1 });
        } else if (JSON.stringify(seen.value) === JSON.stringify(value)) {
          seen.agree += 1;
        } else {
          seen.agree = -1; // conflicting; can never be unanimous
        }
      }
    }
    for (const [fieldKey, seen] of counts) {
      if (seen.agree === aliases.length) result[fieldKey] = seen.value;
    }
  }

  return { ...result, ...projection.groupDecisions };
}
