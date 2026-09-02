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
import { modelGateway } from "../providers/gateway-factory.js";
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
  if (highlight.length === 0) return { outcome: "EMPTY" };
  // Checked before the model call: refusing a 600-character highlight should
  // not cost a round trip, and the answer is the same either way.
  if (highlight.length > FREE_TEXT_MEMORY_MAX_CHARS) {
    return { outcome: "TOO_LONG", length: highlight.length, limit: FREE_TEXT_MEMORY_MAX_CHARS };
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
      return { outcome: "REMEMBERED_FIELD", fieldKey: extracted.fieldKey, value: extracted.value };
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
    case "SAVED": return { outcome: "REMEMBERED_NOTE", memoryId: saved.memory.id, remaining: saved.remaining };
    case "TOO_LONG": return { outcome: "TOO_LONG", length: saved.length, limit: saved.limit };
    case "LIST_FULL": return { outcome: "LIST_FULL", limit: saved.limit };
    case "EMPTY": return { outcome: "EMPTY" };
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
