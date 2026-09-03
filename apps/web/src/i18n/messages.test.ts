import { describe, expect, it } from "vitest";

import enMessages from "../../messages/en.json";
import zhMessages from "../../messages/zh.json";

function collectLeafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    expect(key, `next-intl message key at ${prefix || "<root>"}`).not.toContain(".");
    const path = prefix ? `${prefix}.${key}` : key;
    return collectLeafPaths(child, path);
  });
}

describe("locale messages", () => {
  it("uses nested next-intl keys and keeps English/Chinese in parity", () => {
    const englishPaths = collectLeafPaths(enMessages).sort();
    const chinesePaths = collectLeafPaths(zhMessages).sort();

    expect(chinesePaths).toEqual(englishPaths);
  });
});
