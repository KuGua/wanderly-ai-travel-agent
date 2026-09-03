"use client";

import { useEffect, useRef, useState } from "react";

import { SHAZI_SPRITE_SRC } from "./bot-personas";

/**
 * The seven-click egg: the screen turns upside down and 啥子 runs from the
 * pointer; catch it and everything rights itself.
 *
 * A full-screen effect that takes control of the view has to hand it back no
 * matter what, so there are three ways out — catching 啥子, Escape, and a
 * hard fallback timeout — and someone who set prefers-reduced-motion is not
 * flipped at all (the flip is the part that can make a person queasy); they
 * still play the catch game the right way up.
 *
 * The flip lives on <html> for the duration and is removed on unmount, rather
 * than the bot reaching into global CSS itself.
 */

export type FlipGameExit = "caught" | "escape" | "timeout";

/** How long before the game gives up and rights the screen on its own. */
export const FLIP_GAME_FALLBACK_MS = 120_000;

/** Pointer gets this close (px) and 啥子 bolts. */
const FLEE_RADIUS = 120;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function ShaziFlipGame({
  onExit,
  fallbackMs = FLIP_GAME_FALLBACK_MS,
}: {
  onExit: (reason: FlipGameExit) => void;
  fallbackMs?: number;
}) {
  const [pos, setPos] = useState({ xPct: 50, yPct: 45 });
  const reduced = useRef(prefersReducedMotion());
  const spriteRef = useRef<HTMLButtonElement>(null);

  // The flip is applied to the document for the game's lifetime; reduced-motion
  // keeps the screen upright but still plays.
  useEffect(() => {
    if (reduced.current) return;
    const root = document.documentElement;
    root.classList.add("wanderly-flip");
    return () => root.classList.remove("wanderly-flip");
  }, []);

  // Escape and the fallback timeout: two of the three exits.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit("escape");
    };
    window.addEventListener("keydown", onKey);
    const bail = window.setTimeout(() => onExit("timeout"), fallbackMs);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(bail);
    };
  }, [onExit, fallbackMs]);

  // 啥子 flees the pointer. Distance is measured in the real viewport; the flip
  // is a CSS transform, so the browser hit-tests the mirrored position on its
  // own and no coordinate has to be un-flipped here.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const node = spriteRef.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const dist = Math.hypot(event.clientX - cx, event.clientY - cy);
      if (dist > FLEE_RADIUS) return;
      // Jump to a fresh spot away from the pointer, kept off the edges.
      const away = Math.atan2(cy - event.clientY, cx - event.clientX);
      const jump = 22 + Math.random() * 12;
      setPos((current) => ({
        xPct: clamp(current.xPct + Math.cos(away) * jump + (Math.random() - 0.5) * 10, 8, 92),
        yPct: clamp(current.yPct + Math.sin(away) * jump + (Math.random() - 0.5) * 10, 10, 88),
      }));
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <div className="wanderly-flip-game" role="dialog" aria-label="抓住啥子">
      {/* Decorative 菌子 and light rings — placeholder art, swap freely. */}
      <div className="wanderly-flip-decor" aria-hidden="true">
        <span className="wanderly-flip-ring" />
        <span className="wanderly-flip-ring wanderly-flip-ring--b" />
        <span className="wanderly-flip-mush" style={{ left: "18%", top: "30%" }}>🍄</span>
        <span className="wanderly-flip-mush" style={{ left: "74%", top: "62%" }}>🍄</span>
        <span className="wanderly-flip-mush" style={{ left: "40%", top: "78%" }}>🍄</span>
      </div>

      {/* Upright even while the page is flipped, so it stays readable. */}
      <p className="wanderly-flip-hud">抓住啥子 · 按 Esc 退出</p>

      <button
        ref={spriteRef}
        type="button"
        className="wanderly-flip-shazi"
        style={{ left: `${pos.xPct}%`, top: `${pos.yPct}%` }}
        onClick={() => onExit("caught")}
        aria-label="啥子"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={SHAZI_SPRITE_SRC} alt="" draggable={false} />
      </button>
    </div>
  );
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
