/**
 * The preference card: a trip's one chance to ask whether the traveller's
 * profile is right for *this* trip.
 *
 * Someone can prefer unhurried travel in general and still want Beijing
 * packed. The profile is the baseline; this is where they say otherwise,
 * before the assistant has planned anything around the wrong assumption.
 *
 * Shown once per member per trip. Most people will close it — inheriting is
 * usually right — so "has an override" cannot stand in for "has been asked":
 * that would re-offer the card on every visit until they changed something,
 * which is nagging rather than offering.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/database.js";
import { sharedTrips, tripPreferenceCardViews } from "../db/schema.js";
import { MEMORY_FIELD_CATALOG, memoryFieldDefinition } from "../memory/memory-field-catalog.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";
import { listActiveFacts } from "./preference-fact-service.js";
import { assertActiveMember, listOverridesForOwner, saveOverride } from "./trip-memory-service.js";

export type PreferenceCardField = {
  fieldKey: string;
  category: "PREFERENCE" | "CONSTRAINT";
  /** What applies here today: the trip's value if it has one, else the profile's. */
  value: unknown;
  /** Whether that value came from the profile rather than this trip. */
  inherited: boolean;
  /** The values the field accepts, when it is a closed set. */
  options: string[] | null;
  /**
   * What kind of value the field holds, so the card can render the right
   * control and send the right type.
   *
   * The card used to infer this from the value it was showing, which is null
   * for everything not set yet. So the first time anyone filled in a field
   * they got a text box and sent a string: `interests` wants an array,
   * `no_red_eye` a boolean, `budget_max_usd` a number. Each was rejected by
   * the catalogue, and because the rejection throws before
   * `resolvePreferenceCard` records the card as seen, the answer was lost
   * *and* the card came back. Only the two enums and the one genuine string
   * field ever saved — which is exactly what the stored data shows.
   */
  kind: "enum" | "list" | "boolean" | "number" | "text";
};

export type PreferenceCard = {
  show: boolean;
  fields: PreferenceCardField[];
};

/**
 * `FORM_ONLY` fields are absent by design. Nationality, date of birth and
 * mobility notes are the profile form's to write; a trip card is not the place
 * to change who someone is.
 */
function standardFields() {
  return Object.values(MEMORY_FIELD_CATALOG).filter((field) => field.sensitivity === "STANDARD");
}

function optionsFor(fieldKey: string): string[] | null {
  // `.options` is the public accessor; the internal `_def` shape moved
  // between Zod versions and reading it returned nothing for every enum,
  // which would have rendered a free-text box where a choice belongs.
  const definition = memoryFieldDefinition(fieldKey);
  const options = (definition?.schema as unknown as { options?: unknown }).options;
  return Array.isArray(options) ? (options as string[]) : null;
}

/** Asked of the schema, which is the only thing that actually knows. */
function kindOf(fieldKey: string): PreferenceCardField["kind"] {
  const schema = memoryFieldDefinition(fieldKey)?.schema;
  if (optionsFor(fieldKey)) return "enum";
  if (schema instanceof z.ZodArray) return "list";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodNumber) return "number";
  return "text";
}

export async function readPreferenceCard(params: {
  tripId: string;
  userId: string;
}): Promise<PreferenceCard> {
  await assertActiveMember(params.tripId, params.userId);

  const [seen] = await db.select().from(tripPreferenceCardViews).where(and(
    eq(tripPreferenceCardViews.tripId, params.tripId),
    eq(tripPreferenceCardViews.userId, params.userId),
  )).limit(1);

  const [profile, overrides] = await Promise.all([
    listActiveFacts(params.userId),
    listOverridesForOwner(params.tripId, params.userId),
  ]);
  const profileByField = new Map(profile.map((fact) => [fact.fieldKey, fact.value]));
  const overrideByField = new Map(overrides.map((override) => [override.fieldKey, override.value]));

  const fields = standardFields().map((definition): PreferenceCardField => {
    const overridden = overrideByField.has(definition.key);
    return {
      fieldKey: definition.key,
      category: definition.category,
      value: overridden ? overrideByField.get(definition.key) : profileByField.get(definition.key) ?? null,
      inherited: !overridden,
      options: optionsFor(definition.key),
      kind: kindOf(definition.key),
    };
  });

  return { show: !seen, fields };
}

/**
 * Records the traveller's answer, whatever it was.
 *
 * An empty `adjustments` is a real answer — "the profile is right for this
 * trip" — and writes no override, so the trip keeps inheriting and a later
 * change to the profile still reaches it. Either way the card is done.
 */
export async function resolvePreferenceCard(params: {
  ctx: RequestContext;
  tripId: string;
  userId: string;
  adjustments: Array<{ fieldKey: string; value: unknown }>;
}): Promise<{ applied: string[] }> {
  await assertActiveMember(params.tripId, params.userId);

  return db.transaction(async (tx) => {
    const applied: string[] = [];
    let departureCity: string | null = null;
    for (const adjustment of params.adjustments) {
      const definition = memoryFieldDefinition(adjustment.fieldKey);
      // A field the card never offered cannot be set through it, whatever the
      // request says — `FORM_ONLY` most of all.
      if (!definition || definition.sensitivity !== "STANDARD") continue;
      const saved = await saveOverride({
        ctx: params.ctx,
        tripId: params.tripId,
        userId: params.userId,
        fieldKey: adjustment.fieldKey,
        value: adjustment.value,
        tx,
      });
      // Departure is both a per-member trip preference and a required piece of
      // the draft's shared brief. Keep the two in sync for this trip only; it
      // must never be promoted into the user's long-term profile memory.
      if (adjustment.fieldKey === "departure_city" && typeof saved.value === "string") {
        departureCity = saved.value;
      }
      applied.push(adjustment.fieldKey);
    }

    // Unchanged fields are deliberately omitted by the card client. When the
    // traveller accepts an inherited departure city, use that effective
    // profile value to complete the current trip's draft brief as well.
    if (!departureCity) {
      const profileDeparture = (await listActiveFacts(params.userId, tx))
        .find((fact) => fact.fieldKey === "departure_city")?.value;
      if (typeof profileDeparture === "string") departureCity = profileDeparture;
    }

    if (departureCity) {
      const [trip] = await tx.select({ status: sharedTrips.status }).from(sharedTrips)
        .where(eq(sharedTrips.id, params.tripId)).for("update");
      // The brief is editable only until planning begins. A preference card
      // answered later must not silently rewrite an activated shared plan.
      if (trip?.status === "DRAFT") {
        const now = new Date();
        await tx.update(sharedTrips).set({
          departureCities: [departureCity],
          pendingBriefProposal: null,
          updatedAt: now,
        }).where(eq(sharedTrips.id, params.tripId));
        await recordAudit({
          ctx: params.ctx,
          action: "TRIP_DRAFT_BRIEF_UPDATE",
          actorUserId: params.userId,
          tripId: params.tripId,
          summary: { source: "preference_card", changedFields: ["departureCities"] },
          tx,
        });
      }
    }

    await tx.insert(tripPreferenceCardViews)
      .values({ tripId: params.tripId, userId: params.userId })
      .onConflictDoNothing({ target: [tripPreferenceCardViews.tripId, tripPreferenceCardViews.userId] });

    return { applied };
  });
}
