import { createHash, randomBytes } from "node:crypto";

export const LOCATION_REFERENCE_RATE_LIMIT = 30;
export const LOCATION_REFERENCE_RATE_WINDOW_MS = 60_000;

type RateLimitWindow = { startedAt: number; requests: number };

/**
 * Short-lived, per-process guard for the one anonymous endpoint. Client IPs
 * are hashed with a process-local random salt and are never logged or stored
 * outside this map. This is deliberately a local MVP control, not a shared
 * production rate-limit service.
 */
export class LocationReferenceRateLimiter {
  private readonly salt = randomBytes(32);
  private readonly windows = new Map<string, RateLimitWindow>();

  constructor(
    private readonly limit = LOCATION_REFERENCE_RATE_LIMIT,
    private readonly windowMs = LOCATION_REFERENCE_RATE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  allow(clientIp: string): boolean {
    const now = this.now();
    this.prune(now);
    const key = createHash("sha256").update(this.salt).update(clientIp).digest("hex");
    const existing = this.windows.get(key);

    if (!existing || now - existing.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, requests: 1 });
      return true;
    }
    if (existing.requests >= this.limit) return false;
    existing.requests += 1;
    return true;
  }

  private prune(now: number) {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}
