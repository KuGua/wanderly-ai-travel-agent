import { describe, expect, it } from "vitest";

import { completeClauseBoundary } from "../src/tasks/handlers/conversation-task-handler.js";

/**
 * Mirrors `SafeConversationDeltaGate.push`: the buffer grows one token at a
 * time and everything up to the last complete boundary is published. Testing
 * through this shape is what catches boundaries that only look correct on a
 * finished string.
 */
function publishedSegments(text: string): string[] {
  let pending = "";
  const segments: string[] = [];
  for (const character of text) {
    pending += character;
    let boundary = completeClauseBoundary(pending);
    while (boundary > 0) {
      segments.push(pending.slice(0, boundary));
      pending = pending.slice(boundary);
      boundary = completeClauseBoundary(pending);
    }
  }
  if (pending) segments.push(pending); // the gate's final flush()
  return segments;
}

describe("completeClauseBoundary", () => {
  it("splits a Chinese reply on clause punctuation, not only on sentence ends", () => {
    expect(publishedSegments("好的，我来帮你规划这次法国之旅。"))
      .toEqual(["好的，", "我来帮你规划这次法国之旅。"]);
  });

  it("breaks a long Chinese sentence into its clauses", () => {
    expect(publishedSegments("根据你的出发时间和预算，我建议先锁定往返航班，再看住宿；这样调整空间更大。"))
      .toEqual([
        "根据你的出发时间和预算，",
        "我建议先锁定往返航班，",
        "再看住宿；",
        "这样调整空间更大。",
      ]);
  });

  it("splits English clauses on punctuation followed by whitespace", () => {
    expect(publishedSegments("First, we book flights, then hotels. Costs about 3.5k."))
      .toEqual(["First, ", "we book flights, ", "then hotels. ", "Costs about 3.5k."]);
  });

  // The buffer end is not a boundary. It is reached after every single token,
  // so an end-of-text alternative would fire on the "," of "1,000" the moment
  // it arrived — before "000" existed to disprove it.
  it("never splits inside a number, a time, or a URL", () => {
    expect(publishedSegments("Budget is 1,000 USD at 10:30. See https://example.com/x for details."))
      .toEqual([
        "Budget is 1,000 USD at 10:30. ",
        "See https://example.com/x for details.",
      ]);
  });

  it("treats a newline as a boundary", () => {
    expect(publishedSegments("一\n二\n")).toEqual(["一\n", "二\n"]);
  });

  it("returns 0 when no clause has completed yet", () => {
    expect(completeClauseBoundary("巴黎是个不错的选择")).toBe(0);
    expect(completeClauseBoundary("Budget is 1,")).toBe(0);
  });

  it("leaves a reply with no punctuation for the final flush", () => {
    expect(publishedSegments("巴黎是个不错的选择")).toEqual(["巴黎是个不错的选择"]);
  });
});

/**
 * The tail after the last clause boundary must still reach the traveller.
 *
 * The gate publishes complete clauses and leaves the remainder for `flush()`,
 * which the handler calls only when the streamed text matches the reply it is
 * about to persist — that guard is what stops a withdrawn answer's tail being
 * streamed after a FALLBACK or a safe refusal replaced it.
 *
 * It compared raw bytes against a value the output schema had already run
 * `.trim()` over. A reply ending in a newline — most of them — failed that
 * comparison, so the flush never ran and everything after the last boundary
 * was dropped: 「太棒了，目的地锁定为东京，这意味着我们现在已经备齐了所有关键
 * 信息：从」 ended exactly at its last 「：」, mid-sentence, on screen.
 */
describe("streamed tail vs. the persisted reply", () => {
  /** What the handler's guard decides, given raw stream text and the parsed reply. */
  function flushes(rawText: string, parsedContent: string): boolean {
    return rawText.trim() === parsedContent;
  }

  it("flushes when the reply is the streamed text with schema trimming applied", () => {
    const raw = "目的地锁定为东京，这意味着我们已经备齐了所有关键信息：从成都出发。\n";
    expect(flushes(raw, raw.trim())).toBe(true);
  });

  it("flushes for a reply that ends without any trailing whitespace", () => {
    const raw = "好的，我们从东京开始";
    expect(flushes(raw, raw)).toBe(true);
  });

  it("does not flush when the answer was replaced wholesale", () => {
    // A FALLBACK or safe refusal: streaming the withdrawn tail would leave
    // half of an answer that is no longer being given.
    expect(flushes("你需要办理签证才能入境。\n", "这个我暂时没法在对话里给你一个靠得住的答案。")).toBe(false);
  });

  it("leaves a tail that only the flush can ship", () => {
    // Guards the premise. `publishedSegments` above already includes the
    // flush, so this walks the buffer without it: what the boundaries alone
    // publish stops at the last 「：」, and 「从」 exists only in the remainder.
    const reply = "目的地锁定为东京，这意味着我们已经备齐了所有关键信息：从";
    let pending = "";
    let published = "";
    for (const character of reply) {
      pending += character;
      let boundary = completeClauseBoundary(pending);
      while (boundary > 0) {
        published += pending.slice(0, boundary);
        pending = pending.slice(boundary);
        boundary = completeClauseBoundary(pending);
      }
    }

    expect(pending).toBe("从");
    expect(published).toBe("目的地锁定为东京，这意味着我们已经备齐了所有关键信息：");
  });
});
