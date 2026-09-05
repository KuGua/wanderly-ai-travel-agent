"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Paces the *drawing* of assistant text that has already arrived over SSE.
 *
 * This is not playback of a finished reply. The server approves and publishes
 * one clause at a time (`SafeConversationDeltaGate`), so `text` grows while
 * the model is still generating; this hook only decides how fast the
 * already-delivered characters are painted, and it never draws a character
 * that has not arrived.
 *
 * The cadence follows the stream's own rate rather than a fixed speed. A
 * fixed speed was the first attempt and it failed in a specific way: drawing
 * at 90 chars/s emptied each ~12-character clause in about 130ms and then sat
 * frozen for the ~700ms until the next one, so a typical reply spent 85% of
 * its life motionless and read as four blocks appearing, not as typing.
 * Drawing slightly faster than text arrives keeps the cursor just behind the
 * frontier, which is what makes the motion continuous.
 */

/** Floor for the opening characters, before an arrival rate is observable. */
const MIN_CHARS_PER_SECOND = 12;
/** Draw this much faster than text arrives, so the backlog trends to zero. */
const OVERDRAW = 1.3;
/**
 * Safety valve. A backlog the paced rate cannot clear — a burst, or a whole
 * reply delivered in one delta — is drained on this schedule instead, so the
 * cursor can never turn into a slow replay of text that already landed.
 */
const CATCH_UP_WINDOW_MS = 1000;

/**
 * How many characters should be visible after `elapsedMs`.
 *
 * Pure and fractional — the caller floors it — so a sub-one-character step
 * still accumulates instead of rounding away to nothing.
 *
 * `arrivalCharsPerSecond` is the rate text has been arriving at over the run
 * so far. Passing 0 falls back to the floor.
 */
export function typedLength(
  revealed: number,
  available: number,
  elapsedMs: number,
  arrivalCharsPerSecond: number,
): number {
  if (revealed >= available) return available;
  if (elapsedMs <= 0) return revealed;
  const paced = (Math.max(MIN_CHARS_PER_SECOND, arrivalCharsPerSecond * OVERDRAW) * elapsedMs) / 1000;
  const catchUp = ((available - revealed) * elapsedMs) / CATCH_UP_WINDOW_MS;
  return Math.min(available, revealed + Math.max(paced, catchUp));
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function useTerminalTyping(text: string, active: boolean): string {
  const [revealed, setRevealed] = useState(0);
  const revealedRef = useRef(0);
  // Lazy state initialiser rather than a ref: this value is read during
  // render, where a ref read is neither safe nor allowed. Sampled once per
  // mount, matching the existing `shazi-flip-game` pattern.
  const [reduced] = useState(prefersReducedMotion);
  const targetRef = useRef(text);

  // Written from an effect, not during render. The frame loop reads it so a
  // growing `text` does not tear down and rebuild the loop, which would reset
  // the frame clock on every delta.
  useEffect(() => {
    targetRef.current = text;
  });

  useEffect(() => {
    if (!active || reduced) return;
    // A run starts from the beginning. Resetting here rather than on the
    // inactive branch keeps `setRevealed` out of the effect body, where a
    // synchronous state write would cascade renders.
    revealedRef.current = 0;
    let frame = 0;
    const startedAt = performance.now();
    let last = startedAt;
    const tick = (now: number) => {
      const available = targetRef.current.length;
      const runMs = now - startedAt;
      const arrivalRate = runMs > 0 ? (available / runMs) * 1000 : 0;
      const next = typedLength(revealedRef.current, available, now - last, arrivalRate);
      last = now;
      if (next !== revealedRef.current) {
        revealedRef.current = next;
        setRevealed(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, reduced]);

  if (!active || reduced) return text;
  return text.slice(0, Math.floor(revealed));
}
