import { and, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { preferenceFacts } from "../db/schema.js";
import { memoryFieldDefinition } from "../memory/memory-field-catalog.js";
import { logger } from "../utils/logger.js";
import type { RequestContext } from "../utils/context.js";
import { clearPendingProposalsForField } from "./memory-proposal-service.js";
import { MemoryFieldRejectedError, replaceFact } from "./preference-fact-service.js";

/**
 * Mirrors the Profile form into long-term memory.
 *
 * `user_profiles` columns are the form's storage; `preference_facts` is what
 * memory is built from — the version chain, the exemption from decay, and the
 * consent projection all live there. Writing only the columns meant a
 * preference the user explicitly stated never became a fact at all: it could
 * not be projected to a trip, and a behaviour suggestion could still ask the
 * user about something they had already answered on the form.
 *
 * Stating a value on the form is the user speaking for themselves, so it also
 * clears any pending suggestion for that field.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Profile column -> memory field key. Columns with no memory field are absent. */
const PROFILE_COLUMN_TO_FIELD: Readonly<Record<string, string>> = Object.freeze({
  accommodationStyle: "accommodation_style",
  noRedEye: "no_red_eye",
  interests: "interests",
  budgetMaxUsd: "budget_max_usd",
  departureCity: "departure_city",
  nationality: "nationality",
  dateOfBirth: "date_of_birth",
  mobilityNotes: "mobility_notes",
});

export type ProfileFormSyncResult = {
  written: string[];
  cleared: string[];
  /** Fields the memory catalog would not accept; the column still holds them. */
  skipped: string[];
};

/**
 * Applies one Profile form submission to memory.
 *
 * Only keys present in `body` are touched, because the form is a partial
 * update: an absent field means "unchanged", not "cleared".
 *
 * A value the memory catalog rejects is skipped rather than raised. The profile
 * column is the user's own storage and its schema is looser than memory's — a
 * longer interest list, say — and failing the whole profile update over the
 * mirror would let memory veto what a user may record about themselves.
 */
export async function syncProfileFormToMemory(input: {
  ctx: RequestContext;
  userId: string;
  profileId: string;
  body: Record<string, unknown>;
  tx?: Tx;
}): Promise<ProfileFormSyncResult> {
  const run = async (tx: Tx): Promise<ProfileFormSyncResult> => {
    const result: ProfileFormSyncResult = { written: [], cleared: [], skipped: [] };

    for (const [column, fieldKey] of Object.entries(PROFILE_COLUMN_TO_FIELD)) {
      if (!Object.hasOwn(input.body, column)) continue;
      if (!memoryFieldDefinition(fieldKey)) continue;

      const value = input.body[column];

      if (value === null || value === undefined) {
        // Clearing the form field clears the fact. The whole version chain
        // goes, so no superseded row keeps the old value readable.
        const removed = await tx.delete(preferenceFacts).where(and(
          eq(preferenceFacts.userId, input.userId),
          eq(preferenceFacts.fieldKey, fieldKey),
        )).returning({ id: preferenceFacts.id });
        if (removed.length > 0) result.cleared.push(fieldKey);
        continue;
      }

      try {
        await replaceFact({
          ctx: input.ctx,
          userId: input.userId,
          profileId: input.profileId,
          fieldKey,
          value,
          path: "PROFILE_FORM",
          tx,
        });
        result.written.push(fieldKey);
      } catch (error) {
        if (!(error instanceof MemoryFieldRejectedError)) throw error;
        // Only the field and reason — never the value the user submitted.
        logger.debug({
          fieldKey,
          reason: error.reason,
        }, "Profile field not mirrored into memory");
        result.skipped.push(fieldKey);
        continue;
      }

      // The user has just answered the question a suggestion would ask.
      await clearPendingProposalsForField({
        userId: input.userId,
        fieldKey,
        tx,
      });
    }

    return result;
  };

  return input.tx ? run(input.tx) : db.transaction(run);
}

/**
 * Removes every fact backing a deleted profile.
 *
 * Deleting the profile is a deletion request for what it recorded, so the facts
 * cannot outlive it — they would otherwise keep projecting into trips.
 */
export async function deleteProfileFormMemory(input: {
  userId: string;
  tx?: Tx;
}): Promise<number> {
  const target = input.tx ?? db;
  const removed = await target.delete(preferenceFacts)
    .where(eq(preferenceFacts.userId, input.userId))
    .returning({ id: preferenceFacts.id });
  return removed.length;
}
