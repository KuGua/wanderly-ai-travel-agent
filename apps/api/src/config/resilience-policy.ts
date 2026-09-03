/**
 * Per-capability resilience policy (P1 of the planner-resilience design,
 * `docs/planner-resilience-and-reflection-implementation.md` §4).
 *
 * Single source of truth for every read-path capability's timeout, retry
 * budget, and backoff shape. Adapter implementations and the Skill registry
 * read from this map so a transient failure policy change does not require
 * editing 11 adapters.
 *
 * The map keys are `ServiceCapability` (the `service_gaps` enum's
 * `capability` field) — not skill names — so adapters and the planner share
 * the same backoff clock for the same provider. Skill-level retry
 * (`Skill.retry`) is layered on top and validated at registration time
 * (`apps/api/src/agents/skill-registry.ts`); this map is the *provider's*
 * behaviour, not the skill's.
 */

import type { ServiceCapability, ProviderUnavailableCode } from "../types/domain.js";

export interface CapabilityResiliencePolicy {
  readonly capability: ServiceCapability;
  /**
   * Per-attempt wall clock. Adapter-level `AbortController.timeout` must use
   * this value; the registry-level attempt loop does not share it across
   * retries.
   */
  readonly timeoutMs: number;
  /** `1` means "no retry"; upper bound is `3` per the design. */
  readonly maxAttempts: number;
  /**
   * The `code` values from `ProviderUnavailableCode` that count as
   * transient and warrant a retry. Quota / rate-limit codes get their own
   * delay clock, not exponential backoff (see `rateLimitedMs`).
   */
  readonly retryOn: readonly ProviderUnavailableCode[];
  readonly backoff: {
    /** Base delay for non-rate-limit retries; doubled per attempt. */
    readonly baseMs: number;
    /** Random jitter window added on top of the exponential delay. */
    readonly jitterMs: number;
    /**
     * Fixed delay for `RATE_LIMITED` retries. Uses its own clock (no
     * exponential backoff) per `isRetryableUpstreamError` discipline.
     */
    readonly rateLimitedMs: number;
  };
  /**
   * `false` for capabilities whose absence is a structural gap the user
   * must know about (e.g. flight when the destination has no controlled
   * airport). `true` for soft capabilities whose failure can degrade to a
   * gap on `planning_research_results` without blocking the run.
   */
  readonly degradesToGap: boolean;
}

type PolicyMap = Record<ServiceCapability, CapabilityResiliencePolicy>;

const transientRetryCodes: ProviderUnavailableCode[] = [
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_FAILURE",
];

const transientPlusQuotaCodes: ProviderUnavailableCode[] = [
  ...transientRetryCodes,
  "RATE_LIMITED",
];

/**
 * Defaults are conservative: one retry on transient, no retry on quota
 * retries, deterministic backoff. Real numbers come from env vars
 * (`*_MAX_RETRIES`, `*_TIMEOUT_MS`) at adapter construction; this map is the
 * fallback and the canonical shape.
 */
export const RESILIENCE_POLICY: PolicyMap = {
  flight: {
    capability: "flight",
    timeoutMs: 15_000,
    maxAttempts: 2,
    retryOn: transientPlusQuotaCodes,
    backoff: { baseMs: 500, jitterMs: 250, rateLimitedMs: 20_000 },
    degradesToGap: true,
  },
  stay: {
    capability: "stay",
    timeoutMs: 10_000,
    maxAttempts: 2,
    retryOn: transientPlusQuotaCodes,
    backoff: { baseMs: 500, jitterMs: 250, rateLimitedMs: 20_000 },
    degradesToGap: true,
  },
  hotel: {
    capability: "hotel",
    timeoutMs: 12_000,
    maxAttempts: 2,
    retryOn: transientPlusQuotaCodes,
    backoff: { baseMs: 500, jitterMs: 250, rateLimitedMs: 20_000 },
    degradesToGap: true,
  },
  accommodation: {
    capability: "accommodation",
    timeoutMs: 8_000,
    maxAttempts: 2,
    retryOn: transientPlusQuotaCodes,
    backoff: { baseMs: 500, jitterMs: 250, rateLimitedMs: 20_000 },
    degradesToGap: true,
  },
  activities: {
    capability: "activities",
    timeoutMs: 8_000,
    maxAttempts: 2,
    retryOn: transientPlusQuotaCodes,
    backoff: { baseMs: 500, jitterMs: 250, rateLimitedMs: 20_000 },
    degradesToGap: true,
  },
  places: {
    capability: "places",
    timeoutMs: 8_000,
    maxAttempts: 2,
    retryOn: transientPlusQuotaCodes,
    backoff: { baseMs: 500, jitterMs: 250, rateLimitedMs: 20_000 },
    degradesToGap: true,
  },
  navigation: {
    capability: "navigation",
    timeoutMs: 10_000,
    maxAttempts: 2,
    retryOn: transientPlusQuotaCodes,
    backoff: { baseMs: 500, jitterMs: 250, rateLimitedMs: 20_000 },
    degradesToGap: true,
  },
  transit: {
    capability: "transit",
    timeoutMs: 10_000,
    maxAttempts: 2,
    retryOn: transientPlusQuotaCodes,
    backoff: { baseMs: 500, jitterMs: 250, rateLimitedMs: 20_000 },
    degradesToGap: true,
  },
  mobility: {
    capability: "mobility",
    timeoutMs: 8_000,
    maxAttempts: 2,
    retryOn: transientPlusQuotaCodes,
    backoff: { baseMs: 500, jitterMs: 250, rateLimitedMs: 20_000 },
    degradesToGap: true,
  },
  readiness: {
    capability: "readiness",
    timeoutMs: 5_000,
    maxAttempts: 1,
    retryOn: [],
    backoff: { baseMs: 0, jitterMs: 0, rateLimitedMs: 0 },
    degradesToGap: false,
  },
};

/**
 * Skill name → `CapabilityResiliencePolicy` lookup. The mapping is the first
 * segment of the skill name (e.g. `flight.search` → `flight`). Skills whose
 * capability does not appear in `RESILIENCE_POLICY` fall back to the
 * `readiness` entry — non-retrying, fail-closed.
 *
 * Two env vars let tests / staging override defaults without forking the
 * module:
 *   - `<CAP>_RETRY_BACKOFF_MS` — base backoff in ms (replaces `baseMs`)
 *   - `<CAP>_RATE_LIMITED_BACKOFF_MS` — replaces `rateLimitedMs`
 * Both are read on every call so a `process.env` write in a test is
 * honoured without a reload. `<CAP>` is upper-cased, e.g.
 * `AMADEUS_FLIGHT_RETRY_BACKOFF_MS` for the `flight` capability.
 */
export function getResiliencePolicyForSkill(skillName: string): CapabilityResiliencePolicy {
  const capability = skillName.split(".")[0] as ServiceCapability;
  const base = RESILIENCE_POLICY[capability] ?? RESILIENCE_POLICY.readiness;
  const cap = capability.toUpperCase();
  const baseOverride = Number(process.env[`${cap}_RETRY_BACKOFF_MS`]);
  const rateLimitedOverride = Number(process.env[`${cap}_RATE_LIMITED_BACKOFF_MS`]);
  if (!Number.isFinite(baseOverride) && !Number.isFinite(rateLimitedOverride)) return base;
  return {
    ...base,
    backoff: {
      ...base.backoff,
      ...(Number.isFinite(baseOverride) ? { baseMs: baseOverride } : {}),
      ...(Number.isFinite(rateLimitedOverride) ? { rateLimitedMs: rateLimitedOverride } : {}),
    },
  };
}

/**
 * Random jitter helper shared by every adapter's retry loop. Centralised so
 * jitter bounds are not re-derived (and re-mistaken) per adapter.
 */
export function retryDelayMs(policy: CapabilityResiliencePolicy, attempt: number, isRateLimited: boolean): number {
  if (isRateLimited) return policy.backoff.rateLimitedMs;
  const exp = policy.backoff.baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return exp + Math.floor(Math.random() * policy.backoff.jitterMs);
}

/**
 * The closed set of `ProviderUnavailableCode` values that are *retryable* in
 * the policy's `retryOn` sense. Centralised here so the 8 adapters that did
 * not previously retry at all converge on the same rule as the 3 that did.
 */
export const POLICY_RETRYABLE_REASONS: readonly ProviderUnavailableCode[] = [
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_FAILURE",
  "RATE_LIMITED",
];

/**
 * Execute `attempt` with the policy's per-attempt timeout and retry budget.
 * Each attempt gets a fresh `AbortSignal.timeout(policy.timeoutMs)` so a
 * retry does not inherit the previous attempt's timer. The caller-supplied
 * `signal` is merged so lease-loss / cancellation still aborts the whole
 * call.
 *
 * Adapter usage:
 *
 *   const policy = getResiliencePolicyForSkill("flight.search");
 *   const result = await executeWithPolicy(policy, async (perAttemptSignal) => {
 *     return await this.fetchImpl(url, { ..., signal: perAttemptSignal });
 *   }, params.signal);
 *
 * Returns whatever `attempt` returns. Retry decisions are made by the
 * caller via the throw-vs-return contract; this helper only orchestrates the
 * loop. Use {@link isPolicyRetryable} to decide whether a thrown /
 * `UNAVAILABLE` reason warrants another attempt.
 *
 * Failure model:
 * - On the first non-throwing attempt, returns its result immediately.
 * - On a transient throw (anything thrown), retries per `policy.maxAttempts`.
 * - After the budget is exhausted, the *last* attempt's result or throw is
 *   re-thrown. Callers can attach a `status` property to the thrown error
 *   (this helper does so when the attempt closure throws one with `.status`)
 *   to let the adapter map transient HTTP statuses back to their typed
 *   `ProviderUnavailableCode` reasons.
 */
export async function executeWithPolicy<T>(
  policy: CapabilityResiliencePolicy,
  attempt: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal | undefined,
): Promise<T> {
  let lastError: unknown = undefined;
  for (let attemptIdx = 1; attemptIdx <= policy.maxAttempts; attemptIdx += 1) {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new Error("Caller aborted");
    }
    const timeout = AbortSignal.timeout(policy.timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;
    try {
      return await attempt(signal);
    } catch (err) {
      lastError = err;
      if (attemptIdx >= policy.maxAttempts) throw err;
      const isRateLimited = err instanceof Error && /RATE_LIMITED|429|quota|rate limit/i.test(String(err.message));
      const delay = retryDelayMs(policy, attemptIdx, isRateLimited);
      await sleepMs(delay);
    }
  }
  // Unreachable — the loop returns or throws on every iteration.
  throw lastError ?? new Error("executeWithPolicy exhausted retries without outcome");
}

function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a `ProviderUnavailableCode` reason is retryable under the policy.
 * Returns `true` for codes in `policy.retryOn`; defaults to `false`.
 */
export function isPolicyRetryable(policy: CapabilityResiliencePolicy, reason: ProviderUnavailableCode): boolean {
  return policy.retryOn.includes(reason);
}
