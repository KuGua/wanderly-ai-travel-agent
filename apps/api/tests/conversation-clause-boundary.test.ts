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
