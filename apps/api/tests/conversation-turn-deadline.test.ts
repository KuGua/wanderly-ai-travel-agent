import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTurnDeadline } from "../src/tasks/handlers/conversation-task-handler.js";

describe("the conversation turn deadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const deadline = (
    aborts: string[],
    modelBudgetMs = 15_000,
    hardCapMs = 120_000,
    toolBudgetMs?: number,
  ) => {
    let aborted = false;
    return createTurnDeadline({
      modelBudgetMs,
      hardCapMs,
      ...(toolBudgetMs === undefined ? {} : { toolBudgetMs }),
      onAbort: (reason) => {
        aborted = true;
        aborts.push(reason);
      },
      isAborted: () => aborted,
      now: () => Date.now(),
    });
  };

  it("does not charge a supplier's latency to the model budget", async () => {
    // The bug this guards: a hotel search runs 10s+ inside Nuitee. Charged to
    // the same 15s Skill budget, the turn was aborted while summarising — the
    // offers were already fetched, persisted and on screen, and the traveller
    // was told the model was unreachable.
    const aborts: string[] = [];
    const turn = deadline(aborts);

    await vi.advanceTimersByTimeAsync(3_000); // model decides to call the tool
    const dispatch = turn.withPausedModelBudget(async () => {
      await vi.advanceTimersByTimeAsync(25_000); // the supplier
      return "offers";
    });
    expect(await dispatch).toBe("offers");
    expect(aborts).toEqual([]);

    await vi.advanceTimersByTimeAsync(11_000); // summarising, budget now 14s spent
    expect(aborts).toEqual([]);

    turn.clear();
  });

  it("still aborts a turn that spends its whole budget on the model", async () => {
    const aborts: string[] = [];
    const turn = deadline(aborts);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(aborts).toEqual(["Conversation Skill timed out"]);
    turn.clear();
  });

  it("spends the budget across resumes rather than restarting it", async () => {
    const aborts: string[] = [];
    const turn = deadline(aborts);

    await vi.advanceTimersByTimeAsync(14_000);
    await turn.withPausedModelBudget(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // 1s of model budget is left, not a fresh 15s.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(aborts).toEqual(["Conversation Skill timed out"]);
    turn.clear();
  });

  it("caps wall clock so a supplier that never answers cannot hold the turn", async () => {
    const aborts: string[] = [];
    const turn = deadline(aborts);
    const pending = turn.withPausedModelBudget(() => new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(120_001);
    expect(aborts).toEqual(["Conversation turn exceeded its hard cap"]);
    void pending;
    turn.clear();
  });

  it("fires nothing once cleared", async () => {
    const aborts: string[] = [];
    const turn = deadline(aborts);
    turn.clear();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(aborts).toEqual([]);
  });

  it("does not meter tools when no tool budget was given", async () => {
    const aborts: string[] = [];
    const turn = deadline(aborts);
    await turn.withPausedModelBudget(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(turn.isToolBudgetExhausted()).toBe(false);
    turn.clear();
  });

  it("charges each paused window to the tool budget and reports exhaustion", async () => {
    // Pausing the model clock keeps a slow supplier from stealing the reply
    // window, but on its own it bounds nothing: suppliers can keep pausing
    // until the hard cap. The aggregate budget is what stops that.
    const aborts: string[] = [];
    const turn = deadline(aborts, 15_000, 120_000, 20_000);

    await turn.withPausedModelBudget(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(turn.isToolBudgetExhausted()).toBe(false);

    await turn.withPausedModelBudget(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(turn.isToolBudgetExhausted()).toBe(true);
    // Exhaustion is a dispatch signal, never an abort — the model must still
    // get to answer with the evidence the first calls did return.
    expect(aborts).toEqual([]);

    turn.clear();
  });

  it("charges a dispatch that threw, because the time was still spent", async () => {
    const aborts: string[] = [];
    const turn = deadline(aborts, 15_000, 120_000, 5_000);

    await expect(turn.withPausedModelBudget(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
      throw new Error("supplier failed slowly");
    })).rejects.toThrow("supplier failed slowly");

    expect(turn.isToolBudgetExhausted()).toBe(true);
    expect(aborts).toEqual([]);
    turn.clear();
  });
});
