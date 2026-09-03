import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SHAZI_QUIT_LINK, SHAZI_SWITCH_CHANCE, WanderBot } from "./wander-bot";

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

describe("啥子's quit menu", () => {
  afterEach(() => vi.restoreAllMocks());

  function renderShazi() {
    const bot = renderBot(() => 0);
    clickBot(bot);
    expect(bot.dataset.persona).toBe("shazi");
    return bot;
  }

  it("opens the menu on a lone right-click and leaves in a new tab when 退出 is picked", async () => {
    // A real 300ms window separates a single right-click from a double, so
    // this waits it out rather than faking the clock.
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const bot = renderShazi();

    fireEvent.contextMenu(bot);
    const quit = await screen.findByRole("button", { name: "退出" });

    fireEvent.click(quit);
    expect(open).toHaveBeenCalledWith(SHAZI_QUIT_LINK, "_blank", "noopener,noreferrer");
    // A new tab, so a run on this page is never thrown away.
    expect(open.mock.calls[0][1]).toBe("_blank");
  });

  it("does not open the menu for robo — the egg belongs to 啥子", () => {
    const bot = renderBot(() => 1);
    fireEvent.contextMenu(bot);
    expect(screen.queryByRole("button", { name: "退出" })).toBeNull();
  });

  it("is dismissable: a press outside closes it without leaving", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const bot = renderShazi();
    fireEvent.contextMenu(bot);
    await screen.findByRole("button", { name: "退出" });
    // The outside-close listener arms a tick after the menu opens, so the
    // press that opened it cannot also close it. Let that tick pass.
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.pointerDown(document.body);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "退出" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const bot = renderShazi();
    fireEvent.contextMenu(bot);
    await screen.findByRole("button", { name: "退出" });
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "退出" })).toBeNull();
  });
});

describe("啥子's seven-click flip game", () => {
  afterEach(() => {
    document.documentElement.classList.remove("wanderly-flip");
    vi.restoreAllMocks();
  });

  function toShazi() {
    const bot = renderBot(() => 0);
    clickBot(bot);
    expect(bot.dataset.persona).toBe("shazi");
    return bot;
  }

  // Seven clicks resolve as one clickRun(7); jsdom's timeStamp=0 does not
  // matter here — the count simply accumulates.
  async function clickSeven(bot: Element) {
    for (let i = 0; i < 7; i++) clickBot(bot);
    await new Promise((r) => setTimeout(r, 800));
  }

  it("starts the flip game on the seventh click and flips the page", async () => {
    const bot = toShazi();
    await clickSeven(bot);
    expect(await screen.findByRole("dialog", { name: "抓住啥子" })).toBeInTheDocument();
    expect(document.documentElement.classList.contains("wanderly-flip")).toBe(true);
    expect(bot.dataset.game).toBe("flip");
  });

  it("catching 啥子 ends the game and rights the screen", async () => {
    const bot = toShazi();
    await clickSeven(bot);
    await screen.findByRole("dialog", { name: "抓住啥子" });
    fireEvent.click(screen.getByRole("button", { name: "啥子" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog", { name: "抓住啥子" })).toBeNull();
    expect(document.documentElement.classList.contains("wanderly-flip")).toBe(false);
  });

  it("Escape exits the game", async () => {
    const bot = toShazi();
    await clickSeven(bot);
    await screen.findByRole("dialog", { name: "抓住啥子" });
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog", { name: "抓住啥子" })).toBeNull();
  });

  it("within cooldown, a repeat blushes instead of re-opening the game", async () => {
    const bot = toShazi();
    await clickSeven(bot);
    await screen.findByRole("dialog", { name: "抓住啥子" });
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 20));

    await clickSeven(bot);
    expect(screen.queryByRole("dialog", { name: "抓住啥子" })).toBeNull();
    expect(await screen.findByText("少年的脸红胜过一切💗")).toBeInTheDocument();
  });
});
