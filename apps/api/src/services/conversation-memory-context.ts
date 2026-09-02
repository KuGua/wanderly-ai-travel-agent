/**
 * Long-term memory for the Personal Agent's conversation turn.
 *
 * `buildConversationContext` gives the model the recent *same-thread*
 * window. This module gives it the part that survives across threads and
 * across trips: the owner's active `preference_facts`.
 *
 * Owner-only, like `profile.memory` (§5.2): consent governs export to the
 * Shared Agent, not whether an owner's own agent may recall what the owner
 * told it. The owner always arrives from the authenticated task, never from
 * anything a model wrote.
 *
 * `FORM_ONLY` fields (nationality, date of birth, mobility notes) are
 * withheld. The catalogue states the *write* rule for them — only the
 * owner's Profile form may create them — and is silent on reads. Sending
 * them to a third-party model on every conversation turn is a wider
 * exposure than storing them, so this builder takes the narrow reading.
 * Widening it later is a one-line change; un-sending them is not.
 *
 * ## What this module does NOT read — and what that means for testing it
 *
 * There are two memory channels, and only one of them reaches a conversation:
 *
 *   `preference_facts`     confirmed, owner-owned, never decays  → read here
 *   `memory_proposals`     behaviour-derived, ACT-R scored       → NOT read here
 *
 * The whole ACT-R contest — which value is winning, by how much, whether a new
 * habit has overtaken an old one — is invisible to the agent until the owner
 * confirms a proposal and it becomes a fact. A proposal that is comfortably the
 * leader still changes nothing about what the model is told.
 *
 * So the answerable question in a chat box is never "which proposal is
 * dominant"; it is "after confirming, did the new value replace the old one".
 * Reading proposal tables while testing recall leads to the opposite conclusion
 * from the truth, which has cost real debugging time.
 */
import { memoryFieldDefinition } from "../memory/memory-field-catalog.js";
import { metrics } from "../observability/metrics.js";
import { listFreeTextMemories } from "./free-text-memory-service.js";
import { listOverridesForOwner } from "./trip-memory-service.js";
import { listActiveFacts } from "./preference-fact-service.js";

export type ConversationMemoryFact = {
  field: string;
  value: unknown;
  category: "PREFERENCE" | "CONSTRAINT";
  source: "PROFILE_FORM" | "PROPOSAL_CONFIRMATION" | "HIGHLIGHT" | "TRIP_OVERRIDE";
};

/**
 * The catalogue is small and bounded, so this ceiling is a guard against a
 * future catalogue growing without anyone revisiting the prompt budget —
 * not an expected truncation point.
 */
export const CONVERSATION_MEMORY_MAX_FACTS = 16;

/**
 * How many characters of free-text memory may ride along.
 *
 * Each entry is capped at 500 characters and a traveller may keep 20, so the
 * store alone can reach 10,000 characters — sent on every single turn, which
 * is a cost and a latency the typed fields never imposed. The newest entries
 * are kept and the rest are left behind rather than cut mid-sentence: half a
 * remembered preference is worse than none.
 */
export const CONVERSATION_FREE_TEXT_BUDGET_CHARS = 2_000;

/**
 * How many notes may ride along, whatever the budget allows.
 *
 * The character budget alone is not a count, and the Skill's input schema
 * bounds the array it all arrives in. Twenty short notes fit inside 2,000
 * characters easily, so without this the two limits disagreed and the whole
 * turn failed its input validation — which the traveller saw as a reply that
 * never came.
 */
export const CONVERSATION_MEMORY_MAX_NOTES = 20;

/**
 * Long-term memory as this trip sees it.
 *
 * Two layers, and the trip is the one that wins. A traveller's profile is the
 * baseline that holds everywhere — relaxed pacing, ramen, jazz. A trip may
 * disagree with it: the same person wants Beijing packed and Shanghai
 * unhurried, and saying so about Beijing must not change what Shanghai
 * inherits. `trip_constraint_facts` already scopes an override to one trip by
 * construction; what was missing is that the conversation never read them, so
 * an adjustment a traveller made for a trip was invisible in that trip's chat.
 *
 * Overriding rather than merging: a field carries one value here. Sending both
 * would put "relaxed" and "packed" in front of the model at once and leave it
 * to guess, which is not a thing to leave to a guess.
 *
 * `tripId` is optional because the same builder serves chat that is not bound
 * to a trip, where there is nothing to override with.
 */
export async function buildConversationMemoryContext(
  ownerUserId: string,
  tripId?: string | null,
): Promise<ConversationMemoryFact[]> {
  const facts = await listActiveFacts(ownerUserId);

  const eligible = facts
    .map((fact) => ({ fact, definition: memoryFieldDefinition(fact.fieldKey) }))
    // Rows can outlive their catalogue entry; never hand the model a field
    // the catalogue no longer vouches for.
    .filter((row) => row.definition !== null)
    .filter((row) => row.definition!.sensitivity === "STANDARD")
    .map(({ fact }) => ({
      field: fact.fieldKey,
      value: fact.value,
      category: fact.category,
      source: fact.source,
    }));

  // The trip's own values replace the profile's for the fields it sets.
  const overrides = tripId ? await loadTripOverrides(ownerUserId, tripId) : new Map<string, unknown>();
  const merged = eligible.map((fact) => (
    overrides.has(fact.field)
      ? { ...fact, value: overrides.get(fact.field), source: "TRIP_OVERRIDE" as const }
      : fact
  ));
  // A trip may also set a field the profile never did.
  for (const [field, value] of overrides) {
    if (merged.some((fact) => fact.field === field)) continue;
    const definition = memoryFieldDefinition(field);
    if (!definition || definition.sensitivity !== "STANDARD") continue;
    merged.push({ field, value, category: definition.category, source: "TRIP_OVERRIDE" });
  }

  // Stable order so an unchanged memory produces an unchanged prompt.
  merged.sort((a, b) => a.field.localeCompare(b.field));
  const items = merged.slice(0, CONVERSATION_MEMORY_MAX_FACTS);

  // Free text rides after the typed fields, newest first, until the budget
  // runs out. A `field` of `note` keeps the shape one thing for the prompt
  // rule; the source says where it came from.
  const notes: ConversationMemoryFact[] = [];
  let spent = 0;
  for (const memory of await listFreeTextMemories(ownerUserId)) {
    if (notes.length >= CONVERSATION_MEMORY_MAX_NOTES) break;
    if (spent + memory.content.length > CONVERSATION_FREE_TEXT_BUDGET_CHARS) continue;
    spent += memory.content.length;
    notes.push({ field: "note", value: memory.content, category: "PREFERENCE", source: "HIGHLIGHT" });
  }

  const all = [...items, ...notes];
  metrics.inc("conversation_memory_context_total", {
    result: all.length === 0 ? "empty" : "success",
  });
  metrics.inc("conversation_memory_context_facts", undefined, all.length);

  return all;
}

/**
 * The trip's overrides as field → value.
 *
 * A membership that has lapsed since the turn was queued makes this empty
 * rather than failing the turn: the traveller still gets their profile, which
 * is what they would have had before ever opening the trip.
 */
async function loadTripOverrides(ownerUserId: string, tripId: string): Promise<Map<string, unknown>> {
  try {
    const overrides = await listOverridesForOwner(tripId, ownerUserId);
    return new Map(overrides.map((override) => [override.fieldKey, override.value]));
  } catch {
    return new Map();
  }
}
