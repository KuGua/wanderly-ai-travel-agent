import { describe, expect, it } from "vitest";

import { LocationReferenceRateLimiter } from "../src/routes/location-reference-rate-limit.js";

describe("anonymous location reference rate limiter", () => {
  it("limits each client to 30 requests per rolling one-minute window", () => {
    let now = 1_000;
    const limiter = new LocationReferenceRateLimiter(30, 60_000, () => now);

    for (let request = 0; request < 30; request += 1) {
      expect(limiter.allow("127.0.0.1")).toBe(true);
    }
    expect(limiter.allow("127.0.0.1")).toBe(false);
    expect(limiter.allow("127.0.0.2")).toBe(true);

    now += 60_000;
    expect(limiter.allow("127.0.0.1")).toBe(true);
  });
});
