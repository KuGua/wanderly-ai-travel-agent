import { describe, expect, it } from "vitest";

import { typedLength } from "./terminal-typing";

/** Frames a 60Hz browser would deliver. */
const FRAME_MS = 1000 / 60;

/**
 * Replays a run frame by frame. `arrivals` are `[atMs, characters]` pairs
 * describing when the server's approved clauses land, which is what the real
 * cadence has to follow.
 */
function replay(arrivals: Array<[number, number]>, tailMs = 4000) {
  const lastArrivalAt = arrivals[arrivals.length - 1][0];
  let available = 0;
  let revealed = 0;
  let frozenMs = 0;
  let leftoverAtLastArrival: number | null = null;
  let finishedAfterMs: number | null = null;

  for (let t = 0; t < lastArrivalAt + tailMs; t += FRAME_MS) {
    for (const [at, characters] of arrivals) {
      if (at <= t && at > t - FRAME_MS) available += characters;
    }
    const arrivalRate = t > 0 ? (available / t) * 1000 : 0;
    const next = typedLength(revealed, available, FRAME_MS, arrivalRate);
    // Frozen: text is waiting to be drawn and the cursor did not move.
    if (t <= lastArrivalAt && available > 0 && next <= revealed + 1e-3) frozenMs += FRAME_MS;
    revealed = next;
    if (t >= lastArrivalAt && leftoverAtLastArrival === null) {
      leftoverAtLastArrival = available - revealed;
    }
    if (finishedAfterMs === null && t >= lastArrivalAt && revealed >= available) {
      finishedAfterMs = t - lastArrivalAt;
    }
  }
  return {
    frozenMs,
    leftoverAtLastArrival: leftoverAtLastArrival ?? 0,
    finishedAfterMs: finishedAfterMs ?? Infinity,
  };
}

/** ~48 characters over 2.8s — the shape of a typical short Chinese reply. */
const SHORT_REPLY: Array<[number, number]> = [[700, 11], [1400, 12], [2100, 13], [2750, 12]];
/** ~210 characters over 2.6s — a long reply, arriving far faster. */
const LONG_REPLY: Array<[number, number]> = [[500, 60], [1200, 55], [1900, 50], [2600, 45]];

describe("typedLength", () => {
  it("never reveals more than has arrived", () => {
    expect(typedLength(0, 5, 10_000, 1000)).toBe(5);
    expect(typedLength(4, 5, 10_000, 1000)).toBe(5);
  });

  it("does not move backwards when the target is already fully drawn", () => {
    expect(typedLength(12, 12, FRAME_MS, 20)).toBe(12);
    // Defensive: a shorter target must not produce a negative advance.
    expect(typedLength(12, 8, FRAME_MS, 20)).toBe(8);
  });

  it("advances fractionally so a sub-character step is not rounded away", () => {
    // Progress must accumulate as a float. Flooring inside this function
    // would freeze the cursor at zero on any step below one character.
    const next = typedLength(0, 100, 1, 0);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(1);
  });

  it("stands still when no time has passed", () => {
    expect(typedLength(3, 100, 0, 20)).toBe(3);
  });

  it("draws faster when text is arriving faster", () => {
    // Small backlog on purpose: with a large one the catch-up valve dominates
    // and the arrival rate would not be what is under test.
    const slow = typedLength(0, 10, FRAME_MS, 20);
    const fast = typedLength(0, 10, FRAME_MS, 200);
    expect(fast).toBeGreaterThan(slow);
  });

  it("falls back to the floor rate before an arrival rate is observable", () => {
    // The opening frames of a run have no history to measure.
    expect(typedLength(0, 10, FRAME_MS, 0)).toBeGreaterThan(0);
  });

  // The regression that made the first attempt read as block output: a fixed
  // 90 chars/s emptied each clause in ~130ms and then sat still until the next
  // one, so the reply spent most of its life motionless.
  it("keeps the cursor moving for the whole of a short reply", () => {
    const { frozenMs } = replay(SHORT_REPLY);
    expect(frozenMs).toBeLessThan(200);
  });

  it("keeps the cursor moving through a long, fast reply too", () => {
    const { frozenMs } = replay(LONG_REPLY);
    expect(frozenMs).toBeLessThan(700);
  });

  it("stays close behind the stream rather than lagging it", () => {
    // Whatever is still undrawn when the last delta lands is what snaps in if
    // the run settles immediately, so it has to stay small.
    expect(replay(SHORT_REPLY).leftoverAtLastArrival).toBeLessThan(20);
    expect(replay(LONG_REPLY).leftoverAtLastArrival).toBeLessThan(60);
    expect(replay(SHORT_REPLY).finishedAfterMs).toBeLessThan(1200);
    expect(replay(LONG_REPLY).finishedAfterMs).toBeLessThan(1200);
  });

  // The catch-up valve: this paces text that has *already* arrived, so a
  // whole reply landing at once must never become a slow replay.
  it("draws a whole-reply burst in about a second", () => {
    const { finishedAfterMs } = replay([[0, 2000]]);
    expect(finishedAfterMs).toBeLessThan(1500);
  });
});
