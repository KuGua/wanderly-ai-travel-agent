import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SHAZI_SWITCH_CHANCE, WanderBot } from "./wander-bot";

afterEach(cleanup);

/** A press that does not move and is not held reads as a click, not a grab. */
function clickBot(node: Element) {
  fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 100, clientY: 100 });
}

function renderBot(random: () => number) {
  // jsdom implements neither pointer-capture call, and the component takes
  // them for granted the way a browser lets it. Without these the very first
  // line of the drag handler throws and no click is ever seen.
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  render(<WanderBot random={random} />);
  // The bot is decorative, so it carries no role — the persona attribute is
  // what the rest of the behaviour keys on.
  return document.querySelector(".wanderly-bot") as HTMLElement;
}

describe("the 17% switch", () => {
  it("turns robo into 啥子 when the roll lands under the chance", () => {
    const bot = renderBot(() => SHAZI_SWITCH_CHANCE - 0.01);
    expect(bot.dataset.persona).toBe("robo");
    clickBot(bot);
    expect(bot.dataset.persona).toBe("shazi");
  });

  it("leaves robo alone when the roll misses", () => {
    const bot = renderBot(() => SHAZI_SWITCH_CHANCE + 0.01);
    clickBot(bot);
    expect(bot.dataset.persona).toBe("robo");
  });

  it("rolls on every click rather than only the first", () => {
    let rolls = 0;
    // Misses twice, then lands.
    const bot = renderBot(() => (++rolls < 3 ? 0.9 : 0));
    clickBot(bot);
    clickBot(bot);
    expect(bot.dataset.persona).toBe("robo");
    clickBot(bot);
    expect(bot.dataset.persona).toBe("shazi");
    expect(rolls).toBe(3);
  });

  it("does not roll on a drag — moving the bot is not clicking it", () => {
    let rolls = 0;
    const bot = renderBot(() => { rolls += 1; return 0; });
    fireEvent.pointerDown(bot, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(bot, { pointerId: 1, clientX: 240, clientY: 180 });
    expect(rolls).toBe(0);
    expect(bot.dataset.persona).toBe("robo");
  });

  it("stops rolling once it is already 啥子", () => {
    let rolls = 0;
    const bot = renderBot(() => { rolls += 1; return 0; });
    clickBot(bot);
    expect(bot.dataset.persona).toBe("shazi");
    clickBot(bot);
    clickBot(bot);
    // 啥子's clicks accumulate into a run instead; nothing re-rolls.
    expect(rolls).toBe(1);
  });
});

describe("the way back", () => {
  it("falls back to robo when the artwork cannot be loaded", () => {
    // A missing or unreadable file must never leave a broken-image icon
    // sitting over the globe.
    const bot = renderBot(() => 0);
    clickBot(bot);
    expect(bot.dataset.persona).toBe("shazi");
    fireEvent.error(bot.querySelector("img")!);
    expect(bot.dataset.persona).toBe("robo");
  });
});
