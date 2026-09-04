import { describe, expect, it } from "vitest";

import {
  buildDefaultThreadTitle,
  buildIndexedThreadTitle,
} from "../src/services/thread-title-service.js";

describe("thread title service", () => {
  describe("buildDefaultThreadTitle", () => {
    it("returns the localized default for the Chinese locale", () => {
      expect(buildDefaultThreadTitle("zh")).toBe("行程规划");
    });

    it("returns the localized default for the English locale", () => {
      expect(buildDefaultThreadTitle("en")).toBe("Trip planning");
    });
  });

  describe("buildIndexedThreadTitle", () => {
    it("uses 1-based numbering for both locales", () => {
      expect(buildIndexedThreadTitle(1, "zh")).toBe("新对话 1");
      expect(buildIndexedThreadTitle(1, "en")).toBe("New chat 1");
    });

    it("scales to large indexes without injecting separators", () => {
      expect(buildIndexedThreadTitle(99, "zh")).toBe("新对话 99");
      expect(buildIndexedThreadTitle(99, "en")).toBe("New chat 99");
    });

    it("rejects non-positive or non-integer indexes", () => {
      expect(() => buildIndexedThreadTitle(0, "en")).toThrow(/positive integer/);
      expect(() => buildIndexedThreadTitle(-1, "en")).toThrow(/positive integer/);
      expect(() => buildIndexedThreadTitle(1.5, "en")).toThrow(/positive integer/);
    });
  });
});
