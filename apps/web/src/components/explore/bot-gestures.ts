/**
 * Turns raw pointer activity on the bot into named gestures.
 *
 * Pure and timer-free on purpose: the caller supplies the clock and decides
 * when to drain, so every rule below — the click-run break, the right-click
 * window — is unit-testable without waiting in real time.
 *
 * The rules exist because the easter eggs are keyed on click *counts*. If each
 * click resolved on its own, two clicks would fire the two-click egg and the
 * three-, five- and seven-click ones could never be reached. So a run of
 * clicks resolves as one gesture once the traveller stops clicking.
 */

export type BotGesture =
  | { kind: "clickRun"; count: number }
  | { kind: "rightClick" }
  | { kind: "rightDoubleClick" };

/**
 * How long a run of clicks stays open after the last click. Provisional — it
 * is meant to be tuned against real use, and lives here as one named constant
 * so tuning it is a one-line change.
 */
export const CLICK_RUN_BREAK_MS = 700;

/**
 * How long a right-click waits to see whether a second one follows.
 *
 * Affordable only because a right-click opens a menu rather than acting: the
 * menu is harmless and reversible, so 300ms of latency costs nothing. If the
 * single right-click ever becomes destructive again, this window has to go.
 */
export const RIGHT_CLICK_WINDOW_MS = 300;

type Options = {
  clickRunBreakMs?: number;
  rightClickWindowMs?: number;
};

export class GestureReader {
  private readonly clickRunBreakMs: number;
  private readonly rightClickWindowMs: number;
  private leftCount = 0;
  private leftLastAt = 0;
  private rightCount = 0;
  private rightFirstAt = 0;

  constructor(options: Options = {}) {
    this.clickRunBreakMs = options.clickRunBreakMs ?? CLICK_RUN_BREAK_MS;
    this.rightClickWindowMs = options.rightClickWindowMs ?? RIGHT_CLICK_WINDOW_MS;
  }

  leftClick(at: number): void {
    this.leftCount += 1;
    this.leftLastAt = at;
  }

  rightClick(at: number): void {
    if (this.rightCount === 0) this.rightFirstAt = at;
    this.rightCount += 1;
  }

  /** Whether anything is waiting on a timer, so the caller can stop polling. */
  get pending(): boolean {
    return this.leftCount > 0 || this.rightCount > 0;
  }

  /**
   * The soonest moment a pending gesture could resolve, or null when nothing
   * is pending. Lets the caller schedule one timer rather than poll.
   */
  nextDueAt(): number | null {
    const due: number[] = [];
    if (this.leftCount > 0) due.push(this.leftLastAt + this.clickRunBreakMs);
    if (this.rightCount > 0) due.push(this.rightFirstAt + this.rightClickWindowMs);
    return due.length ? Math.min(...due) : null;
  }

  /** Gestures whose window has closed by `at`. Resolved windows are cleared. */
  drain(at: number): BotGesture[] {
    const out: BotGesture[] = [];
    if (this.leftCount > 0 && at - this.leftLastAt >= this.clickRunBreakMs) {
      out.push({ kind: "clickRun", count: this.leftCount });
      this.leftCount = 0;
    }
    if (this.rightCount > 0 && at - this.rightFirstAt >= this.rightClickWindowMs) {
      // Two or more inside the window is the double. A third click is still a
      // double rather than a new single — a slipped finger should not open the
      // menu the traveller was trying to skip past.
      out.push(this.rightCount >= 2 ? { kind: "rightDoubleClick" } : { kind: "rightClick" });
      this.rightCount = 0;
    }
    return out;
  }

  /** Drops anything pending, e.g. when the bot changes persona mid-run. */
  reset(): void {
    this.leftCount = 0;
    this.rightCount = 0;
  }
}

/**
 * A press counts as a click, rather than a drag, when the pointer barely moved
 * and it was not held. Both are needed: a slow deliberate press that never
 * moves is still a click, but a press held for a second reads as a grab.
 */
export const CLICK_MOVE_TOLERANCE_PX = 4;
export const CLICK_HOLD_LIMIT_MS = 500;

export function pressWasClick(params: {
  movedPx: number;
  heldMs: number;
}): boolean {
  return params.movedPx <= CLICK_MOVE_TOLERANCE_PX && params.heldMs <= CLICK_HOLD_LIMIT_MS;
}
