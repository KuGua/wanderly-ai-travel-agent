/**
 * A highlight becomes a memory: as a catalogue field when it says something
 * the schema models, and as the traveller's own words when it does not.
 *
 * The typed path is the one worth reaching. It produces a fact other parts of
 * the product can reason about, export under consent, and supersede cleanly.
 * The free-text path exists so that "我在京都只想住町屋" is kept at all rather
 * than refused for not fitting nine fields — but it is recall only: never
 * exported, never a plan input.
 *
 * Extraction returning nothing is a normal outcome, not an error. Forcing a
 * field onto a sentence that did not mean it would put a wrong preference into
 * the traveller's profile, which is worse than keeping the sentence verbatim.
 */
import { MEMORY_FIELD_CATALOG, memoryFieldDefinition } from "../memory/memory-field-catalog.js";
import { metrics } from "../observability/metrics.js";
import { modelGateway } from "../providers/gateway-factory.js";
import { sensitiveHighlightCategory, type SensitiveHighlightCategory } from "../memory/sensitive-highlight.js";
import type { RequestContext } from "../utils/context.js";
import {
  FREE_TEXT_MEMORY_MAX_CHARS,
  saveFreeTextMemory,
  type SaveFreeTextOutcome,
} from "./free-text-memory-service.js";
import { replaceFact } from "./preference-fact-service.js";

export type HighlightOutcome =
  | { outcome: "REMEMBERED_FIELD"; fieldKey: string; value: unknown }
  | { outcome: "REMEMBERED_NOTE"; memoryId: string; remaining: number }
  | { outcome: "TOO_LONG"; length: number; limit: number }
  | { outcome: "LIST_FULL"; limit: number }
  /** Carries a field the profile form owns; refused rather than kept as a note. */
  | { outcome: "SENSITIVE_FIELD"; fieldKey: SensitiveHighlightCategory }
  | { outcome: "EMPTY" };

/** Only fields the profile form does not own, so a highlight cannot set nationality. */
function offerableCatalogue(): Array<{ fieldKey: string; description: string }> {
  return Object.values(MEMORY_FIELD_CATALOG)
    .filter((definition) => definition.sensitivity === "STANDARD")
    .map((definition) => ({
      fieldKey: definition.key,
      description: `${definition.category}；允许的值：${describeSchema(definition.key)}`,
    }));
}

function describeSchema(fieldKey: string): string {
  const definition = memoryFieldDefinition(fieldKey);
  if (!definition) return "未知";
  // The Zod schema is the authority; this is only a hint for the model, and a
  // wrong hint costs a rejected extraction rather than a bad write.
  const shape = definition.schema._def as { typeName?: string; values?: unknown };
  if (Array.isArray(shape.values)) return (shape.values as string[]).join(" / ");
  return String(shape.typeName ?? "见字段定义").replace(/^Zod/, "").toLowerCase();
}

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
  const label = outcome.outcome === "REMEMBERED_FIELD" ? "field"
    : outcome.outcome === "REMEMBERED_NOTE" ? "note"
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

  const extracted = await tryExtract(highlight, params.ctx, params.signal);
  if (extracted) {
    try {
      await replaceFact({
        ctx: params.ctx,
        userId: params.userId,
        profileId: params.profileId,
        fieldKey: extracted.fieldKey,
        value: extracted.value,
        path: "PROPOSAL_CONFIRMATION",
        confirmedAt: new Date(),
      });
      return recordOutcome({ outcome: "REMEMBERED_FIELD", fieldKey: extracted.fieldKey, value: extracted.value });
    } catch {
      // The catalogue rejected the value the model produced. Falling through
      // keeps the highlight rather than losing it to a failed guess.
    }
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

async function tryExtract(
  highlight: string,
  ctx: RequestContext,
  signal?: AbortSignal,
): Promise<{ fieldKey: string; value: unknown } | null> {
  try {
    const gateway = modelGateway();
    if (!gateway.extractHighlightMemory) return null;
    return await gateway.extractHighlightMemory({
      highlight,
      catalogue: offerableCatalogue(),
      signal,
      ctx,
    });
  } catch {
    // A model that is down must not cost the traveller their highlight.
    return null;
  }
}
