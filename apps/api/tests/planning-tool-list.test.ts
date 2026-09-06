import { boundToolResult } from "../src/providers/llm-gateway.js";
import { describe, expect, it } from "vitest";
import {
  PlanningDataUnavailableError,
  planningToolsFor,
  summarizeProviderGaps,
  validateProviderCoverage,
} from "../src/services/planning-service.js";

describe("planning-service post-deprecation contracts", () => {
  it("summarizeProviderGaps no longer reports a navigation gap from a ground[] argument", () => {
    const result = summarizeProviderGaps({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stayEvidenceCount: 0,
    });
    expect(result.gaps.find((g) => g.capability === "navigation")).toBeUndefined();
  });

  it("summarizeProviderGaps emits flight and stay NO_RESULTS gaps when empty", () => {
    const result = summarizeProviderGaps({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stayEvidenceCount: 0,
    });
    const capabilities = result.gaps.map((g) => g.capability).sort();
    expect(capabilities).toEqual(["flight", "stay"]);
  });

  it("summarizeProviderGaps forwards unavailableCapabilities unchanged", () => {
    const result = summarizeProviderGaps({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stayEvidenceCount: 0,
      unavailableCapabilities: [
        { capability: "navigation", code: "NOT_CONFIGURED" },
        { capability: "mobility", code: "PROVIDER_NOT_APPROVED" },
      ],
    });
    const codes = result.gaps.filter((g) => g.capability === "navigation" || g.capability === "mobility");
    expect(codes).toContainEqual({ capability: "navigation", code: "NOT_CONFIGURED" });
    expect(codes).toContainEqual({ capability: "mobility", code: "PROVIDER_NOT_APPROVED" });
  });

  /**
   * Zero flights is the whole capability being unavailable — a supplier
   * outage, a refused request, a city with no controlled airport. As of
   * 2026-09-05 that is a gap on the plan rather than grounds for withholding
   * it, so this must NOT throw: the run still has whatever else came back
   * live, and one refused flight request used to take all of it away.
   */
  /**
   * `allStays` had exactly one producer: a `StayProvider` stub that always
   * returned NOT_CONFIGURED. So this gap fired on every run ever made,
   * including runs holding ten live Nuitee quotes and sixteen discovered
   * stays — the screen said "no accommodation found" over a database that had
   * plenty. Stay status is evidence now, not a stubbed provider's silence.
   */
  it("reports a stay gap from real evidence, not from a stubbed provider", () => {
    const withEvidence = summarizeProviderGaps({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stayEvidenceCount: 10,
    });
    expect(withEvidence.gaps.find((g) => g.capability === "stay")).toBeUndefined();

    const without = summarizeProviderGaps({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stayEvidenceCount: 0,
    });
    expect(without.gaps).toContainEqual({ capability: "stay", code: "NO_RESULTS" });
  });

  /**
   * A supplier that answered in a shape we could not read is not a route with
   * no flights. Flattening every flight failure to NO_RESULTS told the
   * traveller "no verified results" for a route that has plenty, and threw
   * away the only lead for whoever debugs it next.
   */
  it("keeps the supplier's own reason instead of flattening it to NO_RESULTS", () => {
    const result = summarizeProviderGaps({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stayEvidenceCount: 1,
      flightFailureCode: "INVALID_PROVIDER_RESPONSE",
    });
    expect(result.gaps).toContainEqual({ capability: "flight", code: "INVALID_PROVIDER_RESPONSE" });

    const unknown = summarizeProviderGaps({
      requiredOrigins: ["Shanghai"],
      flights: [],
      stayEvidenceCount: 1,
    });
    expect(unknown.gaps).toContainEqual({ capability: "flight", code: "NO_RESULTS" });
  });

  it("validateProviderCoverage lets an entirely unavailable flight capability through", () => {
    expect(() => validateProviderCoverage({
      requiredOrigins: ["Shanghai"],
      flights: [],
    })).not.toThrow();
  });

  /**
   * Some flights but an uncovered origin is a different statement: the plan
   * would tell one member there is a way to get there and another nothing.
   * That stays a hard refusal.
   */
  it("validateProviderCoverage still throws when one origin of several is unsatisfied", () => {
    expect(() => validateProviderCoverage({
      requiredOrigins: ["Shanghai", "Singapore"],
      flights: [flightFrom("Shanghai")],
    })).toThrow(PlanningDataUnavailableError);
  });

  it("validateProviderCoverage passes when every required origin is covered", () => {
    expect(() => validateProviderCoverage({
      requiredOrigins: ["Shanghai"],
      flights: [flightFrom("Shanghai")],
    })).not.toThrow();
  });
});

function flightFrom(origin: string) {
  return {
    id: `f-${origin}`,
    providerOfferId: `p-${origin}`,
    providerName: "test",
    queryId: "00000000-0000-4000-8000-000000000001",
    origin,
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
  };
}
/**
 * Every tool result stays in the conversation for the rest of the loop, so the
 * request grows with each call. A few provider lists pushed it past the
 * model's input limit, which came back as a 429 — reported, before the
 * classifier was fixed, as a provider outage.
 */
/**
 * The orchestrator researches accommodation, activities, places and hotels
 * before synthesis, and each of those services reserves a
 * `provider_search_runs` row per run. Offering their tools again did not give
 * the model a second chance — it gave it a POLICY_DENIED in under a
 * millisecond, three of them in the opening turn, which read as three fresh
 * failures worth retrying.
 */
describe("planningToolsFor", () => {
  const tools = [
    { name: "flight.search", description: "", parameters: {} },
    { name: "accommodation.discover", description: "", parameters: {} },
    { name: "activities.search", description: "", parameters: {} },
    { name: "places.search", description: "", parameters: {} },
    { name: "places.adopt", description: "", parameters: {} },
    { name: "hotel.search", description: "", parameters: {} },
  ];

  it("withdraws the one-shot search tools whose capability already ran", () => {
    const offered = planningToolsFor(["accommodation", "activities", "hotel"], tools).map((t) => t.name);
    expect(offered).not.toContain("accommodation.discover");
    expect(offered).not.toContain("activities.search");
    expect(offered).not.toContain("hotel.search");
    // Not researched, so still on offer.
    expect(offered).toContain("places.search");
    expect(offered).toContain("flight.search");
  });

  /**
   * Coverage research fans out over the whole canonical route matrix before
   * synthesis and hands the offers forward, so leaving the flight tool on
   * offer bought the same searches twice — the run that finally produced a
   * plan paid SerpApi for `SIN→PVG` and `SIN→SHA` a second time.
   */
  it("withdraws flight.search once coverage has run the matrix", () => {
    const offered = planningToolsFor(["flight"], tools).map((t) => t.name);
    expect(offered).not.toContain("flight.search");
  });

  it("can withdraw everything — a fully researched round only composes", () => {
    const offered = planningToolsFor(
      ["flight", "accommodation", "activities", "hotel", "places"],
      tools.filter((t) => t.name !== "places.adopt"),
    );
    expect(offered).toEqual([]);
  });

  it("keeps write tools, which are not one-shot searches", () => {
    const offered = planningToolsFor(["places"], tools).map((t) => t.name);
    expect(offered).not.toContain("places.search");
    expect(offered).toContain("places.adopt");
  });

  it("offers everything when nothing has run yet", () => {
    expect(planningToolsFor([], tools)).toHaveLength(tools.length);
  });
});

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
