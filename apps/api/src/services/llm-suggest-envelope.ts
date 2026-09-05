import { logSafeRuntimeEvent } from "../observability/telemetry.js";
import type { RequestContext } from "../utils/context.js";
import { SkillError } from "../agents/errors.js";

/**
 * Shared envelope for owner-triggered LLM suggest endpoints
 * (docs/trip-title-destination-label-implementation.md §8.3,
 * docs/thread-title-lifecycle-implementation.md §14).
 *
 * Deliberately narrow. The two current callers (thread-title suggest,
 * trip destination-label suggest) agree on three concerns:
 *   1. invoke the registered skill with the supplied input
 *   2. run a fail-closed postprocess that may reject the model's output
 *   3. map skill errors to a bounded set of caller-defined reasons
 *
 * Pre-call gates (rate-limit, owner check, manual lock, no-material) and
 * post-call persist (FOR UPDATE re-read + write + audit + metric) remain in
 * each route because they are not the same shape across the two callers.
 * Folding them in here would either leak business rules or force a
 * callback signature brittle enough that the abstraction buys nothing.
 */

export type LlmSuggestReason = string;

export type LlmSuggestResult<TOutput> =
  | { ok: true; output: TOutput }
  | { ok: false; reason: "REJECTED" }
  | { ok: false; reason: "UNAVAILABLE" };

export type LlmSuggestEnvelopeOptions<TOutput> = {
  ctx: RequestContext;
  /** Bounded operation label — used in `logSafeRuntimeEvent.operation` only. */
  operation: string;
  /** Run the registered skill. The envelope assumes this throws `SkillError`. */
  invoke: () => Promise<TOutput>;
  /** Fail-closed postprocess. `ok: false` becomes the `REJECTED` reason. */
  postprocess: (output: TOutput) => { ok: true } | { ok: false };
  /** Optional logger for callers that want to attach more context. */
  onUnavailable?: (errorCode: string) => void;
};

export async function runLlmSuggestEnvelope<TOutput>(
  opts: LlmSuggestEnvelopeOptions<TOutput>,
): Promise<LlmSuggestResult<TOutput>> {
  try {
    const raw = await opts.invoke();
    const cleaned = opts.postprocess(raw);
    if (cleaned.ok) return { ok: true, output: raw };
    return { ok: false, reason: "REJECTED" };
  } catch (err) {
    const errorCode = err instanceof SkillError ? err.code : "UPSTREAM_FAILURE";
    logSafeRuntimeEvent(opts.ctx, {
      component: "llm", event: "skill", operation: opts.operation,
      outcome: "failure", errorCode,
    });
    opts.onUnavailable?.(errorCode);
    return { ok: false, reason: "UNAVAILABLE" };
  }
}
