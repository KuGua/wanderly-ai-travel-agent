import { describe, expect, it, vi } from "vitest";

import { resolveTitleDestinationLabel } from "../src/services/trip-title-destination-label.js";
import { getLocationReferenceResolver } from "../src/location-reference/location-reference-resolver.js";

vi.mock("../src/location-reference/location-reference-resolver.js", () => ({
  getLocationReferenceResolver: vi.fn(),
}));

const mockedResolver = vi.mocked(getLocationReferenceResolver);

type ResolverStub = {
  resolveDestinationReference: ReturnType<typeof vi.fn>;
  resolveCountryLabel: ReturnType<typeof vi.fn>;
};

function stubResolver(overrides: Partial<ResolverStub> = {}): void {
  const stub: ResolverStub = {
    resolveDestinationReference: vi.fn().mockReturnValue(null),
    resolveCountryLabel: vi.fn().mockReturnValue(null),
    ...overrides,
  };
  mockedResolver.mockReturnValue(stub as unknown as ReturnType<typeof getLocationReferenceResolver>);
}

describe("resolveTitleDestinationLabel", () => {
  it("returns the locale-appropriate country label", () => {
    stubResolver({
      resolveCountryLabel: vi.fn().mockReturnValue({ countryCode: "FR", nameEn: "France", nameZh: "法国" }),
    });
    expect(resolveTitleDestinationLabel({ candidate: "法国", locale: "zh" }))
      .toEqual({ label: "法国", source: "REFERENCE" });
    expect(resolveTitleDestinationLabel({ candidate: "France", locale: "en" }))
      .toEqual({ label: "France", source: "REFERENCE" });
  });

  it("falls back to the English name when the dataset has no Chinese entry", () => {
    stubResolver({
      resolveCountryLabel: vi.fn().mockReturnValue({ countryCode: "XX", nameEn: "Somewhere", nameZh: "" }),
    });
    expect(resolveTitleDestinationLabel({ candidate: "Somewhere", locale: "zh" }))
      .toEqual({ label: "Somewhere", source: "REFERENCE" });
  });

  it("declines a city — cities are planner destinations, not display labels", () => {
    const resolveCountryLabel = vi.fn();
    stubResolver({
      resolveDestinationReference: vi.fn().mockReturnValue({
        destinationId: "x", cityName: "Tokyo", countryCode: "JP", latitude: 0, longitude: 0,
      }),
      resolveCountryLabel,
    });
    expect(resolveTitleDestinationLabel({ candidate: "东京", locale: "zh" })).toBeNull();
    // The country branch must not even be consulted for a city.
    expect(resolveCountryLabel).not.toHaveBeenCalled();
  });

  it("returns null for a value that is neither a city nor a country", () => {
    stubResolver();
    expect(resolveTitleDestinationLabel({ candidate: "somewhere nice", locale: "en" })).toBeNull();
  });

  it("returns null instead of throwing when the reference dataset cannot load", () => {
    // The conversation handler calls this inline on the reply path, so an
    // unreadable dataset must decline the label rather than fail the turn.
    mockedResolver.mockImplementation(() => {
      throw new Error("ENOENT: cities5000.txt");
    });
    expect(() => resolveTitleDestinationLabel({ candidate: "法国", locale: "zh" })).not.toThrow();
    expect(resolveTitleDestinationLabel({ candidate: "法国", locale: "zh" })).toBeNull();
  });

  it("returns null when the resolver itself throws mid-lookup", () => {
    stubResolver({
      resolveDestinationReference: vi.fn().mockImplementation(() => {
        throw new Error("corrupt index");
      }),
    });
    expect(resolveTitleDestinationLabel({ candidate: "法国", locale: "zh" })).toBeNull();
  });
});
