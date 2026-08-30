import { describe, expect, it } from "vitest";

import { actionForApiRequest, errorCategoryFor } from "./ui-diagnostics";
import { TravelApiError } from "@/lib/api/errors";

describe("safe UI diagnostic classification", () => {
  it("maps only known API routes to a bounded action name", () => {
    expect(actionForApiRequest("/threads/11111111-1111-4111-8111-111111111111/turns", "POST")).toBe("conversation.submit");
    expect(actionForApiRequest("/trips/11111111-1111-4111-8111-111111111111/activate", "POST")).toBe("trip.activate");
    expect(actionForApiRequest("/profiles/me", "GET")).toBeNull();
  });

  it("classifies failures without ever using the Error message", () => {
    expect(errorCategoryFor(new TravelApiError("passport P123; private prompt", 500, "Internal", null))).toBe("http_5xx");
    expect(errorCategoryFor(new TravelApiError("secret", null, "Network Error", null))).toBe("network");
  });
});
