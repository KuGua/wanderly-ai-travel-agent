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
  const [virtualCursor, setVirtualCursor] = useState(() => ({
    x: typeof window === "undefined" ? 0 : window.innerWidth / 2,
    y: typeof window === "undefined" ? 0 : window.innerHeight / 2,
  }));
  const virtualCursorRef = useRef(virtualCursor);
  const reduced = useRef(prefersReducedMotion());
  const spriteRef = useRef<HTMLButtonElement>(null);

  // The flip is applied to the document for the game's lifetime; reduced-motion
  // keeps the screen upright but still plays.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("wanderly-flip-pointer-inverted");
    if (!reduced.current) root.classList.add("wanderly-flip");
    return () => {
      root.classList.remove("wanderly-flip");
      root.classList.remove("wanderly-flip-pointer-inverted");
    };
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

  // The visible pointer mirrors both viewport axes. Rightward physical motion
  // therefore moves it left, and upward motion moves it down. Escape behaviour
  // reads this same coordinate so the target and the cursor can never disagree.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const cursor = {
        x: window.innerWidth - event.clientX,
        y: window.innerHeight - event.clientY,
      };
      virtualCursorRef.current = cursor;
      setVirtualCursor(cursor);

      const node = spriteRef.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const dist = Math.hypot(cursor.x - cx, cursor.y - cy);
      if (dist > FLEE_RADIUS) return;
      // Jump to a fresh spot away from the pointer, kept off the edges.
      const away = Math.atan2(cy - cursor.y, cx - cursor.x);
      const jump = 22 + Math.random() * 12;
      setPos((current) => ({
        xPct: clamp(current.xPct + Math.cos(away) * jump + (Math.random() - 0.5) * 10, 8, 92),
        yPct: clamp(current.yPct + Math.sin(away) * jump + (Math.random() - 0.5) * 10, 10, 88),
      }));
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  const tryCatch = () => {
    const node = spriteRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const cursor = virtualCursorRef.current;
    if (
      cursor.x >= box.left
      && cursor.x <= box.right
      && cursor.y >= box.top
      && cursor.y <= box.bottom
    ) {
      onExit("caught");
    }
  };

  return (
    <div
      className="wanderly-flip-game"
      role="dialog"
      aria-label="抓住啥子"
      onPointerDown={tryCatch}
    >
      {/* Decorative 菌子 and light rings — placeholder art, swap freely. */}
      <div className="wanderly-flip-decor" aria-hidden="true">
        <span className="wanderly-flip-ring" />
        <span className="wanderly-flip-ring wanderly-flip-ring--b" />
        <span className="wanderly-flip-mush" style={{ left: "18%", top: "30%" }}>🍄</span>
        <span className="wanderly-flip-mush" style={{ left: "74%", top: "62%" }}>🍄</span>
        <span className="wanderly-flip-mush" style={{ left: "40%", top: "78%" }}>🍄</span>
      </div>

      {/* Upright even while the page is flipped, so it stays readable. */}
      <p className="wanderly-flip-hud">方向颠倒 · 抓住啥子 · 按 Esc 退出</p>

      <svg
        className="wanderly-flip-virtual-cursor"
        style={{ left: `${virtualCursor.x}px`, top: `${virtualCursor.y}px` }}
        viewBox="0 0 28 34"
        aria-hidden="true"
      >
        <path d="M3 2v25l7-7 5 11 5-2-5-11h10z" fill="#fff" stroke="#171717" strokeWidth="2.5" strokeLinejoin="round" />
      </svg>

      <button
        ref={spriteRef}
        type="button"
        className="wanderly-flip-shazi"
        style={{ left: `${pos.xPct}%`, top: `${pos.yPct}%` }}
        onPointerDown={(event) => event.stopPropagation()}
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
