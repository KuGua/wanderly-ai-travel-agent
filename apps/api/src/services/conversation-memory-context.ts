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
import { listActiveFacts } from "./preference-fact-service.js";

export type ConversationMemoryFact = {
  field: string;
  value: unknown;
  category: "PREFERENCE" | "CONSTRAINT";
  source: "PROFILE_FORM" | "PROPOSAL_CONFIRMATION";
};

/**
 * The catalogue is small and bounded, so this ceiling is a guard against a
 * future catalogue growing without anyone revisiting the prompt budget —
 * not an expected truncation point.
 */
export const CONVERSATION_MEMORY_MAX_FACTS = 16;

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

  metrics.inc("conversation_memory_context_total", {
    result: items.length === 0 ? "empty" : "success",
  });
  metrics.inc("conversation_memory_context_facts", undefined, items.length);

  return items;
}
