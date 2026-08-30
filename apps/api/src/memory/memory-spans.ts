import { SpanStatusCode } from "@opentelemetry/api";

import { getTracer, safeSetAttribute } from "../observability/tracing.js";

/**
 * Tracing for the memory module (docs/long-term-memory-implementation.md §7).
 *
 * Attributes are restricted to the operation, its outcome, the source and a few
 * booleans. Field keys, values, activation scores, observation dates and trip
 * ids are all excluded — a trace is retained and widely readable, so anything
 * put here leaks what the product remembers about a person, and the identifying
 * ones would be unbounded cardinality besides.
 *
 * That restriction is the reason these spans exist as a helper rather than as
 * ad-hoc `startSpan` calls: the set of attributes is decided in one place.
 */

export type MemorySpanName =
  | "memory.proposal.aggregate"
  | "memory.fact.mutate"
  | "memory.projection.build";

export type MemorySpanAttributes = {
  /** What was attempted, e.g. `observe`, `replace`, `delete`, `build`. */
  operation: string;
  /** Where it came from, e.g. `behavior_aggregation`, `profile_form`. */
  source?: string;
};

/** Bounded outcome the handler resolved to, recorded when the span closes. */
export type MemorySpanOutcome = {
  outcome: string;
  /** Whether a bounded window dropped older entries. */
  truncated?: boolean;
  /** Whether the operation invalidated dependent plans. */
  invalidated?: boolean;
};

/**
 * Runs `fn` inside a memory span.
 *
 * The callback reports its own bounded outcome, because these operations end in
 * ordinary non-error states — a duplicate episode, a value the catalog rejects —
 * that a plain success/failure span would flatten into "ok".
 */
export async function withMemorySpan<T>(
  name: MemorySpanName,
  attributes: MemorySpanAttributes,
  fn: () => Promise<{ result: T } & MemorySpanOutcome>,
): Promise<T> {
  const span = getTracer().startSpan(name);
  safeSetAttribute(span, "memory.operation", attributes.operation);
  if (attributes.source) safeSetAttribute(span, "memory.source", attributes.source);

  try {
    const { result, outcome, truncated, invalidated } = await fn();
    safeSetAttribute(span, "memory.outcome", outcome);
    if (truncated !== undefined) safeSetAttribute(span, "memory.truncated", truncated);
    if (invalidated !== undefined) safeSetAttribute(span, "memory.invalidated", invalidated);
    return result;
  } catch (error) {
    // Only the error class: a message can quote the value that failed to parse.
    safeSetAttribute(span, "memory.outcome", "error");
    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).name });
    throw error;
  } finally {
    span.end();
  }
}
