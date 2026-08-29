import { describe, expect, it } from "vitest";

import {
  MINIMUM_AGE_DAYS,
  MemoryActivationError,
  ageInDays,
  computeActivation,
  computeExactActivation,
  tailContribution,
} from "../src/memory/memory-activation.js";
import {
  MEMORY_ACTIVATION_POLICY_V1,
  MemoryPolicyConfigError,
  resolveMemoryActivationPolicy,
} from "../src/memory/memory-activation-policy.js";

const D = MEMORY_ACTIVATION_POLICY_V1.decay;   // 0.35
const K = MEMORY_ACTIVATION_POLICY_V1.recentDepth; // 10
const NOW = new Date("2026-01-01T00:00:00.000Z");
const MS_PER_DAY = 86_400_000;

/** A date exactly `days` before NOW. */
const daysAgo = (days: number) => new Date(NOW.getTime() - days * MS_PER_DAY);

function trace(observationCount: number, firstAgeDays: number, recentAges: number[]) {
  return {
    observationCount,
    firstObservedOn: daysAgo(firstAgeDays),
    recentObservedOn: recentAges.map(daysAgo),
  };
}

const opts = { decay: D, recentDepth: K, now: NOW };

describe("ageInDays", () => {
  it("floors elapsed time at one day so t^-d cannot diverge", () => {
    expect(ageInDays(NOW, NOW)).toBe(MINIMUM_AGE_DAYS);
  });

  it("normalizes a future date rather than producing a negative age", () => {
    // Clock skew between writer and reader must not flip the exponent's sign.
    expect(ageInDays(new Date(NOW.getTime() + 5 * MS_PER_DAY), NOW)).toBe(MINIMUM_AGE_DAYS);
  });

  it("rejects an invalid instant", () => {
    expect(() => ageInDays(new Date(Number.NaN), NOW)).toThrow(MemoryActivationError);
  });

  it("handles a very old date without losing precision", () => {
    expect(ageInDays(daysAgo(40_000), NOW)).toBeCloseTo(40_000, 6);
  });
});

describe("decay parameter validation", () => {
  it.each([0, 1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects d = %s", (decay) => {
    expect(() => computeActivation(trace(1, 1, [1]), { ...opts, decay: decay as number }))
      .toThrow(MemoryActivationError);
  });

  it("rejects a non-positive recentDepth", () => {
    expect(() => computeActivation(trace(1, 1, [1]), { ...opts, recentDepth: 0 }))
      .toThrow(MemoryActivationError);
  });

  it("rejects a recent window longer than recentDepth", () => {
    const ages = Array.from({ length: K + 1 }, (_, i) => i + 1);
    expect(() => computeActivation(trace(K + 1, K + 1, ages), opts))
      .toThrow(MemoryActivationError);
  });
});

describe("exact regime (n <= k)", () => {
  it("matches the exact equation for a single observation", () => {
    const result = computeActivation(trace(1, 1, [1]), opts);
    expect(result.approximated).toBe(false);
    expect(result.strength).toBeCloseTo(1, 12); // 1^-d = 1
    expect(result.activation).toBeCloseTo(0, 12);
  });

  it("is exact at n = k", () => {
    const ages = Array.from({ length: K }, (_, i) => i + 1);
    const hybrid = computeActivation(trace(K, K, ages), opts);
    const exact = computeExactActivation(ages.map(daysAgo), { decay: D, now: NOW });

    expect(hybrid.approximated).toBe(false);
    expect(hybrid.activation).toBeCloseTo(exact.activation, 12);
  });

  it("treats an empty trace as inert rather than ln(0)", () => {
    const result = computeActivation(trace(0, 1, []), opts);
    expect(result.strength).toBe(0);
    expect(result.activation).toBe(Number.NEGATIVE_INFINITY);
  });

  it("handles every observation landing on the same day", () => {
    const result = computeActivation(trace(5, 3, [3, 3, 3, 3, 3]), opts);
    expect(result.strength).toBeCloseTo(5 * Math.pow(3, -D), 12);
  });
});

describe("hybrid regime (n > k)", () => {
  it("switches on the approximation exactly one observation past k", () => {
    const ages = Array.from({ length: K }, (_, i) => i + 1);
    expect(computeActivation(trace(K + 1, 400, ages), opts).approximated).toBe(true);
  });

  it("never discards the tail", () => {
    const ages = Array.from({ length: K }, (_, i) => i + 1);
    const withTail = computeActivation(trace(100, 1000, ages), opts);
    const withoutTail = computeActivation(trace(K, 1000, ages), opts);

    // A habit observed 100 times must outscore the same recent window with
    // only 10 total observations behind it.
    expect(withTail.strength).toBeGreaterThan(withoutTail.strength);
  });

  it("reproduces the corrected worked example", () => {
    // One observation 728 days ago, then a burst at 1, 2, 3, 5 and 7 days ago.
    // n = 6, so k = 1 forces the five older ones into the tail.
    const burst = [1, 2, 3, 5, 7];
    const exact = computeExactActivation([...burst, 728].map(daysAgo), { decay: D, now: NOW });
    expect(exact.strength).toBeCloseTo(3.64, 2);

    const k1 = computeActivation(trace(6, 728, [1]), { ...opts, recentDepth: 1 });
    expect(k1.strength).toBeCloseTo(1.76, 2);
    // k = 1 loses roughly half the strength: it smears the recent burst across
    // two years, which is precisely the signal a habit change depends on.
    expect(k1.strength / exact.strength).toBeLessThan(0.55);

    const k5 = computeActivation(trace(6, 728, burst), { ...opts, recentDepth: 5 });
    expect(k5.strength / exact.strength).toBeGreaterThan(0.95);
    expect(k5.strength / exact.strength).toBeLessThan(1.05);
  });

  it("stays close to exact when observations are spread uniformly", () => {
    // 40 observations, one every 10 days.
    const all = Array.from({ length: 40 }, (_, i) => (i + 1) * 10);
    const recent = all.slice(0, K);
    const exact = computeExactActivation(all.map(daysAgo), { decay: D, now: NOW });
    const hybrid = computeActivation(trace(all.length, all[all.length - 1], recent), opts);

    expect(hybrid.strength / exact.strength).toBeGreaterThan(0.9);
    expect(hybrid.strength / exact.strength).toBeLessThan(1.1);
  });

  it("under-estimates when the tail is itself front-loaded, and a larger k removes it", () => {
    // 15 observations in the last fortnight plus one two-and-a-half years back.
    // Five of the six tail observations are only 11-15 days old, but the tail
    // integral spreads them uniformly across [10, 900] — so they are valued far
    // below their true weight. This is the approximation's known cost, and the
    // reason k must be wide enough to cover a typical burst.
    const all = [...Array.from({ length: 15 }, (_, i) => i + 1), 900];
    const exact = computeExactActivation(all.map(daysAgo), { decay: D, now: NOW });

    const atK10 = computeActivation(trace(all.length, 900, all.slice(0, K)), opts);
    const ratioAtK10 = atK10.strength / exact.strength;
    expect(ratioAtK10).toBeLessThan(1);
    expect(ratioAtK10).toBeGreaterThan(0.8); // regression guard, not a target

    // Widening k to cover the whole burst recovers the exact value.
    const atK15 = computeActivation(
      trace(all.length, 900, all.slice(0, 15)),
      { ...opts, recentDepth: 15 },
    );
    expect(atK15.strength / exact.strength).toBeGreaterThan(0.99);
  });

  it("captures a burst up to the policy depth exactly, which is why k is 10", () => {
    // The production rationale, made testable: any burst of at most k
    // observations is summed exactly, so the smearing seen above cannot touch
    // a habit that formed within a single window of k episodes.
    const burst = Array.from({ length: K }, (_, i) => i + 1);
    const all = [...burst, 900];
    const exact = computeExactActivation(all.map(daysAgo), { decay: D, now: NOW });
    const hybrid = computeActivation(trace(all.length, 900, burst), opts);

    // Only the lone two-year-old observation is approximated, and its weight
    // is negligible against a fresh burst.
    expect(hybrid.strength / exact.strength).toBeGreaterThan(0.99);
    expect(hybrid.strength / exact.strength).toBeLessThan(1.01);
  });

  it("stays finite when observations cluster in the distant past", () => {
    const all = [...Array.from({ length: 20 }, (_, i) => 900 + i), 2];
    const recent = [2, ...all.slice(0, K - 1)];
    const hybrid = computeActivation(trace(all.length, 919, recent), opts);

    expect(Number.isFinite(hybrid.strength)).toBe(true);
    expect(hybrid.strength).toBeGreaterThan(0);
  });
});

describe("tailContribution", () => {
  it("uses the co-aged limit instead of dividing by zero", () => {
    // Window width 0 would otherwise be 0/0.
    expect(tailContribution(4, 50, 50, D)).toBeCloseTo(4 * Math.pow(50, -D), 12);
  });

  it("is zero when there is nothing left to approximate", () => {
    expect(tailContribution(0, 10, 100, D)).toBe(0);
  });

  it("agrees with the co-aged limit as the window narrows", () => {
    const narrow = tailContribution(4, 50, 50.000001, D);
    expect(narrow).toBeCloseTo(4 * Math.pow(50, -D), 6);
  });

  it("tolerates an unordered window rather than returning a negative", () => {
    expect(tailContribution(3, 100, 10, D)).toBeGreaterThan(0);
  });
});

describe("monotonicity", () => {
  it("increases when a new observation arrives", () => {
    const before = computeActivation(trace(4, 40, [40, 30, 20, 10]), opts);
    const after = computeActivation(trace(5, 40, [40, 30, 20, 10, 1]), opts);
    expect(after.activation).toBeGreaterThan(before.activation);
  });

  it("decreases as the same trace ages with no new evidence", () => {
    const base = trace(5, 60, [60, 40, 30, 20, 10]);
    const readings = [0, 30, 90, 365, 1000].map((offset) =>
      computeActivation(base, { ...opts, now: new Date(NOW.getTime() + offset * MS_PER_DAY) }).activation,
    );

    for (let i = 1; i < readings.length; i += 1) {
      expect(readings[i]).toBeLessThan(readings[i - 1]);
    }
  });

  it("decreases monotonically as d increases across the permitted range", () => {
    // The property Fisher et al. found the standard approximation violates.
    const sample = trace(60, 900, Array.from({ length: K }, (_, i) => (i + 1) * 3));
    const decays = [0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const readings = decays.map((decay) => computeActivation(sample, { ...opts, decay }).activation);

    for (let i = 1; i < readings.length; i += 1) {
      expect(readings[i]).toBeLessThan(readings[i - 1]);
    }
  });

  it("never yields NaN or Infinity for a populated trace", () => {
    const cases = [
      trace(1, 1, [1]),
      trace(3, 3, [1, 2, 3]),
      trace(500, 5000, Array.from({ length: K }, (_, i) => i + 1)),
      trace(11, 1, Array.from({ length: K }, () => 1)),
    ];
    for (const sample of cases) {
      const result = computeActivation(sample, opts);
      expect(Number.isFinite(result.activation)).toBe(true);
      expect(Number.isFinite(result.strength)).toBe(true);
    }
  });
});

describe("policy resolution", () => {
  it("carries a scoring version so historical decisions stay explainable", () => {
    expect(MEMORY_ACTIVATION_POLICY_V1.scoringVersion).toBe("petrov-hybrid-v1");
  });

  it("defaults to the versioned constants when nothing is configured", () => {
    expect(resolveMemoryActivationPolicy({})).toEqual(MEMORY_ACTIVATION_POLICY_V1);
  });

  it("allows decay and threshold to be overridden server-side", () => {
    const policy = resolveMemoryActivationPolicy({
      MEMORY_ACTIVATION_DECAY: "0.5",
      MEMORY_ACTIVATION_THRESHOLD: "0.8",
    });
    expect(policy.decay).toBe(0.5);
    expect(policy.activationThreshold).toBe(0.8);
  });

  it("leaves the remaining rules as versioned constants", () => {
    const policy = resolveMemoryActivationPolicy({ MEMORY_ACTIVATION_DECAY: "0.5" });
    expect(policy.recentDepth).toBe(MEMORY_ACTIVATION_POLICY_V1.recentDepth);
    expect(policy.candidateMargin).toBe(MEMORY_ACTIVATION_POLICY_V1.candidateMargin);
    expect(policy.minimumDistinctTrips).toBe(MEMORY_ACTIVATION_POLICY_V1.minimumDistinctTrips);
  });

  it.each(["0", "1", "-0.2", "1.4"])("refuses an out-of-range decay (%s)", (value) => {
    // Failing loudly at startup beats quietly changing what we remember.
    expect(() => resolveMemoryActivationPolicy({ MEMORY_ACTIVATION_DECAY: value }))
      .toThrow(MemoryPolicyConfigError);
  });

  it("refuses a non-numeric override", () => {
    expect(() => resolveMemoryActivationPolicy({ MEMORY_ACTIVATION_DECAY: "slow" }))
      .toThrow(MemoryPolicyConfigError);
  });
});
