import { describe, expect, it, vi } from "vitest";

import { createMemoryMaintenance } from "../src/workers/memory-maintenance.js";

describe("createMemoryMaintenance", () => {
  function harness(options: { intervalMs?: number } = {}) {
    let clock = 1_000_000;
    const sweep = vi.fn(async () => 0);
    const maintenance = createMemoryMaintenance({
      intervalMs: options.intervalMs ?? 3_600_000,
      now: () => clock,
      sweep,
    });
    return { maintenance, sweep, advance: (ms: number) => { clock += ms; } };
  }

  it("sweeps on the first call", async () => {
    // Proposals expire while the Worker is down, so the first pass after a
    // restart has to run rather than wait out an interval.
    const { maintenance, sweep } = harness();
    expect(await maintenance.runIfDue()).toBe(0);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("does not sweep again before the interval elapses", async () => {
    const { maintenance, sweep, advance } = harness({ intervalMs: 1000 });
    await maintenance.runIfDue();

    advance(999);
    expect(await maintenance.runIfDue()).toBeNull();
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("sweeps again once the interval elapses", async () => {
    const { maintenance, sweep, advance } = harness({ intervalMs: 1000 });
    await maintenance.runIfDue();

    advance(1000);
    expect(await maintenance.runIfDue()).toBe(0);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("reports how many proposals expired", async () => {
    let clock = 0;
    const maintenance = createMemoryMaintenance({
      intervalMs: 1000,
      now: () => clock,
      sweep: async () => 3,
    });
    expect(await maintenance.runIfDue()).toBe(3);
  });

  it("passes the sweep the time it was due at", async () => {
    const sweep = vi.fn(async () => 0);
    const maintenance = createMemoryMaintenance({ now: () => 1_700_000_000_000, sweep });
    await maintenance.runIfDue();
    expect(sweep).toHaveBeenCalledWith(new Date(1_700_000_000_000));
  });

  it("does not retry immediately after a sweep throws", async () => {
    // A failing sweep must not turn into a hot loop against the database; the
    // next attempt waits for the normal interval.
    let clock = 0;
    const sweep = vi.fn(async () => { throw new Error("db down"); });
    const maintenance = createMemoryMaintenance({ intervalMs: 1000, now: () => clock, sweep });

    await expect(maintenance.runIfDue()).rejects.toThrow("db down");
    expect(await maintenance.runIfDue()).toBeNull();
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
