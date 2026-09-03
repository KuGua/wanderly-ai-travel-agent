import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_CATCH_MS,
  CURSOR_VOMIT_TOTAL_MS,
  ShaziCursorVomit,
} from "./shazi-cursor-vomit";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.classList.remove("wanderly-cursor-swallowed");
});

describe("ShaziCursorVomit", () => {
  it("hides the real cursor only after the mouth arrives, then restores it", () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<ShaziCursorVomit cursor={{ x: 120, y: -30 }} onComplete={onComplete} />);

    expect(document.documentElement).not.toHaveClass("wanderly-cursor-swallowed");
    act(() => vi.advanceTimersByTime(CURSOR_CATCH_MS));
    expect(document.documentElement).toHaveClass("wanderly-cursor-swallowed");

    act(() => vi.advanceTimersByTime(CURSOR_VOMIT_TOTAL_MS - CURSOR_CATCH_MS));
    expect(document.documentElement).not.toHaveClass("wanderly-cursor-swallowed");
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("always restores the cursor when interrupted", () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <ShaziCursorVomit cursor={{ x: 0, y: 0 }} onComplete={() => {}} />,
    );
    act(() => vi.advanceTimersByTime(CURSOR_CATCH_MS));
    expect(document.documentElement).toHaveClass("wanderly-cursor-swallowed");

    unmount();
    expect(document.documentElement).not.toHaveClass("wanderly-cursor-swallowed");
  });

  it("passes the exact pointer offset to the animation layer", () => {
    const { container } = render(
      <ShaziCursorVomit cursor={{ x: 81, y: -24 }} onComplete={() => {}} />,
    );
    const layer = container.querySelector(".shazi-cursor-vomit") as HTMLElement;
    expect(layer.style.getPropertyValue("--shazi-cursor-x")).toBe("81px");
    expect(layer.style.getPropertyValue("--shazi-cursor-y")).toBe("-24px");
  });
});
