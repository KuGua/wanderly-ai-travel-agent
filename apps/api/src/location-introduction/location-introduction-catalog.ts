/**
 * Server-versioned catalog of stable map places eligible for the cached,
 * non-personalized "location introduction" feature (PRD FR-1 #11, S4).
 *
 * The catalog is the authoritative gate for `sourceId` resolution: any
 * `sourceId` not in the merged file + DB override map is rejected with
 * `LocationIntroductionUnsupportedPlaceError`, which the route layer
 * maps to `400 LOCATION_INTRODUCTION_UNSUPPORTED_PLACE`.
 *
 * Lookup sources, in precedence order:
 *   1. `location_introduction_catalog_overrides` rows (operator-registered
 *      via `POST /api/v1/admin/location-introduction/entries`).
 *   2. Bundled `data/location-introduction/catalog.json` file entries
 *      (initial deploy contents).
 *
 * File mtime + override-table TTL drive the in-memory cache. Tests
 * call {@link __resetLocationIntroductionCatalogForTests} to re-read
 * after pointing `LOCATION_INTRODUCTION_CATALOG_PATH` at a fixture.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../db/database.js";
import { locationIntroductionCatalogOverrides } from "../db/schema.js";

export interface LocationIntroductionCatalogEntry {
  sourceId: string;
  canonicalPlaceId: string;
  name: string;
  country: string;
  countryCode: string;
  admin1: string;
  admin1Code: string;
  nearestCity: string;
  nearestCityCoordinates: { longitude: number; latitude: number };
  datasetVersion: string;
  origin: "file" | "override";
}

/**
 * Shape returned to the operator registration endpoint and the response
 * envelope. `createdAt` / `createdByUserId` are admin-attribution only
 * and never reach the public catalog lookup.
 */
export interface LocationIntroductionCatalogOverrideRow {
  sourceId: string;
  canonicalPlaceId: string;
  name: string;
  country: string;
  countryCode: string;
  admin1: string;
  admin1Code: string;
  nearestCity: string;
  nearestCityCoordinates: { longitude: number; latitude: number };
  datasetVersion: string;
  createdByUserId: string;
  createdAt: string;
}

/**
 * Sentinel thrown when a caller asks for a `sourceId` that is not in the
 * active server catalog. The route layer maps this to
 * `400 LOCATION_INTRODUCTION_UNSUPPORTED_PLACE` without echoing the
 * unknown id back to the client body.
 */
export class LocationIntroductionUnsupportedPlaceError extends Error {
  override readonly name = "LocationIntroductionUnsupportedPlaceError";
  constructor(readonly sourceId: string) {
    super("Unsupported place");
  }
}

const DEFAULT_CATALOG_PATH = resolve(process.cwd(), "data/location-introduction/catalog.json");
const OVERRIDE_CACHE_TTL_MS = 30_000;

function resolveCatalogPath(): string {
  const configured = process.env.LOCATION_INTRODUCTION_CATALOG_PATH?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_CATALOG_PATH;
}

interface CatalogFile {
  $schemaVersion?: string;
  datasetVersion: string;
  entries: Array<{
    sourceId: string;
    canonicalPlaceId: string;
    name: string;
    country: string;
    countryCode: string;
    admin1: string;
    admin1Code: string;
    nearestCity: string;
    nearestCityCoordinates: { longitude: number; latitude: number };
  }>;
}

interface CachedFile {
  entries: Map<string, LocationIntroductionCatalogEntry>;
  datasetVersion: string;
}

let cachedFile: CachedFile | null = null;
let cachedPath: string | null = null;
let cachedMtimeMs = -1;
let cachedOverrides: CachedFile | null = null;
let cachedOverridesAt = 0;

function loadFromDisk(): CachedFile {
  const path = resolveCatalogPath();
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as CatalogFile;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.entries)) {
    throw new Error(`Location-introduction catalog at ${path} is malformed`);
  }
  const entries = new Map<string, LocationIntroductionCatalogEntry>();
  for (const entry of parsed.entries) {
    if (!entry || typeof entry.sourceId !== "string") continue;
    entries.set(entry.sourceId, {
      ...entry,
      datasetVersion: parsed.datasetVersion,
      origin: "file",
    });
  }
  return { entries, datasetVersion: parsed.datasetVersion };
}

function ensureFileLoaded(): CachedFile {
  const path = resolveCatalogPath();
  if (cachedFile && cachedPath === path) {
    try {
      const currentMtime = statSync(path).mtimeMs;
      if (currentMtime === cachedMtimeMs) {
        return cachedFile;
      }
    } catch {
      // Fall through and reload from disk.
    }
  }
  const fresh = loadFromDisk();
  cachedFile = fresh;
  cachedPath = path;
  try {
  cachedMtimeMs = statSync(path).mtimeMs;
} catch {
    cachedMtimeMs = -1;
  }
  return fresh;
}

async function loadOverridesFromDb(): Promise<CachedFile> {
  // Single SELECT; the table is small (admin-only writes) and a 30-second
  // TTL keeps this well below any meaningful cost.
  const rows = await db
    .select({
      sourceId: locationIntroductionCatalogOverrides.sourceId,
      canonicalPlaceId: locationIntroductionCatalogOverrides.canonicalPlaceId,
      name: locationIntroductionCatalogOverrides.name,
      country: locationIntroductionCatalogOverrides.country,
      countryCode: locationIntroductionCatalogOverrides.countryCode,
      admin1: locationIntroductionCatalogOverrides.admin1,
      admin1Code: locationIntroductionCatalogOverrides.admin1Code,
      nearestCity: locationIntroductionCatalogOverrides.nearestCity,
      nearestCityLongitude: locationIntroductionCatalogOverrides.nearestCityLongitude,
      nearestCityLatitude: locationIntroductionCatalogOverrides.nearestCityLatitude,
      datasetVersion: locationIntroductionCatalogOverrides.datasetVersion,
    })
    .from(locationIntroductionCatalogOverrides);
  const entries = new Map<string, LocationIntroductionCatalogEntry>();
  let datasetVersion = "";
  for (const row of rows) {
    if (!row.sourceId) continue;
    entries.set(row.sourceId, {
      sourceId: row.sourceId,
      canonicalPlaceId: row.canonicalPlaceId,
      name: row.name,
      country: row.country,
      countryCode: row.countryCode,
      admin1: row.admin1,
      admin1Code: row.admin1Code,
      nearestCity: row.nearestCity,
      nearestCityCoordinates: {
        longitude: row.nearestCityLongitude,
        latitude: row.nearestCityLatitude,
      },
      datasetVersion: row.datasetVersion,
      origin: "override",
    });
    if (!datasetVersion) datasetVersion = row.datasetVersion;
  }
  return { entries, datasetVersion };
}

async function ensureMergedLoaded(): Promise<CachedFile> {
  const file = ensureFileLoaded();
  const now = Date.now();
  if (!cachedOverrides || now - cachedOverridesAt > OVERRIDE_CACHE_TTL_MS) {
    try {
      cachedOverrides = await loadOverridesFromDb();
      cachedOverridesAt = now;
    } catch {
      // If the DB is unreachable on the first lookup after process start
      // we still serve the file-only catalog rather than failing every
      // request. Subsequent calls retry.
      if (!cachedOverrides) cachedOverrides = { entries: new Map(), datasetVersion: file.datasetVersion };
      cachedOverridesAt = now;
    }
  }
  // Merge with overrides winning on collision.
  const mergedEntries = new Map<string, LocationIntroductionCatalogEntry>();
  for (const [id, entry] of file.entries) mergedEntries.set(id, entry);
  for (const [id, entry] of cachedOverrides.entries) mergedEntries.set(id, entry);
  return {
    entries: mergedEntries,
    datasetVersion: cachedOverrides.datasetVersion || file.datasetVersion,
  };
}

/**
 * Resolve a `sourceId` to its catalog entry. Throws
 * {@link LocationIntroductionUnsupportedPlaceError} when the id is not in
 * the active merged catalog — the route layer maps this to a 400 without
 * echoing the unknown id back to the client body. `sourceId` must match
 * `[A-Za-z0-9_-]{1,128}`; any other shape is treated as unsupported so
 * clients cannot smuggle path separators or arbitrary text.
 */
const SAFE_SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function resolveLocationIntroductionCatalogEntry(
  sourceId: string,
): Promise<LocationIntroductionCatalogEntry> {
  if (typeof sourceId !== "string" || !SAFE_SOURCE_ID.test(sourceId)) {
    throw new LocationIntroductionUnsupportedPlaceError(sourceId);
  }
  const { entries } = await ensureMergedLoaded();
  const entry = entries.get(sourceId);
  if (!entry) {
    throw new LocationIntroductionUnsupportedPlaceError(sourceId);
  }
  return entry;
}

/** Synchronous variant for callers that have already loaded the merged
 * catalog (or for tests where the override table is empty).
 */
export function resolveLocationIntroductionCatalogEntrySync(
  sourceId: string,
): LocationIntroductionCatalogEntry {
  if (typeof sourceId !== "string" || !SAFE_SOURCE_ID.test(sourceId)) {
    throw new LocationIntroductionUnsupportedPlaceError(sourceId);
  }
  const file = ensureFileLoaded();
  const overrideEntry = cachedOverrides?.entries.get(sourceId);
  if (overrideEntry) return overrideEntry;
  const entry = file.entries.get(sourceId);
  if (!entry) throw new LocationIntroductionUnsupportedPlaceError(sourceId);
  return entry;
}

export async function getLocationIntroductionDatasetVersion(): Promise<string> {
  const merged = await ensureMergedLoaded();
  return merged.datasetVersion;
}

export function getLocationIntroductionFileDatasetVersion(): string {
  return ensureFileLoaded().datasetVersion;
}

/**
 * Invalidate the override cache so the next lookup re-reads the DB. Call
 * after a successful registration so the very next public request sees
 * the new entry without waiting for the 30s TTL.
 */
export function invalidateLocationIntroductionOverrideCache(): void {
  cachedOverrides = null;
  cachedOverridesAt = 0;
}

/** Test-only hook: forget the cached catalog so the next read re-parses the file. */
export function __resetLocationIntroductionCatalogForTests(): void {
  cachedFile = null;
  cachedPath = null;
  cachedMtimeMs = -1;
  cachedOverrides = null;
  cachedOverridesAt = 0;
}

export type { CatalogFile };
export { resolveCatalogPath, DEFAULT_CATALOG_PATH };

// Resolve once at module load so the URL is verifiable at boot.
resolve(resolveCatalogPath());