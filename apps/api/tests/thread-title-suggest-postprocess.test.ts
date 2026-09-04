import { describe, expect, it } from "vitest";

import { postprocessThreadTitle } from "../src/services/thread-title-suggest-postprocess.js";

describe("thread title postprocessing", () => {
  it("trims and collapses whitespace", () => {
    expect(postprocessThreadTitle("  hello\t\tworld\n", []))
      .toEqual({ ok: true, title: "hello world" });
  });

  it("drops emoji and private-use-area code points", () => {
    expect(postprocessThreadTitle("Tokyo 🗼 tips \u{E0067}", []))
      .toEqual({ ok: true, title: "Tokyo tips" });
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
