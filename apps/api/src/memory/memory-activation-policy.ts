/**
 * Versioned scoring policy for behaviour-derived memory proposals.
 *
 * Every decision a proposal records carries its `scoringVersion`, so a later
 * change to `decay`, `recentDepth` or the thresholds can still be explained
 * against the rules that were in force when the proposal was raised.
 *
 * Scope: this policy governs *proposals only*. Preference facts are user-owned
 * state and never decay — see docs/long-term-memory-implementation.md §3.1.
 */

export type MemoryActivationPolicy = {
  readonly scoringVersion: string;
  /** ACT-R decay exponent `d`. Must satisfy 0 < d < 1. */
  readonly decay: number;
  /** Petrov hybrid `k`: how many recent observations are summed exactly. */
  readonly recentDepth: number;
  /** Base-level activation `B` a candidate must reach to be shown. */
  readonly activationThreshold: number;
  /** Lead the top candidate needs over the runner-up, in log-odds. */
  readonly candidateMargin: number;
  readonly minimumIndependentObservations: number;
  readonly minimumDistinctTrips: number;
  readonly minimumEvidenceSpanDays: number;
  readonly proposalExpiryDays: number;
  readonly dismissalCooldownDays: number;
};

/**
 * d = 0.35 is an initial product prior, not a fitted value.
 *
 * ACT-R's default d = 0.5 was fitted to high-frequency environments (word
 * exposure, message receipt). Anderson & Schooler's argument is that decay
 * should track how often things actually recur in the domain; travel planning
 * recurs on a scale of months to years, so a slower decay is the principled
 * starting point. It has NOT been validated against travel behaviour data —
 * treat it as a tunable prior until we have telemetry to fit it.
 */
export const MEMORY_ACTIVATION_POLICY_V1: MemoryActivationPolicy = Object.freeze({
  scoringVersion: "petrov-hybrid-v1",
  decay: 0.35,
  recentDepth: 10,
  activationThreshold: 0.50,
  // ln(2): the leader must be at least twice the runner-up in odds terms.
  candidateMargin: Math.log(2),
  // 3, and the gate is stricter than it looks. An episode id is
  // `tripId:fieldKey:ownerUserId:valueHash`, and three of those four parts are
  // already in the observation's idempotency key, so the only thing an episode
  // adds is the trip: one confirmation per trip per value, forever. Three
  // observations therefore means three separate trips, and `observationCount`,
  // `distinctEpisodeCount` and `distinctTripCount` move together.
  //
  // Three sits close to tau = 0.50, but closer than the arithmetic alone
  // suggests. Whole-day ages 1/15/30 give B = 0.526 and 1/30/30 give B = 0.475,
  // which is where "three is exactly right" came from — but no read ever sees
  // whole-day ages. `observed_on` stores a DATE (UTC midnight) and activation
  // compares it against *now*, so every observation is 0 to 1 day older than
  // its nominal age and B lands below the hand-computed figure. Measured on the
  // real read path those same ages give B = 0.526 only in the first instant of
  // the UTC day, and fall away as the day advances: 0.501 at 03:00, 0.493 at
  // 04:00, 0.386 by 23:00.
  //
  // So the gate is not merely stricter than the figure above — it is not a fixed
  // gate at all. A user sitting exactly on the minimum evidence gets a
  // suggestion if they ask before ~03:00 UTC and gets nothing if they ask after,
  // with no change in their evidence. To clear tau at any hour, the middle
  // observation has to be within about 4 days rather than 15.
  //
  // Whether to move tau, floor the ages to whole days, or accept it is a product
  // call (spec §3.6) and is deliberately left open here.
  //
  // `tests/memory-activation.test.ts` pins the real-read-path values so a future
  // change to tau, d, or the age arithmetic has to face them.
  //
  // A fourth observation would demand four distinct trips, which almost no
  // user reaches, and the suggestion would never surface at all.
  minimumIndependentObservations: 3,
  // Implied by the episode id above rather than binding on its own. Kept
  // explicit so a future episode id that repeats within a trip cannot silently
  // drop the cross-trip requirement.
  minimumDistinctTrips: 2,
  minimumEvidenceSpanDays: 30,
  proposalExpiryDays: 90,
  dismissalCooldownDays: 180,
});

export class MemoryPolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryPolicyConfigError";
  }
}

function readFiniteNumber(name: string, raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new MemoryPolicyConfigError(`${name} must be a finite number, received "${raw}"`);
  }
  return value;
}

/**
 * Applies server-side overrides.
 *
 * Only `decay` and `activationThreshold` are tunable at runtime — they are the
 * two knobs with a legitimate operational reason to change. Everything else is
 * a versioned constant, because changing it silently would make historical
 * proposal decisions unexplainable.
 *
 * Invalid values throw at startup rather than falling back to a default: a
 * mistyped decay would quietly change what the product remembers about people.
 */
export function resolveMemoryActivationPolicy(
  env: NodeJS.ProcessEnv = process.env,
  base: MemoryActivationPolicy = MEMORY_ACTIVATION_POLICY_V1,
): MemoryActivationPolicy {
  const decay = readFiniteNumber("MEMORY_ACTIVATION_DECAY", env.MEMORY_ACTIVATION_DECAY);
  const activationThreshold = readFiniteNumber(
    "MEMORY_ACTIVATION_THRESHOLD",
    env.MEMORY_ACTIVATION_THRESHOLD,
  );

  if (decay !== null && !(decay > 0 && decay < 1)) {
    throw new MemoryPolicyConfigError(
      `MEMORY_ACTIVATION_DECAY must satisfy 0 < d < 1, received ${decay}`,
    );
  }

  return Object.freeze({
    ...base,
    decay: decay ?? base.decay,
    activationThreshold: activationThreshold ?? base.activationThreshold,
  });
}
