/**
 * Resolves the upper-bound `chat_messages.message_sequence` of the assistant
 * message that streamed a given Personal Research result to the owner.
 *
 * The Offer Cue resolver (`offer-cue-service.ts`) compares this against the
 * incoming user message's sequence to decide which candidates the user has
 * actually seen and is therefore allowed to be considered for selection.
 * Per docs/flight-offer-cue-model-draft.md §5 line 101 and §hotel §5 line 103,
 * the source is the persisted `chat_messages.message_sequence`, never
 * `message.delta.sequence` (SSE stream values can be lost on reconnect).
 *
 * Returns null when the assistant message has not yet been persisted — the
 * caller (`personal-research-service.ts`) treats null as "skip candidate
 * upsert; the next call will retry once the assistant message lands".
 */

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../db/database.js";
import { agentTaskRuns, chatMessages } from "../db/schema.js";

export async function getVisibleBeforeMessageSequence(params: {
  runId: string;
  tripId: string;
}): Promise<number | null> {
  const rows = await db
    .select({
      sequence: chatMessages.messageSequence,
    })
    .from(chatMessages)
    .innerJoin(agentTaskRuns, eq(agentTaskRuns.userMessageId, chatMessages.id))
    .where(and(
      eq(agentTaskRuns.id, params.runId),
      eq(agentTaskRuns.tripId, params.tripId),
      eq(chatMessages.role, "ASSISTANT"),
    ))
    .orderBy(desc(chatMessages.messageSequence))
    .limit(1);
  return rows[0]?.sequence ?? null;
}

/**
 * Resolves the user turn's `chat_messages.message_sequence` for an agent
 * task run. The Offer Cue resolver uses this to enforce the freshness rule
 * `candidate.visible_before_message_sequence < current_user_message_sequence`.
 */
export async function getUserMessageSequenceForRun(params: {
  runId: string;
  tripId: string;
}): Promise<number | null> {
  const rows = await db
    .select({
      sequence: chatMessages.messageSequence,
    })
    .from(chatMessages)
    .innerJoin(agentTaskRuns, eq(agentTaskRuns.userMessageId, chatMessages.id))
    .where(and(
      eq(agentTaskRuns.id, params.runId),
      eq(agentTaskRuns.tripId, params.tripId),
      eq(chatMessages.role, "USER"),
    ))
    .orderBy(desc(chatMessages.messageSequence))
    .limit(1);
  return rows[0]?.sequence ?? null;
}

/**
 * Resolves the `chat_messages.id` of the assistant message that streamed a
 * given run's results. Recorded on `offer_cue_batches.source_message_id` so
 * later replays and audit reads can join back to the message the user saw.
 */
export async function getAssistantMessageIdForRun(params: {
  runId: string;
  tripId: string;
}): Promise<string | null> {
  const rows = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .innerJoin(agentTaskRuns, eq(agentTaskRuns.userMessageId, chatMessages.id))
    .where(and(
      eq(agentTaskRuns.id, params.runId),
      eq(agentTaskRuns.tripId, params.tripId),
      eq(chatMessages.role, "ASSISTANT"),
    ))
    .orderBy(desc(chatMessages.messageSequence))
    .limit(1);
  return rows[0]?.id ?? null;
}

// Avoid an unused-import warning when only the helpers are tree-shaken.
void sql;
