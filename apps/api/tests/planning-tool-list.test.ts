import { boundToolResult } from "../src/providers/llm-gateway.js";
import { describe, expect, it } from "vitest";
import {
  PlanningDataUnavailableError,
  summarizeProviderGaps,
  validateProviderCoverage,
} from "../src/services/planning-service.js";

describe("planning-service post-deprecation contracts", () => {
  it("summarizeProviderGaps no longer reports a navigation gap from a ground[] argument", () => {
    const result = summarizeProviderGaps({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stays: [],
    });
    expect(result.gaps.find((g) => g.capability === "navigation")).toBeUndefined();
  });

  it("summarizeProviderGaps emits flight and stay NO_RESULTS gaps when empty", () => {
    const result = summarizeProviderGaps({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stays: [],
    });
    const capabilities = result.gaps.map((g) => g.capability).sort();
    expect(capabilities).toEqual(["flight", "stay"]);
  });

  it("summarizeProviderGaps forwards unavailableCapabilities unchanged", () => {
    const result = summarizeProviderGaps({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stays: [],
      unavailableCapabilities: [
        { capability: "navigation", code: "NOT_CONFIGURED" },
        { capability: "mobility", code: "PROVIDER_NOT_APPROVED" },
      ],
    });
    const codes = result.gaps.filter((g) => g.capability === "navigation" || g.capability === "mobility");
    expect(codes).toContainEqual({ capability: "navigation", code: "NOT_CONFIGURED" });
    expect(codes).toContainEqual({ capability: "mobility", code: "PROVIDER_NOT_APPROVED" });
  });

  it("validateProviderCoverage throws PlanningDataUnavailableError when an origin is unsatisfied", () => {
    expect(() => validateProviderCoverage({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stays: [],
    })).toThrow(PlanningDataUnavailableError);
  });

  it("validateProviderCoverage passes when every required origin is covered", () => {
    expect(() => validateProviderCoverage({
      requiredOrigins: ["Shanghai"],
      flights: [{
        id: "f1",
        providerOfferId: "p1",
        providerName: "test",
        queryId: "00000000-0000-4000-8000-000000000001",
        origin: "Shanghai",
        destination: "Tokyo",
        segments: [],
        totalDuration: "PT10H",
        totalPrice: 100,
        currency: "USD",
        cabin: "ECONOMY" as const,
        adults: 1,
        baggageSummary: null,
        changeSummary: null,
        source: "test",
        capturedAt: "2026-08-23T00:00:00.000Z",
        expiresAt: "2026-08-24T00:00:00.000Z",
      }],
      stays: [],
    })).not.toThrow();
  });
});
/**
 * Every tool result stays in the conversation for the rest of the loop, so the
 * request grows with each call. A few provider lists pushed it past the
 * model's input limit, which came back as a 429 — reported, before the
 * classifier was fixed, as a provider outage.
 */
describe("boundToolResult", () => {
  it("keeps a small result exactly as it was", () => {
    const result = { outcome: "LIVE", offers: [{ id: "a" }, { id: "b" }] };
    expect(JSON.parse(boundToolResult(result))).toEqual(result);
  });

  it("truncates a long list and says how many were dropped", () => {
    const offers = Array.from({ length: 40 }, (_, i) => ({ id: `offer-${i}` }));
    const bounded = JSON.parse(boundToolResult({ outcome: "LIVE", offers })) as {
      offers: unknown[];
    };
    expect(bounded.offers).toHaveLength(6);
    expect(bounded.offers.at(-1)).toBe("…and 35 more (kept server-side)");
  });

  it("caps a single very long string rather than shipping the whole thing", () => {
    const bounded = boundToolResult({ description: "x".repeat(5000) });
    expect(bounded.length).toBeLessThan(1000);
    expect(bounded).toContain("…");
  });

  it("stays under the character budget for a large nested result", () => {
    const huge = {
      outcome: "LIVE",
      places: Array.from({ length: 200 }, (_, i) => ({
        id: `p-${i}`, name: "n".repeat(200), blurb: "b".repeat(500),
      })),
    };
    expect(boundToolResult(huge).length).toBeLessThanOrEqual(4100);
  });
});
