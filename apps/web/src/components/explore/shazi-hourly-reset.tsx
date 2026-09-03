"use client";

import { useEffect, useState } from "react";

/**
 * The on-the-hour egg: while the bot is 啥子, every time the local clock
 * strikes the hour a big X and the word "resetting" flash above its head, and
 * a couple of seconds later 啥子 is reset back to robo.
 *
 * Self-contained on purpose — it owns its own timer and popup and only reports
 * the reset through `onReset`, so it plugs into the bot with a single line and
 * carries no risk to the movement or the other eggs.
 */

/** How long the "resetting" flash shows before 啥子 is reset. */
export const HOURLY_RESET_FLASH_MS = 2500;

/**
 * Milliseconds from `now` to the next local top-of-the-hour. Pure, so the
 * schedule is testable without waiting for a real hour to pass.
 */
export function msUntilNextHour(now: Date = new Date()): number {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(now.getHours() + 1);
  return next.getTime() - now.getTime();
}

export function ShaziHourlyReset({
  onReset,
  /** Override the wait for tests; defaults to the real time to the next hour. */
  msUntilFire,
}: {
  onReset: () => void;
  msUntilFire?: number;
}) {
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    const delay = msUntilFire ?? msUntilNextHour();
    const strike = window.setTimeout(() => {
      setFlashing(true);
      // Hold the flash, then hand the reset back to the bot. If a real hour is
      // being waited on, the reset to robo unmounts this component, so no
      // second hour is ever scheduled here — it fires once per 啥子 spell.
      window.setTimeout(onReset, HOURLY_RESET_FLASH_MS);
    }, delay);
    return () => window.clearTimeout(strike);
  }, [onReset, msUntilFire]);

  if (!flashing) return null;
  return (
    <div className="wanderly-bot-reset" role="status" aria-label="resetting">
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M8 8 L32 32 M32 8 L8 32" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
      </svg>
      <span>resetting</span>
    </div>
  );
}
