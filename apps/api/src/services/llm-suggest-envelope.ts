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

/**
 * Carries the **postprocessed** value, never the model's raw output. The two
 * are deliberately separate type parameters: a postprocess that canonicalises
 * (re-resolving a place name against the reference dataset, say) must be able
 * to hand its result back, and the envelope must not be able to return the
 * raw text by accident. An earlier single-parameter shape could only answer
 * "accepted / rejected", so the caller re-used the raw output and persisted
 * uncanonicalised model text.
 */
export type LlmSuggestResult<TClean> =
  | { ok: true; output: TClean }
  | { ok: false; reason: "REJECTED" }
  | { ok: false; reason: "UNAVAILABLE" };

export type LlmSuggestEnvelopeOptions<TRaw, TClean> = {
  ctx: RequestContext;
  /** Bounded operation label — used in `logSafeRuntimeEvent.operation` only. */
  operation: string;
  /** Run the registered skill. The envelope assumes this throws `SkillError`. */
  invoke: () => Promise<TRaw>;
  /**
   * Fail-closed postprocess. `ok: false` becomes the `REJECTED` reason;
   * `ok: true` must carry the cleaned value the caller should persist.
   */
  postprocess: (raw: TRaw) => { ok: true; value: TClean } | { ok: false };
  /** Optional logger for callers that want to attach more context. */
  onUnavailable?: (errorCode: string) => void;
};

export async function runLlmSuggestEnvelope<TRaw, TClean>(
  opts: LlmSuggestEnvelopeOptions<TRaw, TClean>,
): Promise<LlmSuggestResult<TClean>> {
  try {
    const raw = await opts.invoke();
    const cleaned = opts.postprocess(raw);
    // The postprocessed value is what leaves this function. `raw` stays
    // local so it cannot reach a database write.
    if (cleaned.ok) return { ok: true, output: cleaned.value };
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
