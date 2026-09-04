/**
 * A Profile-form highlight becomes an owner-only Personal Note. It is never
 * automatically promoted to a structured fact: only an explicit Profile form
 * edit may create data that can later be consent-exported to a Team.
 */
import { metrics } from "../observability/metrics.js";
import { sensitiveHighlightCategory, type SensitiveHighlightCategory } from "../memory/sensitive-highlight.js";
import type { RequestContext } from "../utils/context.js";
import {
  FREE_TEXT_MEMORY_MAX_CHARS,
  saveFreeTextMemory,
  type SaveFreeTextOutcome,
} from "./free-text-memory-service.js";

export type HighlightOutcome =
  | { outcome: "REMEMBERED_NOTE"; memoryId: string; remaining: number }
  | { outcome: "TOO_LONG"; length: number; limit: number }
  | { outcome: "LIST_FULL"; limit: number }
  /** Carries a field the profile form owns; refused rather than kept as a note. */
  | { outcome: "SENSITIVE_FIELD"; fieldKey: SensitiveHighlightCategory }
  | { outcome: "EMPTY" };

/**
 * Which way a highlight went.
 *
 * Free-text notes are the fallback and are capped at twenty, so the ratio is
 * the thing to watch: travellers filling that cap regularly would say the nine
 * field catalogue is too narrow or extraction misses too often, and only this
 * distinguishes the two. Raising the cap without knowing which would answer
 * neither.
 */
function recordOutcome(outcome: HighlightOutcome): HighlightOutcome {
  const label = outcome.outcome === "REMEMBERED_NOTE" ? "note"
    : outcome.outcome === "TOO_LONG" ? "too_long"
    : outcome.outcome === "LIST_FULL" ? "list_full"
    : outcome.outcome === "SENSITIVE_FIELD" ? "sensitive_field"
    : "empty";
  metrics.inc("memory_highlight_outcomes_total", { outcome: label });
  return outcome;
}

export async function rememberHighlight(params: {
  ctx: RequestContext;
  userId: string;
  profileId: string;
  highlight: string;
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  signal?: AbortSignal;
}): Promise<HighlightOutcome> {
  const highlight = params.highlight.trim();
  if (highlight.length === 0) return recordOutcome({ outcome: "EMPTY" });
  // Checked before the model call: refusing a 600-character highlight should
  // not cost a round trip, and the answer is the same either way.
  if (highlight.length > FREE_TEXT_MEMORY_MAX_CHARS) {
    return recordOutcome({ outcome: "TOO_LONG", length: highlight.length, limit: FREE_TEXT_MEMORY_MAX_CHARS });
  }

  // Checked before the model call and before any storage. These three fields
  // are withheld from the conversation on purpose, and typed extraction cannot
  // reach them — which used to mean the sentence fell through to a free-text
  // note, and notes go into the prompt on every turn. Refusing and saying
  // where the field belongs keeps the traveller able to record it without
  // routing it through the model.
  const sensitive = sensitiveHighlightCategory(highlight);
  if (sensitive) {
    return recordOutcome({ outcome: "SENSITIVE_FIELD", fieldKey: sensitive });
  }

  const saved: SaveFreeTextOutcome = await saveFreeTextMemory({
    ctx: params.ctx,
    userId: params.userId,
    content: highlight,
    sourceThreadId: params.sourceThreadId ?? null,
    sourceMessageId: params.sourceMessageId ?? null,
  });
  switch (saved.outcome) {
    case "SAVED": return recordOutcome({ outcome: "REMEMBERED_NOTE", memoryId: saved.memory.id, remaining: saved.remaining });
    case "TOO_LONG": return recordOutcome({ outcome: "TOO_LONG", length: saved.length, limit: saved.limit });
    case "LIST_FULL": return recordOutcome({ outcome: "LIST_FULL", limit: saved.limit });
    case "EMPTY": return recordOutcome({ outcome: "EMPTY" });
  }
}
