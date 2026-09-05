import { describe, expect, it } from "vitest";

import { HOTEL_OFFER_CUE_SYSTEM_PROMPT } from "../src/providers/llm-gateway.js";

describe("Hotel Offer Cue prompt", () => {
  it("uses hotel-specific fields, examples, and disambiguation semantics", () => {
    expect(HOTEL_OFFER_CUE_SYSTEM_PROMPT).toContain("propertyName");
    expect(HOTEL_OFFER_CUE_SYSTEM_PROMPT).toContain("stayKey");
    expect(HOTEL_OFFER_CUE_SYSTEM_PROMPT).toContain("有早餐吗?");
    expect(HOTEL_OFFER_CUE_SYSTEM_PROMPT).not.toContain("routeKey");
    expect(HOTEL_OFFER_CUE_SYSTEM_PROMPT).not.toContain("CA1234");
  });
});
