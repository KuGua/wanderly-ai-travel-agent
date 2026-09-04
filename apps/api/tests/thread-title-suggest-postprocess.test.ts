import { describe, expect, it } from "vitest";

import { postprocessThreadTitle } from "../src/services/thread-title-suggest-postprocess.js";

describe("thread title postprocessing", () => {
  it("trims and collapses whitespace", () => {
    expect(postprocessThreadTitle("  hello\t\tworld\n", []))
      .toEqual({ ok: true, title: "hello world" });
  });

  it("drops emoji and hidden tag code points", () => {
    expect(postprocessThreadTitle("Tokyo 🗼 tips \u{E0067}", []))
      .toEqual({ ok: true, title: "Tokyo tips" });
  });

  // The private use areas were never actually matched: the constant named
  // for them covered U+E0000–U+E0FFF, which is the Tags block. A PUA glyph
  // renders as tofu or as whatever the reader's font happens to map it to.
  it("drops real private-use-area code points", () => {
    expect(postprocessThreadTitle("Visa \u{E000}prep\u{F8FF}", []))
      .toEqual({ ok: true, title: "Visa prep" });
  });

  // Every strip pattern must be global. Without the `g` flag `replace`
  // removes only the first match and leaves the rest in the title.
  it("drops every occurrence, not just the first", () => {
    expect(postprocessThreadTitle("🗼a🗼b🗼c\u{E0067}d\u{E0067}e", []))
      .toEqual({ ok: true, title: "abcde" });
  });

  it("rejects titles that become empty after stripping", () => {
    expect(postprocessThreadTitle("🗼🗼🗼", []))
      .toEqual({ ok: false, reason: "REJECTED" });
  });

  it("hard-truncates to 40 code points", () => {
    const long = "a".repeat(80);
    const result = postprocessThreadTitle(long, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.from(result.title)).toHaveLength(40);
  });

  it("rejects titles containing URLs", () => {
    expect(postprocessThreadTitle("see https://example.com for tips", []))
      .toEqual({ ok: false, reason: "REJECTED" });
  });

  it("rejects titles containing email addresses", () => {
    expect(postprocessThreadTitle("contact me at foo@bar.com today", []))
      .toEqual({ ok: false, reason: "REJECTED" });
  });

  it("rejects titles with 6+ consecutive digits", () => {
    expect(postprocessThreadTitle("card 4111111111111111 lost", []))
      .toEqual({ ok: false, reason: "REJECTED" });
  });

  it("rejects titles that equal or contain a source message verbatim", () => {
    const messages = [{ text: "I want a hotel in Tokyo" }];
    expect(postprocessThreadTitle("I want a hotel in Tokyo", messages))
      .toEqual({ ok: false, reason: "REJECTED" });
    expect(postprocessThreadTitle("hotel", messages))
      .toEqual({ ok: false, reason: "REJECTED" });
  });

  it("accepts a clean, short, non-overlapping Chinese title", () => {
    expect(postprocessThreadTitle("东京行程规划", []))
      .toEqual({ ok: true, title: "东京行程规划" });
  });
});
