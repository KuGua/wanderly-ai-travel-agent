import { describe, expect, it } from "vitest";
import { LocationReferenceResolver } from "../src/location-reference/location-reference-resolver.js";

const resolver = new LocationReferenceResolver([
  {
    properties: { ADMIN: "Testland", ISO_A2: "TL" },
    geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
  },
], [
  { name: "Example City", countryCode: "TL", latitude: 5, longitude: 5 },
], [
  {
    properties: { name: "Test Province", iso_3166_2: "TL-TP", iso_a2: "TL" },
    geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
  },
], { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" });

describe("LocationReferenceResolver", () => {
  it("returns a country and nearby city as a non-travel reference", () => {
    expect(resolver.resolve(5, 5)).toEqual({
      outcome: "REFERENCE",
      country: "Testland",
      countryCode: "TL",
      admin1: "Test Province",
      admin1Code: "TL-TP",
      nearestCity: "Example City",
      nearestCityCoordinates: { latitude: 5, longitude: 5 },
      distanceKm: 0,
      source: "Natural Earth + GeoNames",
      datasetVersion: "test.1",
      checkedAt: "2026-08-25T00:00:00.000Z",
      isTravelFact: false,
    });
  });

  it("resolves a city label into a provider-safe destination reference", () => {
    expect(resolver.resolveDestinationReference({
      destinationId: "candidate-1",
      cityName: "Example City",
      countryHint: "TL",
    })).toEqual({
      destinationId: "candidate-1",
      cityName: "Example City",
      countryCode: "TL",
      latitude: 5,
      longitude: 5,
    });
  });

  it("recognises a country label without treating it as a city", () => {
    expect(resolver.isKnownCountryName("Testland")).toBe(true);
    expect(resolver.resolveDestinationReference({
      destinationId: "testland", cityName: "Testland",
    })).toBeNull();
  });

  it("fails closed when a city label is ambiguous across countries", () => {
    const ambiguous = new LocationReferenceResolver([
      { properties: { ADMIN: "One", ISO_A2: "AA" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } },
      { properties: { ADMIN: "Two", ISO_A2: "BB" }, geometry: { type: "Polygon", coordinates: [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]] } },
    ], [
      { name: "Springfield", countryCode: "AA", latitude: 0.5, longitude: 0.5 },
      { name: "Springfield", countryCode: "BB", latitude: 0.5, longitude: 2.5 },
    ], [], { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" });
    expect(ambiguous.resolveDestinationReference({ destinationId: "springfield", cityName: "Springfield" })).toBeNull();
    expect(ambiguous.resolveDestinationReference({
      destinationId: "springfield-aa", cityName: "Springfield", countryHint: "AA",
    })).toMatchObject({ countryCode: "AA", longitude: 0.5 });
  });

  it("does not fabricate a city when the closest indexed city is too distant", () => {
    const reference = resolver.resolve(0.1, 0.1);
    expect(reference).toMatchObject({
      outcome: "REFERENCE",
      country: "Testland",
      nearestCity: null,
      nearestCityCoordinates: null,
      distanceKm: null,
    });
  });

  it("returns no reference for a coordinate outside a country boundary", () => {
    expect(resolver.resolve(-5, -5)).toMatchObject({ outcome: "NO_REFERENCE", isTravelFact: false });
  });

  it("falls back to the nearest coast for offshore land the dataset omits", () => {
    // 1 km south of the polygon edge: an islet Natural Earth Admin 0 does not carry.
    expect(resolver.resolve(-0.009, 5)).toMatchObject({
      outcome: "REFERENCE",
      country: "Testland",
      countryCode: "TL",
      nearestCity: null,
    });
  });

  it("returns no reference beyond the coastal tolerance", () => {
    // ~22 km south of the polygon edge: open water, not omitted land.
    expect(resolver.resolve(-0.2, 5)).toMatchObject({ outcome: "NO_REFERENCE", isTravelFact: false });
  });

  it("projects districts and neighborhoods to city level without collapsing distinct cities", () => {
    const chinaResolver = new LocationReferenceResolver([
      {
        properties: { ADMIN: "China", ISO_A2: "CN" },
        geometry: { type: "Polygon", coordinates: [[[115, 28], [125, 28], [125, 34], [115, 34], [115, 28]]] },
      },
    ], [
      { name: "Shanghai", countryCode: "CN", latitude: 31.22222, longitude: 121.45806, featureCode: "PPLA", admin1Code: "23", admin2Code: "12324204" },
      { name: "Huangpu", countryCode: "CN", latitude: 31.23359, longitude: 121.479, featureCode: "PPL", admin1Code: "23", admin2Code: "12324204" },
      { name: "Pudong", countryCode: "CN", latitude: 31.23969, longitude: 121.49976, featureCode: "PPLA4", admin1Code: "23", admin2Code: "12324204" },
      { name: "Chongming", countryCode: "CN", latitude: 31.6229, longitude: 121.3972, featureCode: "PPLA3" },
      { name: "Luojing", countryCode: "CN", latitude: 31.4782, longitude: 121.33907, featureCode: "PPL", admin1Code: "23" },
      { name: "Nanjing", countryCode: "CN", latitude: 32.06167, longitude: 118.77778, featureCode: "PPLA", admin1Code: "04", admin2Code: "3201" },
      { name: "Suzhou", countryCode: "CN", latitude: 31.30408, longitude: 120.59538, featureCode: "PPLA2", admin1Code: "04", admin2Code: "3205" },
    ], [], { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" });

    expect(chinaResolver.resolve(31.23359, 121.479)).toMatchObject({
      nearestCity: "Shanghai",
      nearestCityCoordinates: { latitude: 31.22222, longitude: 121.45806 },
    });
    expect(chinaResolver.resolve(31.6229, 121.3972)).toMatchObject({ nearestCity: "Shanghai" });
    expect(chinaResolver.resolve(31.30408, 120.59538)).toMatchObject({ nearestCity: "Suzhou" });
  });


  it("answers in the reader's language where the dataset has one", () => {
    // The map tiles were already labelling 内蒙古自治区 while the reference
    // beside the pin read "Inner Mongol · China": the names were in the data
    // all along, indexed for alias lookup and never returned.
    const bilingual = new LocationReferenceResolver([
      {
        properties: { ADMIN: "China", ISO_A2: "CN", NAME_EN: "China", NAME_ZH: "中华人民共和国" },
        geometry: { type: "Polygon", coordinates: [[[100, 30], [120, 30], [120, 50], [100, 50], [100, 30]]] },
      },
    ], [], [
      {
        properties: { name: "Inner Mongol", name_zh: "内蒙古自治区", iso_3166_2: "CN-NM", iso_a2: "CN" },
        geometry: { type: "Polygon", coordinates: [[[105, 38], [115, 38], [115, 45], [105, 45], [105, 38]]] },
      },
    ], { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" });

    expect(bilingual.resolve(41, 110)).toMatchObject({ admin1: "Inner Mongol", country: "China" });
    expect(bilingual.resolve(41, 110, "zh")).toMatchObject({ admin1: "内蒙古自治区", country: "中华人民共和国" });
    // Region locales count as Chinese; anything else keeps the English names.
    expect(bilingual.resolve(41, 110, "zh-CN")).toMatchObject({ admin1: "内蒙古自治区" });
    expect(bilingual.resolve(41, 110, "fr")).toMatchObject({ admin1: "Inner Mongol", country: "China" });
  });

  it("keeps the English name when the dataset carries no translation", () => {
    // Falling through to an empty label would be worse than an English one.
    const partial = new LocationReferenceResolver([
      {
        properties: { ADMIN: "Testland", ISO_A2: "TL" },
        geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
      },
    ], [], [
      {
        properties: { name: "North Province", iso_3166_2: "TL-N", iso_a2: "TL" },
        geometry: { type: "Polygon", coordinates: [[[1, 1], [9, 1], [9, 9], [1, 9], [1, 1]]] },
      },
    ], { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" });

    expect(partial.resolve(5, 5, "zh")).toMatchObject({ admin1: "North Province", country: "Testland" });
  });

});

describe("LocationReferenceResolver population-dominance rule", () => {
  // Helper: a resolver with the named candidate city present in each
  // country at the given populations. Only the matching "Shared" name
  // is indexed; other cities are deliberately omitted to keep the
  // test focused on the dominance rule.
  function buildResolver(countries: Array<{ code: string; name: string }>, populations: Record<string, number>) {
    return new LocationReferenceResolver(
      countries.map(({ code, name }) => ({
        properties: { ADMIN: name, ISO_A2: code },
        geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      })),
      countries.map(({ code }) => ({
        name: "Shared",
        countryCode: code,
        latitude: 0.5,
        longitude: 0.5,
        population: populations[code] ?? 0,
      })),
      [],
      { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" },
    );
  }

  it("resolves Paris-style dominance (FR 2.1M vs ZA 71k)", () => {
    const resolver = buildResolver(
      [{ code: "FR", name: "France" }, { code: "ZA", name: "South Africa" }],
      { FR: 2_138_551, ZA: 71_319 },
    );
    const ref = resolver.resolveDestinationReference({ destinationId: "paris", cityName: "Shared" });
    expect(ref).toMatchObject({ countryCode: "FR", cityName: "Shared" });
  });

  it("resolves Athens-style dominance (GR 664k vs US 127k, ratio ~5.2)", () => {
    const resolver = buildResolver(
      [{ code: "GR", name: "Greece" }, { code: "US", name: "United States" }],
      { GR: 664_046, US: 127_315 },
    );
    const ref = resolver.resolveDestinationReference({ destinationId: "athens", cityName: "Shared" });
    expect(ref?.countryCode).toBe("GR");
  });

  it("rejects Valencia-style near-tie (VE 1.6M vs ES 824k, ratio ~2)", () => {
    const resolver = buildResolver(
      [{ code: "VE", name: "Venezuela" }, { code: "ES", name: "Spain" }],
      { VE: 1_619_470, ES: 824_340 },
    );
    expect(resolver.resolveDestinationReference({ destinationId: "valencia", cityName: "Shared" })).toBeNull();
  });

  it("rejects Barcelona-style (close populations, ratio well below 5)", () => {
    const resolver = buildResolver(
      [{ code: "ES", name: "Spain" }, { code: "CU", name: "Cuba" }],
      { ES: 1_615_448, CU: 72_466 },
    );
    // 22x dominance — actually resolves. Use a closer case to assert the rule:
    const closer = buildResolver(
      [{ code: "ES", name: "Spain" }, { code: "CU", name: "Cuba" }],
      { ES: 1_615_448, CU: 350_000 }, // ratio 4.6
    );
    expect(closer.resolveDestinationReference({ destinationId: "barcelona", cityName: "Shared" })).toBeNull();
    expect(resolver.resolveDestinationReference({ destinationId: "barcelona", cityName: "Shared" })?.countryCode).toBe("ES");
  });

  it("boundary: ratio exactly 5 resolves, ratio 4.99 does not", () => {
    const resolvesAt5 = buildResolver(
      [{ code: "A1", name: "Country A" }, { code: "B1", name: "Country B" }],
      { A1: 5_000_000, B1: 1_000_000 },
    );
    expect(resolvesAt5.resolveDestinationReference({ destinationId: "x", cityName: "Shared" })?.countryCode).toBe("A1");

    const rejectsAt4_99 = buildResolver(
      [{ code: "A2", name: "Country A" }, { code: "B2", name: "Country B" }],
      { A2: 4_990_000, B2: 1_000_000 },
    );
    expect(rejectsAt4_99.resolveDestinationReference({ destinationId: "x", cityName: "Shared" })).toBeNull();
  });

  it("falls back to highest population when a single country owns all matches", () => {
    // Two Springfield rows in the SAME country should resolve to the
    // higher-population row, matching pre-fix behavior.
    const resolver = new LocationReferenceResolver(
      [{ properties: { ADMIN: "One", ISO_A2: "AA" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }],
      [
        { name: "Springfield", countryCode: "AA", latitude: 0.5, longitude: 0.5, population: 50_000 },
        { name: "Springfield", countryCode: "AA", latitude: 0.6, longitude: 0.5, population: 200_000 },
      ],
      [],
      { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" },
    );
    const ref = resolver.resolveDestinationReference({ destinationId: "x", cityName: "Springfield" });
    expect(ref).toMatchObject({ countryCode: "AA", latitude: 0.6 });
  });
});

describe("LocationReferenceResolver.resolveCountryLabel", () => {
  const resolver = new LocationReferenceResolver(
    [
      {
        properties: { ADMIN: "France", ISO_A2: "FR", NAME_EN: "France", NAME_ZH: "法国" },
        geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      },
      {
        // Sparse Chinese label — must fall back to the English one when the
        // caller asks for zh.
        properties: { ADMIN: "Testland", ISO_A2: "TL", NAME_EN: "Testland", NAME_ZH: "" },
        geometry: { type: "Polygon", coordinates: [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]] },
      },
    ],
    [],
    [],
    { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" },
  );

  it("returns the bilingual label for a country known by any alias", () => {
    expect(resolver.resolveCountryLabel("France")).toEqual({ countryCode: "FR", nameEn: "France", nameZh: "法国" });
    expect(resolver.resolveCountryLabel("法国")).toEqual({ countryCode: "FR", nameEn: "France", nameZh: "法国" });
    expect(resolver.resolveCountryLabel("FR")).toEqual({ countryCode: "FR", nameEn: "France", nameZh: "法国" });
  });

  it("falls back to ADMIN when NAME_EN is absent (mirror resolve())", () => {
    const fallback = new LocationReferenceResolver(
      [
        {
          properties: { ADMIN: "Fallbackland", ISO_A2: "FB" },
          geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
        },
      ],
      [],
      [],
      { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" },
    );
    expect(fallback.resolveCountryLabel("Fallbackland")).toEqual({
      countryCode: "FB", nameEn: "Fallbackland", nameZh: "",
    });
  });

  it("returns null for a name that is neither a country nor a city", () => {
    expect(resolver.resolveCountryLabel("Atlantis")).toBeNull();
  });

  it("separates cleanly from resolveDestinationReference (countries never feed the planner)", () => {
    // "France" must NOT be resolvable as a destination.
    expect(resolver.resolveDestinationReference({ destinationId: "france", cityName: "France" })).toBeNull();
    expect(resolver.resolveCountryLabel("France")?.countryCode).toBe("FR");
  });
});

describe("LocationReferenceResolver principal-country selection (LABELRANK)", () => {
  // Natural Earth Admin 0 ships overseas territories with the same ISO_A2
  // as their parent country (Clipperton Island / FR, Puerto Rico / US).
  // The resolver must pick the principal country by LABELRANK so a
  // user-typed "France" resolves to "France" rather than the territory.
  it("selects the principal country when ISO_A2 is shared with a territory", () => {
    const resolver = new LocationReferenceResolver(
      [
        // Order is intentionally territory-first to make LAST-WINS
        // collisions fail loudly if the LABELRANK guard is removed.
        {
          properties: {
            ADMIN: "Clipperton Island", ISO_A2: "FR", ADM0_A3: "CLP",
            NAME_EN: "Clipperton Island", LABELRANK: 5,
          },
          geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
        },
        {
          properties: {
            ADMIN: "France", ISO_A2: "FR", ADM0_A3: "FRA",
            NAME_EN: "France", NAME_ZH: "法国", LABELRANK: 2,
          },
          geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
        },
      ],
      [],
      [],
      { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" },
    );
    expect(resolver.resolveCountryLabel("France")).toEqual({
      countryCode: "FR", nameEn: "France", nameZh: "法国",
    });
    expect(resolver.resolveCountryLabel("法国")).toEqual({
      countryCode: "FR", nameEn: "France", nameZh: "法国",
    });
  });
});

describe("LocationReferenceResolver country vs city disambiguation in alternateNames", () => {
  // Spec §6.2(a): "alternateNames 索引必须继续包含 — 中文名 `东京`/`巴黎`
  // 仅存在于该列". This test pins that policy.
  it("resolves Chinese city names indexed via alternateNames only", () => {
    const resolver = new LocationReferenceResolver(
      [{ properties: { ADMIN: "Japan", ISO_A2: "JP" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }],
      [{ name: "Tokyo", alternateNames: ["東京", "东京"], countryCode: "JP", latitude: 0.5, longitude: 0.5, population: 13_960_000 }],
      [],
      { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" },
    );
    expect(resolver.resolveDestinationReference({ destinationId: "tokyo", cityName: "东京" })).toMatchObject({
      countryCode: "JP", cityName: "Tokyo",
    });
    expect(resolver.resolveDestinationReference({ destinationId: "tokyo2", cityName: "東京" })).toMatchObject({
      countryCode: "JP", cityName: "Tokyo",
    });
    // And the Chinese name is NOT misread as a country.
    expect(resolver.resolveCountryLabel("东京")).toBeNull();
  });

  it("projects a localized display label without changing the canonical destination", () => {
    const resolver = new LocationReferenceResolver(
      [{ properties: { ADMIN: "China", ISO_A2: "CN" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }],
      [{
        name: "Shanghai",
        alternateNames: ["Shanghai City", "上海", "上海市", "中国上海", "沪"],
        countryCode: "CN",
        latitude: 0.5,
        longitude: 0.5,
        population: 24_874_500,
      }],
      [],
      { version: "test.1", checkedAt: "2026-08-25T00:00:00.000Z" },
    );

    expect(resolver.resolveDestinationLabels({ cityName: "上海", countryHint: "CN" })).toEqual({
      nameEn: "Shanghai",
      nameZh: "上海",
    });
    expect(resolver.resolveDestinationReference({ destinationId: "shanghai", cityName: "上海" })?.cityName)
      .toBe("Shanghai");
  });
});
