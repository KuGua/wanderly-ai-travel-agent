import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalTyping } from "./terminal-typing";

afterEach(cleanup);

const TEXT = "根据你的出发时间和预算，我建议先锁定往返航班，再看住宿；这样调整空间更大。";

function Probe({ active }: { active: boolean }) {
  return <div data-testid="out">{useTerminalTyping(TEXT, active)}</div>;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("useTerminalTyping", () => {
  it("reveals a prefix while the run is active, then reaches the full text", async () => {
    render(<Probe active />);
    await wait(150);
    const partial = screen.getByTestId("out").textContent ?? "";
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(TEXT.length);
    expect(TEXT.startsWith(partial)).toBe(true);

    await wait(2500);
    expect(screen.getByTestId("out").textContent).toBe(TEXT);
  });

  it("shows everything at once once the run has settled", () => {
    render(<Probe active={false} />);
    expect(screen.getByTestId("out").textContent).toBe(TEXT);
  });

  describe("with prefers-reduced-motion: reduce", () => {
    beforeEach(() => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    // The reveal is content arriving, not decoration. The blinking block
    // cursor is the decorative part and `globals.css` already stops it under
    // this query; bailing out here as well did not reduce motion, it only
    // replaced a smooth flow with a dozen abrupt clause-sized jumps.
    it("still reveals progressively", async () => {
      render(<Probe active />);
      await wait(150);
      const partial = screen.getByTestId("out").textContent ?? "";
      expect(partial.length).toBeGreaterThan(0);
      expect(partial.length).toBeLessThan(TEXT.length);
    });
  });
});
