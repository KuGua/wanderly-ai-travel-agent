import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../src/db/database.js";
import { locationIntroductionCatalogOverrides, users } from "../src/db/schema.js";
import { createRequestContext } from "../src/utils/context.js";
import {
  registerLocationIntroductionEntry,
  LocationIntroductionDuplicateEntryError,
} from "../src/location-introduction/location-introduction-registry.js";
import {
  __resetLocationIntroductionCatalogForTests,
  invalidateLocationIntroductionOverrideCache,
  resolveLocationIntroductionCatalogEntrySync,
} from "../src/location-introduction/location-introduction-catalog.js";

const FIXTURE_PATH = "/tmp/li-catalog-test-catalog.json";

void FIXTURE_PATH;

let tmp: string;
let catalogPath: string;
const previousOverride = process.env.LOCATION_INTRODUCTION_CATALOG_PATH;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "li-registry-"));
  catalogPath = join(tmp, "catalog.json");
  const body = {
    $schemaVersion: "1.0.0",
    datasetVersion: "location-introduction-v1",
    entries: [],
  };
  writeFileSync(catalogPath, JSON.stringify(body));
  process.env.LOCATION_INTRODUCTION_CATALOG_PATH = catalogPath;
  __resetLocationIntroductionCatalogForTests();
  invalidateLocationIntroductionOverrideCache();
  // Seed the actor user row so the FK on `created_by_user_id` resolves.
  await db.execute(sql`DELETE FROM audit_events WHERE actor_user_id = '11111111-1111-4111-8111-111111111111'`);
  await db.execute(sql`DELETE FROM location_introduction_catalog_overrides`);
  await db.execute(sql`DELETE FROM users WHERE id = '11111111-1111-4111-8111-111111111111'`);
  await db.insert(users).values({
    id: "11111111-1111-4111-8111-111111111111",
    externalId: "test-operator",
    displayName: "Test Operator",
  });
});

afterEach(async () => {
  await db.execute(sql`DELETE FROM audit_events WHERE actor_user_id = '11111111-1111-4111-8111-111111111111'`);
  await db.execute(sql`DELETE FROM location_introduction_catalog_overrides`);
  await db.execute(sql`DELETE FROM users WHERE id = '11111111-1111-4111-8111-111111111111'`);
  rmSync(tmp, { recursive: true, force: true });
  if (previousOverride !== undefined) process.env.LOCATION_INTRODUCTION_CATALOG_PATH = previousOverride;
  else delete process.env.LOCATION_INTRODUCTION_CATALOG_PATH;
  __resetLocationIntroductionCatalogForTests();
  invalidateLocationIntroductionOverrideCache();
});

const SAMPLE_INPUT = {
  sourceId: "munich",
  canonicalPlaceId: "munich-de",
  name: "Munich",
  country: "Germany",
  countryCode: "DE",
  admin1: "Bavaria",
  admin1Code: "DE-BY",
  nearestCity: "Munich",
  nearestCityLongitude: 11.582,
  nearestCityLatitude: 48.1351,
};

describe("registerLocationIntroductionEntry", () => {
  it("inserts a DB row and rewrites catalog.json atomically", async () => {
    const ctx = createRequestContext("11111111-1111-4111-8111-111111111111");
    const result = await registerLocationIntroductionEntry(SAMPLE_INPUT, { ctx });

    expect(result.sourceId).toBe("munich");
    expect(result.name).toBe("Munich");
    expect(result.datasetVersion).toBe("location-introduction-v1");
    expect(result.createdByUserId).toBe("11111111-1111-4111-8111-111111111111");
    expect(typeof result.createdAt).toBe("string");

    const rows = await db
      .select()
      .from(locationIntroductionCatalogOverrides)
      .where(sql`${locationIntroductionCatalogOverrides.sourceId} = 'munich'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].canonicalPlaceId).toBe("munich-de");

    const fileContents = JSON.parse(readFileSync(catalogPath, "utf-8")) as {
      entries: Array<{ sourceId: string; origin: string; datasetVersion: string }>;
    };
    expect(fileContents.entries).toHaveLength(1);
    expect(fileContents.entries[0].sourceId).toBe("munich");
    expect(fileContents.entries[0].origin).toBe("override");
    expect(fileContents.entries[0].datasetVersion).toBe("location-introduction-v1");
  });

  it("rejects a second registration with the same sourceId", async () => {
    const ctx = createRequestContext("11111111-1111-4111-8111-111111111111");
    await registerLocationIntroductionEntry(SAMPLE_INPUT, { ctx });

    await expect(registerLocationIntroductionEntry(SAMPLE_INPUT, { ctx }))
      .rejects.toBeInstanceOf(LocationIntroductionDuplicateEntryError);
  });

  it("rejects sourceIds that fail the safe-id regex", async () => {
    const ctx = createRequestContext("11111111-1111-4111-8111-111111111111");
    for (const bad of ["../etc/passwd", "tokyo city", "x".repeat(129)]) {
      await expect(registerLocationIntroductionEntry(
        { ...SAMPLE_INPUT, sourceId: bad },
        { ctx },
      )).rejects.toThrow(/sourceId/);
    }
  });

  it("rejects out-of-range coordinates", async () => {
    const ctx = createRequestContext("11111111-1111-4111-8111-111111111111");
    await expect(registerLocationIntroductionEntry(
      { ...SAMPLE_INPUT, nearestCityLongitude: 181 },
      { ctx },
    )).rejects.toThrow(/nearestCityLongitude/);
    await expect(registerLocationIntroductionEntry(
      { ...SAMPLE_INPUT, nearestCityLatitude: -91 },
      { ctx },
    )).rejects.toThrow(/nearestCityLatitude/);
  });

  it("rolls back the DB row if the file rewrite fails", async () => {
    const ctx = createRequestContext("11111111-1111-4111-8111-111111111111");

    // First registration works.
    await registerLocationIntroductionEntry(SAMPLE_INPUT, { ctx });

    // Second registration of a NEW id, but we point the catalog path
    // at a directory so the rename() call fails with EPERM/EISDIR.
    const blockedPath = join(tmp, "blocked-as-directory");
    const fs = await import("node:fs");
    fs.mkdirSync(blockedPath);
    process.env.LOCATION_INTRODUCTION_CATALOG_PATH = blockedPath;
    __resetLocationIntroductionCatalogForTests();

    await expect(registerLocationIntroductionEntry(
      { ...SAMPLE_INPUT, sourceId: "barcelona-de" },
      { ctx },
    )).rejects.toThrow();

    __resetLocationIntroductionCatalogForTests();

    const rows = await db
      .select()
      .from(locationIntroductionCatalogOverrides)
      .where(sql`${locationIntroductionCatalogOverrides.sourceId} = 'barcelona-de'`);
    expect(rows).toHaveLength(0);
  });
});