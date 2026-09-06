/**
 * Policy for model-initiated personal research tool calls.
 *
 * The conversation loop and the tool dispatcher both need these rules, and
 * they must not drift: the loop decides whether a call may be *attempted*,
 * the dispatcher decides whether it may *execute*. One table, two readers.
 */

import type { PersonalResearchOperationCapability } from "../config/personal-research-allowed-capabilities.js";

/**
 * Whether a capability may run on the model's own initiative.
 *
 * `AUTOMATIC` capabilities may run without a second per-call confirmation.
 * That includes hotel search in the current sandbox: it is read-only, bounded,
 * cached/deduplicated, and cannot book or pay. `CONFIRMED` capabilities retain
 * an explicit spend/authority boundary where the product still requires one.
 *
 * This is about who authorizes the spend, not about how much the data is
 * trusted: both kinds return the same normalized evidence.
 */
export type ToolInvocationMode = "AUTOMATIC" | "CONFIRMED";

export const TOOL_INVOCATION_MODE: Record<PersonalResearchOperationCapability, ToolInvocationMode> = Object.freeze({
  "places.search": "AUTOMATIC",
  "navigation.route": "AUTOMATIC",
  "accommodation.discovery": "AUTOMATIC",
  "activities.search": "CONFIRMED",
  // Flight joined hotel on 2026-09-06. It meets the same test — read-only,
  // bounded, deduplicated per turn and per run, unable to book or pay — and
  // the confirmation it used to require was unreachable in practice: the
  // confirm buttons only appear after a tool call the model never made, so
  // the sole way to authorise a flight search was to type 确认搜索机票, an
  // incantation nothing in the product mentions.
  "flight.search": "AUTOMATIC",
  "hotel.search": "AUTOMATIC",
  "mobility.search": "CONFIRMED",
});

export function requiresOwnerConfirmation(
  capability: PersonalResearchOperationCapability,
): boolean {
  return TOOL_INVOCATION_MODE[capability] === "CONFIRMED";
}

/**
 * Repeat-call guard for a single conversation turn.
 *
 * A model that cannot see it already ran a search will run it again — the
 * failure mode is not a wrong answer but a silently doubled bill, and for
 * `flight.search` that is 1% of the monthly allowance per repeat. Identical
 * arguments are the signal: the same tool with *different* arguments is a
 * legitimate refinement and stays allowed.
 *
 * Scoped to one turn deliberately. Across turns the user has spoken again,
 * and re-running a search against newer intent is not a duplicate.
 */
export class ToolCallDeduplicator {
  private readonly seen = new Set<string>();

  /**
   * Records a call and reports whether it is a repeat. Arguments are
   * canonicalized so key order cannot disguise an identical call.
   */
  claim(toolName: string, args: unknown): { duplicate: boolean } {
    const key = `${toolName}::${canonicalize(args)}`;
    if (this.seen.has(key)) return { duplicate: true };
    this.seen.add(key);
    return { duplicate: false };
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Stable stringify: object key order must not produce a different key. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}
