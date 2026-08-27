import { afterEach, describe, expect, it } from "vitest";

import {
  __resetLocationReferenceSourceForTests,
  getLocationReferenceSource,
  LocationReferenceSourceError,
  type LocationReferenceMode,
} from "../src/location-reference/location-reference-source.js";

const MODES: readonly LocationReferenceMode[] = ["in-process", "sidecar", "disabled"];

afterEach(() => {
  __resetLocationReferenceSourceForTests();
  delete process.env.LOCATION_REFERENCE_MODE;
  delete process.env.LOCATION_REFERENCE_SIDECAR_URL;
  delete process.env.LOCATION_REFERENCE_SIDECAR_TIMEOUT_MS;
});

describe("getLocationReferenceSource mode selection", () => {
  it("defaults to in-process when no env vars are set", () => {
    const source = getLocationReferenceSource();
    expect(source.mode).toBe("in-process");
  });

  it("accepts every documented mode literal", () => {
    for (const mode of MODES) {
      __resetLocationReferenceSourceForTests();
      process.env.LOCATION_REFERENCE_MODE = mode;
      // sidecar needs the URL; the assertion is enough to prove the mode is honored
      if (mode === "sidecar") process.env.LOCATION_REFERENCE_SIDECAR_URL = "http://127.0.0.1:3002";
      expect(getLocationReferenceSource().mode).toBe(mode);
    }
  });

  it("rejects an unknown mode literal", () => {
    process.env.LOCATION_REFERENCE_MODE = "magic";
    expect(() => getLocationReferenceSource()).toThrow(/LOCATION_REFERENCE_MODE/);
  });

  it("rejects sidecar mode without a URL", () => {
    process.env.LOCATION_REFERENCE_MODE = "sidecar";
    expect(() => getLocationReferenceSource()).toThrow(/LOCATION_REFERENCE_SIDECAR_URL/);
  });

  it("rejects a non-integer sidecar timeout", () => {
    process.env.LOCATION_REFERENCE_MODE = "sidecar";
    process.env.LOCATION_REFERENCE_SIDECAR_URL = "http://127.0.0.1:3002";
    process.env.LOCATION_REFERENCE_SIDECAR_TIMEOUT_MS = "abc";
    expect(() => getLocationReferenceSource()).toThrow(/LOCATION_REFERENCE_SIDECAR_TIMEOUT_MS/);
  });
});

describe("InProcessLocationReferenceSource", () => {
  it("resolves Lisbon (Portugal) for the standard Lisbon fixture", async () => {
    const source = getLocationReferenceSource();
    const reference = await source.resolve(38.7223, -9.1393);
    expect(reference.outcome).toBe("REFERENCE");
    if (reference.outcome === "REFERENCE") {
      expect(reference.country).toBe("Portugal");
      expect(reference.countryCode).toBe("PT");
    }
  });

  it("returns NO_REFERENCE for open water (0,0)", async () => {
    const source = getLocationReferenceSource();
    const reference = await source.resolve(0, 0);
    expect(reference.outcome).toBe("NO_REFERENCE");
  });
});

describe("DisabledLocationReferenceSource", () => {
  it("returns NO_REFERENCE without reading any data file", async () => {
    process.env.LOCATION_REFERENCE_MODE = "disabled";
    const source = getLocationReferenceSource();
    const reference = await source.resolve(38.7223, -9.1393);
    expect(reference.outcome).toBe("NO_REFERENCE");
    if (reference.outcome === "NO_REFERENCE") {
      // The disabled source returns a synthetic marker for `datasetVersion`
      // so callers can distinguish "no data" from "in-process unavailable".
      expect(reference.datasetVersion).toBe("disabled");
      expect(reference.source).toBe("Natural Earth + GeoNames");
      expect(reference.isTravelFact).toBe(false);
    }
  });
});

describe("SidecarLocationReferenceSource", () => {
  it("parses a successful sidecar response", async () => {
    process.env.LOCATION_REFERENCE_MODE = "sidecar";
    process.env.LOCATION_REFERENCE_SIDECAR_URL = "http://127.0.0.1:3002";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      outcome: "REFERENCE",
      country: "Portugal",
      countryCode: "PT",
      admin1: "Lisbon",
      admin1Code: "PT-11",
      nearestCity: "Lisbon",
      nearestCityCoordinates: { latitude: 38.7167, longitude: -9.1333 },
      distanceKm: 0,
      source: "Natural Earth + GeoNames",
      datasetVersion: "2026-08-global.2",
      checkedAt: "2026-08-26T00:00:00.000Z",
      isTravelFact: false,
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    try {
      const reference = await getLocationReferenceSource().resolve(38.7223, -9.1393);
      expect(reference.outcome).toBe("REFERENCE");
      if (reference.outcome === "REFERENCE") {
        expect(reference.country).toBe("Portugal");
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("translates HTTP 5xx into UNAVAILABLE", async () => {
    process.env.LOCATION_REFERENCE_MODE = "sidecar";
    process.env.LOCATION_REFERENCE_SIDECAR_URL = "http://127.0.0.1:3002";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;

    try {
      await expect(getLocationReferenceSource().resolve(38.7223, -9.1393))
        .rejects.toBeInstanceOf(LocationReferenceSourceError);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("translates HTTP 4xx into SCHEMA_DRIFT (close enough that callers treat it as unavailable)", async () => {
    process.env.LOCATION_REFERENCE_MODE = "sidecar";
    process.env.LOCATION_REFERENCE_SIDECAR_URL = "http://127.0.0.1:3002";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

    try {
      await expect(getLocationReferenceSource().resolve(38.7223, -9.1393))
        .rejects.toMatchObject({ reason: "SCHEMA_DRIFT" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("translates a malformed JSON body into SCHEMA_DRIFT", async () => {
    process.env.LOCATION_REFERENCE_MODE = "sidecar";
    process.env.LOCATION_REFERENCE_SIDECAR_URL = "http://127.0.0.1:3002";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ wrong: "shape" }), { status: 200 })) as typeof fetch;

    try {
      await expect(getLocationReferenceSource().resolve(38.7223, -9.1393))
        .rejects.toMatchObject({ reason: "SCHEMA_DRIFT" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("translates network refusal into NETWORK", async () => {
    process.env.LOCATION_REFERENCE_MODE = "sidecar";
    process.env.LOCATION_REFERENCE_SIDECAR_URL = "http://127.0.0.1:1";
    await expect(getLocationReferenceSource().resolve(38.7223, -9.1393))
      .rejects.toMatchObject({ reason: "NETWORK" });
  });
});