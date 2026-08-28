/**
 * Server-versioned catalog of stable map places eligible for the cached,
 * non-personalized "location introduction" feature (PRD FR-1 #11, S4).
 *
 * Each entry exposes only fields a server-controlled, non-personalized
 * editor needs to draft a generic destination blurb. The list is
 * authoritative; arbitrary coordinates, names, and `INSPIRATION` pins
 * never resolve through this module.
 *
 * Lookup is O(1) after a single on-demand JSON parse. The parsed map is
 * held in module scope for the lifetime of the process. We deliberately
 * do not reload on every request: catalog changes ship via deployment,
 * not hot-reload. Tests call {@link __resetLocationIntroductionCatalogForTests}
 * to re-read after pointing `LOCATION_INTRODUCTION_CATALOG_PATH` at a
 * fixture.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

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
}

interface CatalogFile {
  $schemaVersion?: string;
  datasetVersion: string;
  entries: LocationIntroductionCatalogEntry[];
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

function resolveCatalogPath(): string {
  const configured = process.env.LOCATION_INTRODUCTION_CATALOG_PATH?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_CATALOG_PATH;
}

let cachedEntries: Map<string, LocationIntroductionCatalogEntry> | null = null;
let cachedDatasetVersion: string | null = null;
let cachedPath: string | null = null;
let cachedMtimeMs = -1;

function loadFromDisk(): { entries: Map<string, LocationIntroductionCatalogEntry>; datasetVersion: string } {
  const path = resolveCatalogPath();
  const stats = statSync(path);
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as CatalogFile;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.entries)) {
    throw new Error(`Location-introduction catalog at ${path} is malformed`);
  }
  const entries = new Map<string, LocationIntroductionCatalogEntry>();
  for (const entry of parsed.entries) {
    if (!entry || typeof entry.sourceId !== "string") continue;
    // Stamp the file-level datasetVersion onto every entry so the model
    // gateway never has to re-read the parent file. The original entry
    // may carry its own datasetVersion (e.g. for staged rollouts); we
    // prefer the file-level value to keep all rows aligned.
    entries.set(entry.sourceId, { ...entry, datasetVersion: parsed.datasetVersion });
  }
  return { entries, datasetVersion: parsed.datasetVersion };
}

function ensureLoaded(): { entries: Map<string, LocationIntroductionCatalogEntry>; datasetVersion: string } {
  const path = resolveCatalogPath();
  if (cachedEntries && cachedDatasetVersion && cachedPath === path) {
    try {
      const currentMtime = statSync(path).mtimeMs;
      if (currentMtime === cachedMtimeMs) {
        return { entries: cachedEntries, datasetVersion: cachedDatasetVersion };
      }
    } catch {
      // Fall through and reload from disk.
    }
  }
  const fresh = loadFromDisk();
  cachedEntries = fresh.entries;
  cachedDatasetVersion = fresh.datasetVersion;
  cachedPath = path;
  try {
    cachedMtimeMs = statSync(path).mtimeMs;
  } catch {
    cachedMtimeMs = -1;
  }
  return fresh;
}

/**
 * Resolve a `sourceId` to its catalog entry. Throws
 * {@link LocationIntroductionUnsupportedPlaceError} when the id is not in
 * the active catalog — the route layer maps this to a 400 without
 * echoing the unknown id back to the client body. `sourceId` must match
 * `[A-Za-z0-9_-]{1,128}`; any other shape is treated as unsupported so
 * clients cannot smuggle path separators or arbitrary text.
 */
const SAFE_SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function resolveLocationIntroductionCatalogEntry(
  sourceId: string,
): LocationIntroductionCatalogEntry {
  if (typeof sourceId !== "string" || !SAFE_SOURCE_ID.test(sourceId)) {
    throw new LocationIntroductionUnsupportedPlaceError(sourceId);
  }
  const { entries } = ensureLoaded();
  const entry = entries.get(sourceId);
  if (!entry) {
    throw new LocationIntroductionUnsupportedPlaceError(sourceId);
  }
  return entry;
}

export function getLocationIntroductionDatasetVersion(): string {
  return ensureLoaded().datasetVersion;
}

/** Test-only hook: forget the cached catalog so the next read re-parses the file. */
export function __resetLocationIntroductionCatalogForTests(): void {
  cachedEntries = null;
  cachedDatasetVersion = null;
  cachedPath = null;
  cachedMtimeMs = -1;
}

// Resolve once at module load so we the URL is verifiable at boot.
resolve(resolveCatalogPath());