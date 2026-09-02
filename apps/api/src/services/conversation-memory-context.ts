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
 */
import { memoryFieldDefinition } from "../memory/memory-field-catalog.js";
import { metrics } from "../observability/metrics.js";
import { listFreeTextMemories } from "./free-text-memory-service.js";
import { listActiveFacts } from "./preference-fact-service.js";

export type ConversationMemoryFact = {
  field: string;
  value: unknown;
  category: "PREFERENCE" | "CONSTRAINT";
  source: "PROFILE_FORM" | "PROPOSAL_CONFIRMATION" | "HIGHLIGHT";
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

export async function buildConversationMemoryContext(
  ownerUserId: string,
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

  // Stable order so an unchanged memory produces an unchanged prompt.
  eligible.sort((a, b) => a.field.localeCompare(b.field));
  const items = eligible.slice(0, CONVERSATION_MEMORY_MAX_FACTS);

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
