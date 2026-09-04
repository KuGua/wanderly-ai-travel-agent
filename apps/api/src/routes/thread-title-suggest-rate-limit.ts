import { createHash, randomBytes } from "node:crypto";

/**
 * Defaults are intentionally compile-time per the existing
 * `LocationIntroductionRateLimiter` pattern. Override via env when
 * integration-testing or stress-testing the per-user limit.
 */
export const THREAD_TITLE_SUGGEST_RATE_LIMIT = Number(
  process.env.THREAD_TITLE_SUGGEST_RATE_LIMIT ?? 10,
);
export const THREAD_TITLE_SUGGEST_RATE_WINDOW_MS = Number(
  process.env.THREAD_TITLE_SUGGEST_RATE_WINDOW_MS ?? 60 * 60 * 1000,
);

type RateLimitWindow = { startedAt: number; requests: number };

/**
 * Short-lived, per-process guard for the owner-triggered thread-title
 * suggest endpoint. Mirrors `LocationIntroductionRateLimiter` but keyed by
 * authenticated userId (the endpoint is auth-gated) and uses a one-hour
 * window per docs/thread-title-lifecycle-implementation.md §9.3.
 *
 * The salt is process-local and never persisted or logged; we deliberately
 * use a separate limiter so the anonymous and authenticated endpoints keep
 * independent quotas.
 */
export class ThreadTitleSuggestRateLimiter {
  private readonly salt = randomBytes(32);
  private readonly windows = new Map<string, RateLimitWindow>();

  constructor(
    private readonly limit: number = THREAD_TITLE_SUGGEST_RATE_LIMIT,
    private readonly windowMs: number = THREAD_TITLE_SUGGEST_RATE_WINDOW_MS,
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
