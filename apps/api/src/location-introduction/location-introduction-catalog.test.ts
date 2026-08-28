import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLocationIntroductionDatasetVersion,
  resolveLocationIntroductionCatalogEntry,
  __resetLocationIntroductionCatalogForTests,
  LocationIntroductionUnsupportedPlaceError,
} from "./location-introduction-catalog.js";

const FIXTURE = {
  $schemaVersion: "test-1",
  datasetVersion: "test-fixture-v1",
  entries: [
    {
      sourceId: "tokyo",
      canonicalPlaceId: "tokyo-jp",
      name: "Tokyo",
      country: "Japan",
      countryCode: "JP",
      admin1: "Tokyo",
      admin1Code: "JP-13",
      nearestCity: "Tokyo",
      nearestCityCoordinates: { longitude: 139.6917, latitude: 35.6895 },
    },
    {
      sourceId: "paris",
      canonicalPlaceId: "paris-fr",
      name: "Paris",
      country: "France",
      countryCode: "FR",
      admin1: "Île-de-France",
      admin1Code: "FR-IDF",
      nearestCity: "Paris",
      nearestCityCoordinates: { longitude: 2.3522, latitude: 48.8566 },
    },
  ],
};

let tmp: string;
let catalogPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "licatalog-"));
  catalogPath = join(tmp, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify(FIXTURE));
  process.env.LOCATION_INTRODUCTION_CATALOG_PATH = catalogPath;
  __resetLocationIntroductionCatalogForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.LOCATION_INTRODUCTION_CATALOG_PATH;
  __resetLocationIntroductionCatalogForTests();
});

describe("resolveLocationIntroductionCatalogEntry", () => {
  it("returns the catalog entry for a known sourceId", () => {
    const entry = resolveLocationIntroductionCatalogEntry("tokyo");
    expect(entry.canonicalPlaceId).toBe("tokyo-jp");
    expect(entry.countryCode).toBe("JP");
    expect(entry.nearestCityCoordinates).toEqual({ longitude: 139.6917, latitude: 35.6895 });
  });

  it("exposes the dataset version from the catalog file", () => {
    expect(getLocationIntroductionDatasetVersion()).toBe("test-fixture-v1");
  });

  it("throws LocationIntroductionUnsupportedPlaceError for an unknown sourceId", () => {
    expect(() => resolveLocationIntroductionCatalogEntry("atlantis"))
      .toThrow(LocationIntroductionUnsupportedPlaceError);
  });

  it("rejects sourceId values containing path separators or whitespace", () => {
    for (const bad of ["../etc/passwd", "tokyo city", "tokyo\x00", "tokyo;DROP", "", "x".repeat(129)]) {
      expect(() => resolveLocationIntroductionCatalogEntry(bad))
        .toThrow(LocationIntroductionUnsupportedPlaceError);
    }
  });

  it("ignores malformed entries in the catalog but still loads known ids", () => {
    writeFileSync(catalogPath, JSON.stringify({
      datasetVersion: "v2",
      entries: [
        { sourceId: 123 }, // invalid shape
        null,
        { sourceId: "lisbon", canonicalPlaceId: "lisbon-pt", name: "Lisbon", country: "Portugal", countryCode: "PT", admin1: "Lisbon", admin1Code: "PT-11", nearestCity: "Lisbon", nearestCityCoordinates: { longitude: -9.1393, latitude: 38.7223 } },
      ],
    }));
    __resetLocationIntroductionCatalogForTests();
    const entry = resolveLocationIntroductionCatalogEntry("lisbon");
    expect(entry.name).toBe("Lisbon");
    expect(getLocationIntroductionDatasetVersion()).toBe("v2");
  });
});