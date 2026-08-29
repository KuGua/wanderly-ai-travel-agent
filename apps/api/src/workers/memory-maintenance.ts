import { expireStaleProposals } from "../services/memory-proposal-service.js";
import { logger } from "../utils/logger.js";

/**
 * Periodic upkeep for memory proposals.
 *
 * A proposal that nobody answered has to stop being offered eventually
 * (docs/long-term-memory-implementation.md §3.7). Expiry is a property of
 * elapsed time rather than of anything the user does, so no request path can be
 * relied on to notice it: without a sweep, an unanswered suggestion is offered
 * forever and its evidence is never cleared.
 *
 * The sweep is a single guarded bulk update, so running it from several Worker
 * processes at once is safe — the second finds nothing left to expire.
 */

/**
 * Proposals live for 90 days, so an hour is frequent enough for the boundary
 * to be invisible and rare enough to stay off the critical path.
 */
export const MEMORY_MAINTENANCE_INTERVAL_MS = 3_600_000;

export type MemoryMaintenance = {
  /**
   * Runs the sweep if the interval has elapsed. Returns the number of
   * proposals expired, or `null` when it was not yet due.
   */
  runIfDue(): Promise<number | null>;
};

export function createMemoryMaintenance(options: {
  intervalMs?: number;
  now?: () => number;
  sweep?: (now: Date) => Promise<number>;
} = {}): MemoryMaintenance {
  const intervalMs = options.intervalMs ?? MEMORY_MAINTENANCE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sweep = options.sweep ?? ((at: Date) => expireStaleProposals(at));

  // Never swept. The first call runs immediately, which is what catches
  // proposals that expired while the Worker was down.
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  return {
    async runIfDue(): Promise<number | null> {
      const at = now();
      if (at - lastSweepAt < intervalMs) return null;
      lastSweepAt = at;

      const expired = await sweep(new Date(at));
      if (expired > 0) {
        logger.info({ component: "memory-maintenance", expired }, "Expired stale memory proposals");
      }
      return expired;
    },
  };
}
