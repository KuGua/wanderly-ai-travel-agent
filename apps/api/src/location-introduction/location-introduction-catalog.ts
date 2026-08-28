/**
 * Versioned, file-backed catalog of map places eligible for the shared
 * location-introduction cache. The catalog is the sole authority for a
 * stable sourceId; no runtime registration or database override exists.
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
  origin: "file";
}

export class LocationIntroductionUnsupportedPlaceError extends Error {
  override readonly name = "LocationIntroductionUnsupportedPlaceError";
  constructor(readonly sourceId: string) {
    super("Unsupported place");
  }
}

const DEFAULT_CATALOG_PATH = resolve(process.cwd(), "data/location-introduction/catalog.json");
const SAFE_SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;

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

function loadFromDisk(): CachedFile {
  const path = resolveCatalogPath();
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as CatalogFile;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.entries)
    || typeof parsed.datasetVersion !== "string" || parsed.datasetVersion.length === 0) {
    throw new Error(`Location-introduction catalog at ${path} is malformed`);
  }
  const entries = new Map<string, LocationIntroductionCatalogEntry>();
  for (const entry of parsed.entries) {
    if (!entry || typeof entry.sourceId !== "string" || !SAFE_SOURCE_ID.test(entry.sourceId)) continue;
    entries.set(entry.sourceId, { ...entry, datasetVersion: parsed.datasetVersion, origin: "file" });
  }
  return { entries, datasetVersion: parsed.datasetVersion };
}

function ensureFileLoaded(): CachedFile {
  const path = resolveCatalogPath();
  if (cachedFile && cachedPath === path) {
    try {
      if (statSync(path).mtimeMs === cachedMtimeMs) return cachedFile;
    } catch {
      // Reload below so callers receive a useful catalog error.
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

export async function resolveLocationIntroductionCatalogEntry(sourceId: string): Promise<LocationIntroductionCatalogEntry> {
  return resolveLocationIntroductionCatalogEntrySync(sourceId);
}

export function resolveLocationIntroductionCatalogEntrySync(sourceId: string): LocationIntroductionCatalogEntry {
  if (typeof sourceId !== "string" || !SAFE_SOURCE_ID.test(sourceId)) {
    throw new LocationIntroductionUnsupportedPlaceError(sourceId);
  }
  const entry = ensureFileLoaded().entries.get(sourceId);
  if (!entry) throw new LocationIntroductionUnsupportedPlaceError(sourceId);
  return entry;
}

/**
 * Resolve a map reference to one catalog entry on the server. A city match is
 * required, and ambiguous city names only resolve when the admin1 code makes
 * the choice unique. The client never supplies or derives this sourceId.
 */
export function resolveLocationIntroductionSourceIdForReference(input: {
  countryCode: string | null;
  admin1Code: string | null;
  nearestCity: string | null;
}): string | null {
  if (!input.countryCode || !input.nearestCity) return null;
  const city = normalizeCatalogName(input.nearestCity);
  const matches = [...ensureFileLoaded().entries.values()].filter((entry) =>
    entry.countryCode === input.countryCode && normalizeCatalogName(entry.nearestCity) === city,
  );
  if (matches.length === 1) return matches[0].sourceId;
  if (!input.admin1Code) return null;
  const scoped = matches.filter((entry) => entry.admin1Code === input.admin1Code);
  return scoped.length === 1 ? scoped[0].sourceId : null;
}

function normalizeCatalogName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export async function getLocationIntroductionDatasetVersion(): Promise<string> {
  return ensureFileLoaded().datasetVersion;
}

export function getLocationIntroductionFileDatasetVersion(): string {
  return ensureFileLoaded().datasetVersion;
}

export function __resetLocationIntroductionCatalogForTests(): void {
  cachedFile = null;
  cachedPath = null;
  cachedMtimeMs = -1;
}

export type { CatalogFile };
export { resolveCatalogPath, DEFAULT_CATALOG_PATH };

resolve(resolveCatalogPath());
