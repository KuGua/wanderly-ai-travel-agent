"use client";

import { useEffect } from "react";

import { SHAZI_SPRITE_SRC } from "./bot-personas";

export type CursorOffset = { x: number; y: number };

export const CURSOR_CATCH_MS = 1_000;
export const MOUTH_RETURN_MS = 3_000;
export const EYE_PAUSE_MS = 500;
export const EYE_SPIN_MS = 1_500;
export const CURSOR_VOMIT_MS = 700;
export const CURSOR_VOMIT_TOTAL_MS =
  CURSOR_CATCH_MS + MOUTH_RETURN_MS + EYE_PAUSE_MS + EYE_SPIN_MS + CURSOR_VOMIT_MS;

const SWALLOWED_CURSOR_CLASS = "wanderly-cursor-swallowed";

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Visual-only layer for 啥子's three-click egg.
 *
 * It reuses clipped copies of the original hand-drawn sprite, so the mouth
 * and eyes keep the artist's line rather than being approximated in CSS. The
 * real cursor is hidden only after the mouth reaches it and is restored on
 * every exit path, including unmount.
 */
export function ShaziCursorVomit({
  cursor,
  onComplete,
}: {
  cursor: CursorOffset;
  onComplete: () => void;
}) {
  useEffect(() => {
    if (reducedMotion()) {
      const finish = window.setTimeout(onComplete, 0);
      return () => window.clearTimeout(finish);
    }

    const root = document.documentElement;
    const swallow = window.setTimeout(
      () => root.classList.add(SWALLOWED_CURSOR_CLASS),
      CURSOR_CATCH_MS,
    );
    const finish = window.setTimeout(() => {
      root.classList.remove(SWALLOWED_CURSOR_CLASS);
      onComplete();
    }, CURSOR_VOMIT_TOTAL_MS);

    return () => {
      window.clearTimeout(swallow);
      window.clearTimeout(finish);
      root.classList.remove(SWALLOWED_CURSOR_CLASS);
    };
  }, [onComplete]);

  const style = {
    "--shazi-cursor-x": `${cursor.x}px`,
    "--shazi-cursor-y": `${cursor.y}px`,
  } as React.CSSProperties;

  return (
    <div className="shazi-cursor-vomit" style={style} aria-hidden="true">
      <svg className="shazi-effect-filters" width="0" height="0">
        <defs>
          <filter id="shazi-remove-white" colorInterpolationFilters="sRGB">
            {/* White becomes transparent; dark ink and blue drool stay opaque. */}
            <feColorMatrix
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  -1 -1 -1 0 3"
            />
          </filter>
        </defs>
      </svg>
      <span className="shazi-mouth-eraser" />
      {/* Clipped duplicates preserve the exact mouth and eye artwork. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="shazi-mouth-layer" src={SHAZI_SPRITE_SRC} alt="" draggable={false} />
      <span className="shazi-eye-backing shazi-eye-backing--left" />
      <span className="shazi-eye-backing shazi-eye-backing--right" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="shazi-eye-layer shazi-eye-layer--left" src={SHAZI_SPRITE_SRC} alt="" draggable={false} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="shazi-eye-layer shazi-eye-layer--right" src={SHAZI_SPRITE_SRC} alt="" draggable={false} />
      <svg className="shazi-vomited-cursor" viewBox="0 0 28 34" focusable="false">
        <path d="M3 2v25l7-7 5 11 5-2-5-11h10z" fill="#fff" stroke="#171717" strokeWidth="2.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
