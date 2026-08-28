import { createHash, randomBytes } from "node:crypto";

/**
 * Defaults are intentionally compile-time per the existing
 * `LocationReferenceRateLimiter` pattern. Override via env when
 * integration-testing or stress-testing the anonymous limit.
 */
export const LOCATION_INTRODUCTION_RATE_LIMIT = Number(
  process.env.LOCATION_INTRODUCTION_RATE_LIMIT ?? 10,
);
export const LOCATION_INTRODUCTION_RATE_WINDOW_MS = Number(
  process.env.LOCATION_INTRODUCTION_RATE_WINDOW_MS ?? 60_000,
);

type RateLimitWindow = { startedAt: number; requests: number };

/**
 * Short-lived, per-process guard for the anonymous location-introduction
 * endpoint. Mirrors `LocationReferenceRateLimiter` but uses its own
 * random salt and bounded-window defaults (10 requests per 60 s per
 * hashed client IP). The salt is process-local and never persisted or
 * logged; we deliberately use a separate limiter so the two anonymous
 * endpoints can have independent quotas.
 */
export class LocationIntroductionRateLimiter {
  private readonly salt = randomBytes(32);
  private readonly windows = new Map<string, RateLimitWindow>();

  constructor(
    private readonly limit: number = LOCATION_INTRODUCTION_RATE_LIMIT,
    private readonly windowMs: number = LOCATION_INTRODUCTION_RATE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  allow(clientId: string): boolean {
    const now = this.now();
    this.prune(now);
    const key = createHash("sha256").update(this.salt).update(clientId).digest("hex");
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