import { createHash, randomBytes } from "node:crypto";

/**
 * Per-user sliding-window rate limiter for the trip destination label
 * suggest endpoint (docs/trip-title-destination-label-implementation.md §8.4).
 *
 * Mirrors `thread-title-suggest-rate-limit.ts`:
 * - 32-byte per-instance salt; never persisted, never logged.
 * - One-hour sliding window per user.
 * - Process-local; multi-instance deployments multiply the effective quota.
 *   Documented as MVP-scale tech debt (spec §14).
 */

export const TRIP_DESTINATION_LABEL_RATE_LIMIT = Number(
  process.env.TRIP_DESTINATION_LABEL_RATE_LIMIT ?? 10,
);
export const TRIP_DESTINATION_LABEL_RATE_WINDOW_MS = Number(
  process.env.TRIP_DESTINATION_LABEL_RATE_WINDOW_MS ?? 60 * 60 * 1000,
);

type RateLimitWindow = { startedAt: number; requests: number };

export class TripDestinationLabelRateLimiter {
  private readonly salt = randomBytes(32);
  private readonly windows = new Map<string, RateLimitWindow>();

  constructor(
    private readonly limit: number = TRIP_DESTINATION_LABEL_RATE_LIMIT,
    private readonly windowMs: number = TRIP_DESTINATION_LABEL_RATE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  allow(userId: string): boolean {
    const now = this.now();
    this.prune(now);
    const key = createHash("sha256").update(this.salt).update(userId).digest("hex");
    const existing = this.windows.get(key);

    if (!existing || now - existing.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, requests: 1 });
      return true;
    }
    if (existing.requests >= this.limit) return false;
    existing.requests += 1;
    return true;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}
