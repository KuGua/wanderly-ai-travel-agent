"use client";

/**
 * Which character the wander-bot is wearing.
 *
 * robo is drawn in CSS (see `.wanderly-bot-*` in globals.css) and predates
 * this file. 啥子 is hand-drawn art, dropped in as a file rather than traced
 * into paths — the drawing is the design, and redrawing it lost what made it
 * good.
 *
 * The body layer below this one owns position, dragging, perching and the
 * launch arc. A persona only decides what is painted inside that box, so a
 * new character never risks the movement behaviour.
 */

export type BotPersona = "robo" | "shazi";

/**
 * Swap the extension here if the art arrives as SVG — nothing else refers to
 * the file. It lives under `public/`, so the path is the URL.
 */
export const SHAZI_SPRITE_SRC = "/bot/shazi.png";

/** Roughly the drawing's own aspect ratio, so the box matches the art. */
const SHAZI_ASPECT = 1.12;

export function ShaziSprite({ onMissing }: { onMissing?: () => void }) {
  return (
    // A hand-drawn character a few dozen pixels wide, sized by a CSS variable
    // and served from our own `public/`. next/image would add an optimizer
    // pass and a layout contract for no gain, and its wrapper makes the
    // error-fallback below harder to keep honest.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="wanderly-bot-sprite"
      src={SHAZI_SPRITE_SRC}
      alt=""
      draggable={false}
      style={{ height: `calc(var(--bot-w) * ${SHAZI_ASPECT})` }}
      // A missing or unreadable file must never leave a broken-image icon
      // sitting over the globe: the bot falls back to robo instead.
      onError={onMissing}
    />
  );
}
