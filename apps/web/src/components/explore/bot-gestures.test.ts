import { describe, expect, it } from "vitest";

import { GestureReader, pressWasClick } from "./bot-gestures";

describe("click runs", () => {
  it("resolves a run as one gesture once the clicking stops", () => {
    // The eggs are keyed on counts. If each click resolved on its own, the
    // two-click egg would fire on the way to seven and the later ones could
    // never be reached.
    const reader = new GestureReader();
    reader.leftClick(0);
    reader.leftClick(100);
    reader.leftClick(200);
    expect(reader.drain(500)).toEqual([]);
    expect(reader.drain(900)).toEqual([{ kind: "clickRun", count: 3 }]);
  });

  it("starts a new run after the break", () => {
    const reader = new GestureReader();
    reader.leftClick(0);
    expect(reader.drain(700)).toEqual([{ kind: "clickRun", count: 1 }]);
    reader.leftClick(1000);
    reader.leftClick(1100);
    expect(reader.drain(1800)).toEqual([{ kind: "clickRun", count: 2 }]);
  });

  it("keeps the run open while clicks keep arriving inside the break", () => {
    const reader = new GestureReader();
    reader.leftClick(0);
    reader.leftClick(600);
    expect(reader.drain(650)).toEqual([]);
    reader.leftClick(1200);
    expect(reader.drain(1250)).toEqual([]);
    expect(reader.drain(1900)).toEqual([{ kind: "clickRun", count: 3 }]);
  });

  it("takes the break length from options, since the real value is still being tuned", () => {
    const reader = new GestureReader({ clickRunBreakMs: 1500 });
    reader.leftClick(0);
    expect(reader.drain(900)).toEqual([]);
    expect(reader.drain(1500)).toEqual([{ kind: "clickRun", count: 1 }]);
  });
});

describe("right clicks", () => {
  it("reads a lone right-click as the menu gesture", () => {
    const reader = new GestureReader();
    reader.rightClick(0);
    expect(reader.drain(100)).toEqual([]);
    expect(reader.drain(300)).toEqual([{ kind: "rightClick" }]);
  });

  it("reads two inside the window as the double, so the single never pre-empts it", () => {
    // A double necessarily passes through a single. Without the window the
    // single would always win and the double would be unreachable.
    const reader = new GestureReader();
    reader.rightClick(0);
    reader.rightClick(120);
    expect(reader.drain(300)).toEqual([{ kind: "rightDoubleClick" }]);
  });

  it("treats a slipped third click as still a double, not a fresh single", () => {
    const reader = new GestureReader();
    reader.rightClick(0);
    reader.rightClick(90);
    reader.rightClick(180);
    expect(reader.drain(300)).toEqual([{ kind: "rightDoubleClick" }]);
  });

  it("counts a second click after the window as its own gesture", () => {
    const reader = new GestureReader();
    reader.rightClick(0);
    expect(reader.drain(300)).toEqual([{ kind: "rightClick" }]);
    reader.rightClick(400);
    expect(reader.drain(700)).toEqual([{ kind: "rightClick" }]);
  });
});

describe("scheduling", () => {
  it("reports nothing pending when idle", () => {
    const reader = new GestureReader();
    expect(reader.pending).toBe(false);
    expect(reader.nextDueAt()).toBeNull();
  });

  it("reports the soonest deadline so the caller needs only one timer", () => {
    const reader = new GestureReader();
    reader.leftClick(1000);
    reader.rightClick(1100);
    expect(reader.nextDueAt()).toBe(1400); // the right-click window closes first
  });

  it("stops being pending once drained", () => {
    const reader = new GestureReader();
    reader.leftClick(0);
    reader.drain(700);
    expect(reader.pending).toBe(false);
  });

  it("drops pending gestures on reset, so a persona change starts clean", () => {
    const reader = new GestureReader();
    reader.leftClick(0);
    reader.rightClick(0);
    reader.reset();
    expect(reader.drain(5000)).toEqual([]);
  });
});

describe("telling a click from a drag", () => {
  it("counts a still, brief press as a click", () => {
    expect(pressWasClick({ movedPx: 2, heldMs: 120 })).toBe(true);
  });

  it("does not count a press that moved", () => {
    expect(pressWasClick({ movedPx: 30, heldMs: 120 })).toBe(false);
  });

  it("does not count a press that was held — that reads as a grab", () => {
    expect(pressWasClick({ movedPx: 1, heldMs: 900 })).toBe(false);
  });
});
