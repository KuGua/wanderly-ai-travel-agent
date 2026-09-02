import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_PATTERN,
  confirmedCapabilityFrom,
  confirmedFor,
} from "../src/tasks/handlers/conversation-task-handler.js";

describe("what a confirmation authorises", () => {
  it("takes a named capability as authority for that search only", () => {
    // The flight card's button used to send the bare phrase, so the model
    // chose which search it meant — and in a thread that had also discussed
    // hotels the hotel readiness rule won. Pressing "search flights" ran a
    // hotel search against a stale Beijing draft.
    expect(confirmedCapabilityFrom("确认搜索机票")).toBe("flight.search");
    expect(confirmedFor("flight.search", true, "flight.search")).toBe(true);
    expect(confirmedFor("hotel.search", true, "flight.search")).toBe(false);
  });

  it("leaves an unnamed confirmation to the model, as it always has", () => {
    expect(confirmedCapabilityFrom("确认搜索")).toBeNull();
    expect(confirmedFor("hotel.search", true, null)).toBe(true);
    expect(confirmedFor("flight.search", true, null)).toBe(true);
  });

  it("authorises nothing at all without a confirmation", () => {
    expect(confirmedFor("flight.search", false, "flight.search")).toBe(false);
  });

  it("still reads a naked 确认 and a named one as confirmations", () => {
    for (const phrase of ["确认", "确认搜索", "确认搜索机票", "确认搜索酒店", "go ahead", "开始搜索"]) {
      expect(CONFIRMATION_PATTERN.test(phrase), phrase).toBe(true);
    }
  });

  it("does not read a question about confirming as one", () => {
    expect(CONFIRMATION_PATTERN.test("如何确认搜索条件")).toBe(false);
  });
});
