import { describe, expect, it } from "vitest";
import { FixtureFlightProvider } from "../src/providers/fixture-provider.js";
import { FIXTURE_CAPTURED_AT, FIXTURE_VERSION } from "../src/providers/fixtures.js";

const provider = new FixtureFlightProvider();

const baseSearch = {
  origin: "San Francisco",
  destination: "Tokyo",
  dateStart: "2025-08-01",
  dateEnd: "2025-08-07",
  snapshotId: "snapshot-test-001",
};

describe("FixtureFlightProvider", () => {
  it("returns normalized, labelled offers for a supported route and date range", async () => {
    const result = await provider.searchFlights(baseSearch);

    expect(FIXTURE_VERSION).toBe("2026-08-23.v1");
    expect(result).toMatchObject({
      outcome: "FALLBACK_DEMO",
      reason: "LIVE_PROVIDER_NOT_CONFIGURED",
      fixtureVersion: FIXTURE_VERSION,
    });
    if (result.outcome === "UNAVAILABLE") throw new Error("Expected fixture data");
    const offers = result.data;
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      id: "flt-sfo-tyo-01",
      origin: "San Francisco",
      destination: "Tokyo",
      source: "Demo data",
      capturedAt: FIXTURE_CAPTURED_AT,
      isDemo: true,
    });
    expect(offers.every(offer => offer.priceUsd > 0)).toBe(true);
  });

  it("returns identical results for repeated searches", async () => {
    const first = await provider.searchFlights(baseSearch);
    const second = await provider.searchFlights(baseSearch);

    expect(second).toEqual(first);
  });

  it("does not return offers outside the requested date range", async () => {
    const result = await provider.searchFlights({
      ...baseSearch,
      dateStart: "2025-08-02",
      dateEnd: "2025-08-07",
    });

    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "FIXTURE_NOT_FOUND" });
  });

  it("does not fabricate offers for an unsupported route", async () => {
    const result = await provider.searchFlights({
      ...baseSearch,
      destination: "Singapore",
    });

    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "FIXTURE_NOT_FOUND" });
  });
});
