import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const globalStyles = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

describe("ShaziFlipGame style contract", () => {
  it.each([
    "html.wanderly-flip body",
    ".wanderly-flip-game",
    ".wanderly-flip-decor",
    ".wanderly-flip-hud",
    ".wanderly-flip-shazi",
  ])("keeps %s explicitly styled", (selector) => {
    expect(globalStyles).toContain(selector);
  });

  it("keeps the game above the app and able to catch the pointer", () => {
    expect(globalStyles).toMatch(/\.wanderly-flip-game\s*{[^}]*position:\s*fixed/);
    expect(globalStyles).toMatch(/\.wanderly-flip-shazi\s*{[^}]*pointer-events:\s*auto/);
  });
});
