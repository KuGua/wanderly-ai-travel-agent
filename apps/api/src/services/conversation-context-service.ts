/**
 * Bounded same-thread LLM context for the Personal Agent.
 *
 * See docs/thread-context-memory-implementation.md §3.2 for the full
 * design. This module is pure: it only reads `chat_messages` for the
 * accepted task's `threadId`, never writes, never calls a model, and
 * never reads `redactedSummary` or `markedSharedByOwner` (those fields
 * belong to `thread.recall`, which remains a redacted owner-only Skill).
 *
 * The returned window contains only complete USER→ASSISTANT turns up
 * to `agentTaskConfig.conversationContextMaxTurns`, then trimmed by
 * `agentTaskConfig.conversationContextMaxChars` UTF-16 characters
 * removing oldest whole turns. The current USER question is never
 * duplicated into history — it is passed separately as `question`.
 *
 * Telemetry lives in `src/observability/metrics.ts`. This module records only
 * content-free outcome, aggregate-size, and bounded truncation metrics.
 */
import { and, desc, eq, lte } from "drizzle-orm";

import { db } from "../db/database.js";
import { chatMessages } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { metrics } from "../observability/metrics.js";
import {
  getTracer,
  recordSpanError,
  safeSetAttribute,
} from "../observability/tracing.js";
import { agentTaskConfig } from "../tasks/config.js";
import type { AgentTaskRow } from "../tasks/task-repository.js";

export type ThreadContextMessage = {
  role: "USER" | "ASSISTANT";
  content: string;
};

/**
 * Which budget first caused a drop. `null` means the budgets were met
 * exactly. Distinct from `truncated`: a builder that simply found no
 * eligible history has `truncated=false` and `truncatedReason=null`.
 */
export type ConversationTruncationReason = "turn_limit" | "char_limit";

export type ConversationContext = {
  messages: ThreadContextMessage[];
  /**
   * Server-pinned upper message-sequence boundary the builder used.
   * Mirrors `agent_task_runs.context_max_message_sequence` and resolves
   * to the current USER row's sequence when the column is NULL (legacy
   * rows, see §4.1).
   */
  maxMessageSequence: number;
  truncated: boolean;
  truncatedReason: ConversationTruncationReason | null;
};

type DbRow = {
  id: string;
  role: string;
  body: string;
};

export async function buildConversationContext(run: AgentTaskRow): Promise<ConversationContext> {
  const maxTurns = agentTaskConfig.conversationContextMaxTurns;
  const maxChars = agentTaskConfig.conversationContextMaxChars;

  const span = getTracer().startSpan("conversation.context.build", {
    attributes: { "app.operation": "conversation.context.build" },
  });

  try {
    const result = await buildContext(run, maxTurns, maxChars);
    const totalChars = result.messages.reduce((sum, m) => sum + m.content.length, 0);
    safeSetAttribute(span, "app.result", result.messages.length === 0 ? "empty" : "success");
    safeSetAttribute(span, "conversation.context.truncated", result.truncated);
    // Counters are content-free (counts, chars, bounded enums) per §8.
    metrics.inc("conversation_context_build_total", {
      result: result.messages.length === 0 ? "empty" : "success",
    });
    metrics.inc("conversation_context_messages", undefined, result.messages.length);
    metrics.inc("conversation_context_chars", undefined, totalChars);
    if (result.truncatedReason !== null) {
      metrics.inc("conversation_context_truncated_total", { reason: result.truncatedReason });
    }
    return result;
  } catch (err) {
    const result = contextBuildFailureResult(err);
    safeSetAttribute(span, "app.result", result);
    metrics.inc("conversation_context_build_total", { result });
    recordSpanError(err);
    throw err;
  } finally {
    span.end();
  }
}

async function buildContext(
  run: AgentTaskRow,
  maxTurns: number,
  maxChars: number,
): Promise<ConversationContext> {
  if (!run.threadId || !run.userMessageId) {
    throw new Error("Conversation task references are incomplete");
  }

  // Step 1: load the current USER message, scoped by (id, thread_id). If the
  // run row's userMessageId points at an ASSISTANT, a deleted row, or a row
  // in another thread, fail closed — never fabricate a question.
  const [userMessage] = await db.select({
    id: chatMessages.id,
    role: chatMessages.role,
    messageSequence: chatMessages.messageSequence,
  }).from(chatMessages).where(and(
    eq(chatMessages.id, run.userMessageId),
    eq(chatMessages.threadId, run.threadId),
  )).limit(1);

  if (!userMessage) throw new Error("Conversation USER message is unavailable");
  if (userMessage.role !== "USER") throw new Error("Conversation USER message role mismatch");
  if (typeof userMessage.messageSequence !== "number" || userMessage.messageSequence <= 0) {
    throw new Error("Conversation USER message has invalid sequence");
  }

  // Step 2: resolve the upper message-sequence boundary. Legacy rows
  // (pre-migration `0015_*`) have `contextMaxMessageSequence = NULL`;
  // fall back to the USER row's own sequence, which is exactly what the
  // column would have held at acceptance time. §4.1 forbids backfilling,
  // so this is the runtime fallback that keeps retry semantics identical
  // for old and new runs.
  const persistedBound = run.contextMaxMessageSequence;
  const bound = persistedBound ?? userMessage.messageSequence;
  if (typeof bound !== "number" || !Number.isInteger(bound) || bound <= 0) {
    throw new Error("Conversation context bound is not a positive integer");
  }

  // Step 3: read the window plus one additional complete turn, newest-first.
  // The extra pair lets us distinguish "exactly at the turn budget" from
  // "history was truncated by the turn budget" without reading the full
  // archive. The final +1 accounts for the current unanswered USER row.
  const rows = await db.select({
    id: chatMessages.id,
    role: chatMessages.role,
    body: chatMessages.body,
  }).from(chatMessages).where(and(
    eq(chatMessages.threadId, run.threadId),
    lte(chatMessages.messageSequence, bound),
  )).orderBy(desc(chatMessages.messageSequence))
    .limit(2 * (maxTurns + 1) + 1);

  // Step 4: collect eligible candidates in DESC order, drop the current
  // USER by id (never by content), and filter to USER/ASSISTANT only.
  const candidates: Array<{ role: "USER" | "ASSISTANT"; content: string }> = [];
  for (const row of rows as DbRow[]) {
    if (row.role !== "USER" && row.role !== "ASSISTANT") continue;
    if (row.id === run.userMessageId) continue;
    if (typeof row.body !== "string" || row.body.length === 0) continue;
    candidates.push({ role: row.role, content: row.body });
  }

  // Step 5: pair ASSISTANT-then-USER into complete turns (in DESC order
  // the ASSISTANT of a turn has a higher sequence than its USER, so it
  // appears first). Drop any unpaired orphan — incomplete edges cannot
  // form a complete turn.
  const turns: Array<Array<{ role: "USER" | "ASSISTANT"; content: string }>> = [];
  for (let i = 0; i + 1 < candidates.length; i += 1) {
    if (candidates[i].role === "ASSISTANT" && candidates[i + 1].role === "USER") {
      turns.push([candidates[i], candidates[i + 1]]);
    }
    // else: dangling row, never over-included.
  }

  // Step 6: enforce turn budget by dropping the OLDEST excess turns.
  // `turns` is in newest-first order, so the slice keeps newest maxTurns.
  let truncatedReason: ConversationTruncationReason | null = null;
  if (turns.length > maxTurns) {
    turns.length = maxTurns;
    truncatedReason = "turn_limit";
  }

  // Step 7: enforce char budget by dropping the OLDEST turns (per §3.2.4).
  // Each turn contributes its two messages' UTF-16 length. No body is
  // sliced — once a turn is dropped it is gone in full.
  const oldestFirst = [...turns].reverse();
  const turnChars = oldestFirst.map((turn) =>
    turn.reduce((sum, message) => sum + message.content.length, 0),
  );
  let dropFrom = 0;
  let tailSum = turnChars.reduce((sum, chars) => sum + chars, 0);
  while (tailSum > maxChars && dropFrom < oldestFirst.length) {
    tailSum -= turnChars[dropFrom];
    dropFrom += 1;
    truncatedReason = "char_limit";
  }
  const accepted = oldestFirst.slice(dropFrom);

  // Step 8: flatten accepted turns into ascending (USER, ASSISTANT)
  // messages. Each turn in DESC order is [ASSISTANT, USER]; flipping it
  // gives the natural chronological [USER, ASSISTANT] the model expects.
  const messages: ThreadContextMessage[] = accepted.flatMap((turn) => [turn[1], turn[0]]);

  return {
    messages,
    maxMessageSequence: bound,
    truncated: truncatedReason !== null,
    truncatedReason,
  };
}

function contextBuildFailureResult(error: unknown): "denied" | "error" {
  // The normal owner/membership check happens before this builder runs, but
  // retain a precise category if a future guarded read raises a real 403.
  // Missing rows, invalid task references, database failures, and all other
  // internal faults must not be mislabeled as authorization denials.
  return error instanceof ApiError && error.statusCode === 403 ? "denied" : "error";
}
