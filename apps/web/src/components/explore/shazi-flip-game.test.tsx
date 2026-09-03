import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShaziFlipGame } from "./shazi-flip-game";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("wanderly-flip");
  document.documentElement.classList.remove("wanderly-flip-pointer-inverted");
});

describe("ShaziFlipGame inverted pointer", () => {
  it("mirrors the physical pointer across both viewport axes", () => {
    render(<ShaziFlipGame onExit={() => {}} />);
    fireEvent.pointerMove(window, { clientX: 120, clientY: 210 });

    const cursor = document.querySelector(".wanderly-flip-virtual-cursor") as HTMLElement;
    expect(cursor.style.left).toBe(`${window.innerWidth - 120}px`);
    expect(cursor.style.top).toBe(`${window.innerHeight - 210}px`);
    expect(document.documentElement).toHaveClass("wanderly-flip-pointer-inverted");
  });

  it("makes 啥子 flee from the visible cursor rather than the hidden one", () => {
    render(<ShaziFlipGame onExit={() => {}} />);
    const target = screen.getByRole("button", { name: "啥子" });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 472,
      y: 344,
      left: 472,
      top: 344,
      right: 552,
      bottom: 424,
      width: 80,
      height: 80,
      toJSON: () => ({}),
    });

    fireEvent.pointerMove(window, {
      clientX: window.innerWidth - 512,
      clientY: window.innerHeight - 384,
    });

    expect(target.style.left).not.toBe("50%");
  });

  it("catches at the virtual cursor position", () => {
    const onExit = vi.fn();
    render(<ShaziFlipGame onExit={onExit} />);
    const target = screen.getByRole("button", { name: "啥子" });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 860,
      y: 510,
      left: 860,
      top: 510,
      right: 940,
      bottom: 590,
      width: 80,
      height: 80,
      toJSON: () => ({}),
    });

    fireEvent.pointerMove(window, {
      clientX: window.innerWidth - 900,
      clientY: window.innerHeight - 550,
    });
    fireEvent.pointerDown(screen.getByRole("dialog", { name: "抓住啥子" }));

    expect(onExit).toHaveBeenCalledWith("caught");
  });

  it("restores the system cursor when the game exits", () => {
    const { unmount } = render(<ShaziFlipGame onExit={() => {}} />);
    expect(document.documentElement).toHaveClass("wanderly-flip-pointer-inverted");
    unmount();
    expect(document.documentElement).not.toHaveClass("wanderly-flip-pointer-inverted");
  });
});
