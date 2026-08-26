import { describe, expect, it } from "vitest";

import { calculateRetryDelayMs } from "../src/tasks/task-repository.js";

describe("durable task retry scheduling", () => {
  it("uses bounded exponential backoff with deterministic jitter", () => {
    expect(calculateRetryDelayMs(1, () => 0)).toBe(250);
    expect(calculateRetryDelayMs(1, () => 1)).toBe(500);
    expect(calculateRetryDelayMs(2, () => 0)).toBe(500);
    expect(calculateRetryDelayMs(5, () => 1)).toBe(8_000);
    expect(calculateRetryDelayMs(10, () => 0)).toBe(4_000);
  });
});
