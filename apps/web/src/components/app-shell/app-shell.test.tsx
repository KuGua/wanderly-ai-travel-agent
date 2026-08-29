import { describe, expect, it } from "vitest";

import { contentGridClass } from "./app-shell";

describe("contentGridClass", () => {
  it("lets the Explore map extend behind the fixed desktop rail", () => {
    expect(contentGridClass("/home")).toBe("sm:col-span-2 sm:col-start-1");
  });

  it("keeps the desktop rail gutter for standard pages", () => {
    expect(contentGridClass("/projects")).toBe("sm:col-start-2");
  });
});
