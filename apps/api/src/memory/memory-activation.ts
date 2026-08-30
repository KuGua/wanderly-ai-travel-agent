/**
 * ACT-R base-level activation with Petrov's hybrid approximation.
 *
 * ## Exact equation
 *
 *     B = ln( Σⱼ tⱼ^(-d) )
 *
 * `tⱼ` is the time since the j-th observation and `d` is the decay exponent.
 * Summing every occurrence is O(n) and needs the full history.
 *
 * ## Hybrid (Petrov 2006)
 *
 * The `k` most recent observations are summed exactly; the remaining `n - k`
 * are approximated by integrating a uniform density across the window between
 * the oldest retained observation and the first-ever one:
 *
 *     tail = (n - k) / ((1 - d)·(T_first - T_k)) · ( T_first^(1-d) - T_k^(1-d) )
 *
 * So we keep `n`, `T_first`, and the `k` most recent dates — a fixed-size
 * record, never a behavioural timeline.
 *
 * ## Why hybrid rather than the standard "optimized learning" form
 *
 * Optimized learning drops the exact terms entirely and assumes all `n`
 * occurrences are spread uniformly over the lifetime. Fisher, Houpt &
 * Gunzelmann (2018) found its activation is *non-monotonic in d*, which makes
 * `d` unidentifiable — fatal here, because we intend to tune `d`. They also
 * found the hybrid reaches comparable efficiency with materially better
 * accuracy. The tail term is not optional: for a long-running habit the
 * approximated tail routinely exceeds the exact recent terms, and dropping it
 * systematically under-credits well-established preferences.
 *
 * Sources:
 * - Petrov (2006), Computationally Efficient Approximation of the Base-Level
 *   Learning Equation in ACT-R.
 * - Fisher, Houpt & Gunzelmann (2018), A Comparison of Approximations for
 *   Base-Level Activation in ACT-R, Computational Brain & Behavior.
 */

export class MemoryActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryActivationError";
  }
}

/** Elapsed time floor. `t = 0` would make `t^-d` infinite. */
export const MINIMUM_AGE_DAYS = 1;

const MS_PER_DAY = 86_400_000;

export type ActivationTrace = {
  /** Total independent observations, including those outside the recent window. */
  observationCount: number;
  /** UTC date of the first observation. */
  firstObservedOn: Date;
  /**
   * The most recent observation dates, oldest-first, at most `recentDepth`
   * entries. Duplicates are allowed: two distinct episodes may share a day.
   */
  recentObservedOn: Date[];
};

/**
 * Whole days between `observedOn` and `now`, floored at 1.
 *
 * A future date means clock skew between the writer and the reader, not a real
 * observation ahead of us; it normalizes to the floor rather than producing a
 * negative age that would flip the sign of the exponent.
 */
export function ageInDays(observedOn: Date, now: Date): number {
  const elapsedMs = now.getTime() - observedOn.getTime();
  if (!Number.isFinite(elapsedMs)) {
    throw new MemoryActivationError("Observation date is not a valid instant");
  }
  return Math.max(MINIMUM_AGE_DAYS, elapsedMs / MS_PER_DAY);
}

function assertDecay(decay: number): void {
  if (!Number.isFinite(decay) || !(decay > 0 && decay < 1)) {
    throw new MemoryActivationError(`Decay must satisfy 0 < d < 1, received ${decay}`);
  }
}

/**
 * Integral of a uniform density of `count` observations spread across ages
 * `[youngest, oldest]`.
 *
 * When the window has zero width every observation sits at the same age, and
 * the quotient below is 0/0. The limit as the width goes to zero is
 * `count · age^(-d)` — the plain exact term — which is what this returns
 * instead of dividing by zero.
 */
export function tailContribution(
  count: number,
  youngestAgeDays: number,
  oldestAgeDays: number,
  decay: number,
): number {
  if (count <= 0) return 0;

  const width = oldestAgeDays - youngestAgeDays;
  if (!(width > 0)) {
    // Degenerate window (or unordered input): treat as co-aged observations.
    return count * Math.pow(youngestAgeDays, -decay);
  }

  const exponent = 1 - decay;
  const numerator = Math.pow(oldestAgeDays, exponent) - Math.pow(youngestAgeDays, exponent);
  return (count / (exponent * width)) * numerator;
}

export type ActivationResult = {
  /** Base-level activation `B = ln(S)`. Unbounded; may be negative. */
  activation: number;
  /** The summed strength `S`. Always > 0. */
  strength: number;
  /** Whether the tail approximation was used at all. */
  approximated: boolean;
};

/**
 * Computes base-level activation for a trace.
 *
 * Falls back to the exact equation whenever `n <= k`, so short histories carry
 * no approximation error at all.
 */
export function computeActivation(
  trace: ActivationTrace,
  options: { decay: number; recentDepth: number; now: Date },
): ActivationResult {
  const { decay, recentDepth, now } = options;
  assertDecay(decay);
  if (!Number.isInteger(recentDepth) || recentDepth < 1) {
    throw new MemoryActivationError(`recentDepth must be a positive integer, received ${recentDepth}`);
  }
  if (!Number.isInteger(trace.observationCount) || trace.observationCount < 0) {
    throw new MemoryActivationError(
      `observationCount must be a non-negative integer, received ${trace.observationCount}`,
    );
  }

  if (trace.observationCount === 0) {
    // No evidence at all. Strength 0 would make ln(0) = -Infinity, so the
    // caller gets an explicit "inert" reading instead.
    return { activation: Number.NEGATIVE_INFINITY, strength: 0, approximated: false };
  }

  const recentAges = trace.recentObservedOn
    .map((observedOn) => ageInDays(observedOn, now))
    .sort((a, b) => a - b); // youngest first

  if (recentAges.length > recentDepth) {
    throw new MemoryActivationError(
      `recentObservedOn holds ${recentAges.length} entries, exceeding recentDepth ${recentDepth}`,
    );
  }

  const exactCount = Math.min(recentAges.length, trace.observationCount);
  let strength = 0;
  for (let index = 0; index < exactCount; index += 1) {
    strength += Math.pow(recentAges[index], -decay);
  }

  const remaining = trace.observationCount - exactCount;
  let approximated = false;
  if (remaining > 0) {
    approximated = true;
    const firstAge = ageInDays(trace.firstObservedOn, now);
    // The tail spans from the oldest retained observation back to the first
    // one. With no retained observations the whole lifetime is the window.
    const boundaryAge = exactCount > 0 ? recentAges[exactCount - 1] : MINIMUM_AGE_DAYS;
    strength += tailContribution(remaining, boundaryAge, Math.max(firstAge, boundaryAge), decay);
  }

  if (!Number.isFinite(strength) || strength <= 0) {
    throw new MemoryActivationError(`Computed a non-finite strength (${strength})`);
  }

  return { activation: Math.log(strength), strength, approximated };
}

/**
 * Exact ACT-R activation over a full list of observation dates.
 *
 * Used by the golden tests to bound the hybrid's error; production paths do not
 * retain enough history to call this.
 */
export function computeExactActivation(
  observedOn: Date[],
  options: { decay: number; now: Date },
): ActivationResult {
  assertDecay(options.decay);
  if (observedOn.length === 0) {
    return { activation: Number.NEGATIVE_INFINITY, strength: 0, approximated: false };
  }
  const strength = observedOn.reduce(
    (total, date) => total + Math.pow(ageInDays(date, options.now), -options.decay),
    0,
  );
  return { activation: Math.log(strength), strength, approximated: false };
}
