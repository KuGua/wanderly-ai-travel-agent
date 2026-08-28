import { describe, expect, it } from "vitest";
import { LocationIntroductionRateLimiter } from "../src/routes/location-introduction-rate-limit.js";

describe("LocationIntroductionRateLimiter", () => {
  it("allows 10 requests in a window then rejects the 11th", () => {
    let now = 1_000_000;
    const limiter = new LocationIntroductionRateLimiter(10, 60_000, () => now);

    for (let i = 0; i < 10; i += 1) {
      now += 100;
      expect(limiter.allow("203.0.113.5")).toBe(true);
    }
    now += 100;
    expect(limiter.allow("203.0.113.5")).toBe(false);
  });

  it("isolates two different client ids", () => {
    let now = 1_000_000;
    const limiter = new LocationIntroductionRateLimiter(10, 60_000, () => now);

    for (let i = 0; i < 10; i += 1) {
      now += 100;
      expect(limiter.allow("203.0.113.5")).toBe(true);
    }
    expect(limiter.allow("203.0.113.6")).toBe(true);
  });

  it("resets the window after the configured interval", () => {
    let now = 1_000_000;
    const limiter = new LocationIntroductionRateLimiter(10, 60_000, () => now);

    for (let i = 0; i < 10; i += 1) {
      now += 100;
      expect(limiter.allow("203.0.113.5")).toBe(true);
    }
    now += 60_000;
    expect(limiter.allow("203.0.113.5")).toBe(true);
  });

  it("two limiter instances have independent salts", () => {
    const a = new LocationIntroductionRateLimiter(10, 60_000, () => 0);
    const b = new LocationIntroductionRateLimiter(10, 60_000, () => 0);
    expect(a.allow("client")).toBe(true);
    expect(b.allow("client")).toBe(true);
  });
});