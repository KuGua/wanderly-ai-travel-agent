/**
 * Operator-facing registration service for location-introduction
 * catalog entries. Performs the dual-write:
 *   1. Insert into `location_introduction_catalog_overrides` (authoritative
 *      for the live process).
 *   2. Atomically rewrite `catalog.json` so cold-starts see the same set
 *      without a separate migration.
 *
 * The DB write commits first. If the JSON rewrite fails we log the
 * inconsistency and roll back the DB row — a stale `catalog.json` is
 * recoverable on next deploy, but a DB-only entry with no file backing
 * would silently re-disappear on the next process restart that bypasses
 * the override table (e.g. a sidecar container).
 */
import { writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/database.js";
import { locationIntroductionCatalogOverrides } from "../db/schema.js";
import { recordAudit } from "../services/audit-service.js";
import { metrics } from "../observability/metrics.js";
import { getTracer, safeSetAttribute } from "../observability/tracing.js";
import {
  invalidateLocationIntroductionOverrideCache,
  resolveCatalogPath as defaultResolveCatalogPath,
  type LocationIntroductionCatalogEntry,
} from "./location-introduction-catalog.js";
import type { RequestContext } from "../utils/context.js";

export interface RegisterLocationIntroductionEntryInput {
  sourceId: string;
  canonicalPlaceId: string;
  name: string;
  country: string;
  countryCode: string;
  admin1: string;
  admin1Code: string;
  nearestCity: string;
  nearestCityLongitude: number;
  nearestCityLatitude: number;
}

export interface RegisterLocationIntroductionEntryResult {
  sourceId: string;
  canonicalPlaceId: string;
  name: string;
  datasetVersion: string;
  createdAt: string;
  createdByUserId: string;
}

export class LocationIntroductionDuplicateEntryError extends Error {
  override readonly name = "LocationIntroductionDuplicateEntryError";
  constructor(readonly sourceId: string) {
    super("Entry already registered");
  }
}

const SAFE_SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LENGTHS = {
  sourceId: 128,
  canonicalPlaceId: 128,
  name: 256,
  country: 128,
  countryCode: 8,
  admin1: 128,
  admin1Code: 64,
  nearestCity: 128,
};

function validateInput(input: RegisterLocationIntroductionEntryInput): void {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.trim().length === 0) {
      throw new Error(`${key} must be a non-empty string`);
    }
  }
  if (!SAFE_SOURCE_ID.test(input.sourceId)) {
    throw new Error("sourceId must match [A-Za-z0-9_-]{1,128}");
  }
  for (const [key, max] of Object.entries(MAX_LENGTHS)) {
    const value = (input as unknown as Record<string, string | number>)[key];
    if (typeof value !== "string" || value.length > max) {
      throw new Error(`${key} exceeds ${max} chars`);
    }
  }
  if (input.countryCode.length < 1) {
    throw new Error("countryCode must be 1..8 chars");
  }
  if (Number.isNaN(input.nearestCityLongitude) || input.nearestCityLongitude < -180 || input.nearestCityLongitude > 180) {
    throw new Error("nearestCityLongitude must be in [-180, 180]");
  }
  if (Number.isNaN(input.nearestCityLatitude) || input.nearestCityLatitude < -90 || input.nearestCityLatitude > 90) {
    throw new Error("nearestCityLatitude must be in [-90, 90]");
  }
}

interface FileLayout {
  $schemaVersion?: string;
  datasetVersion: string;
  entries: LocationIntroductionCatalogEntry[];
}

async function readCatalogFile(path: string): Promise<FileLayout> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as FileLayout;
}

async function rewriteCatalogFile(
  path: string,
  layout: FileLayout,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(layout, null, 2)}\n`;
  await writeFile(tmp, body, "utf-8");
  await rename(tmp, path);
}

interface RegisterLocationIntroductionEntryDeps {
  ctx: RequestContext;
  resolveCatalogPath?: () => string;
}

export async function registerLocationIntroductionEntry(
  input: RegisterLocationIntroductionEntryInput,
  deps: RegisterLocationIntroductionEntryDeps,
): Promise<RegisterLocationIntroductionEntryResult> {
  validateInput(input);

  const resolvePath = deps.resolveCatalogPath ?? defaultResolveCatalogPath;
  const catalogPath = resolvePath();
  const userId = deps.ctx.actorUserId;
  if (!userId) {
    throw new Error("Authenticated actor user id is required to register a catalog entry");
  }

  const tracer = getTracer();
  const span = tracer.startSpan("catalog.register", {});

  let result: RegisterLocationIntroductionEntryResult;
  try {
    // 1. DB insert.
    const insertedRows = await db
      .insert(locationIntroductionCatalogOverrides)
      .values({
        sourceId: input.sourceId,
        canonicalPlaceId: input.canonicalPlaceId,
        name: input.name,
        country: input.country,
        countryCode: input.countryCode,
        admin1: input.admin1,
        admin1Code: input.admin1Code,
        nearestCity: input.nearestCity,
        nearestCityLongitude: input.nearestCityLongitude,
        nearestCityLatitude: input.nearestCityLatitude,
        datasetVersion: process.env.LOCATION_INTRODUCTION_CONTENT_VERSION?.trim()
          || "location-introduction-v1",
        createdByUserId: userId,
      })
      .onConflictDoNothing({ target: locationIntroductionCatalogOverrides.sourceId })
      .returning({
        sourceId: locationIntroductionCatalogOverrides.sourceId,
        canonicalPlaceId: locationIntroductionCatalogOverrides.canonicalPlaceId,
        name: locationIntroductionCatalogOverrides.name,
        datasetVersion: locationIntroductionCatalogOverrides.datasetVersion,
        createdAt: locationIntroductionCatalogOverrides.createdAt,
        createdByUserId: locationIntroductionCatalogOverrides.createdByUserId,
      });

    if (insertedRows.length === 0) {
      throw new LocationIntroductionDuplicateEntryError(input.sourceId);
    }
    const inserted = insertedRows[0];

    // 2. JSON file rewrite. If this fails we roll back the DB row to
    //    keep the two sources consistent.
    let layout: FileLayout | null = null;
    try {
      layout = await readCatalogFile(catalogPath);
    } catch (err) {
      // First-ever registration may precede any file; bootstrap.
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        layout = {
          $schemaVersion: "1.0.0",
          datasetVersion: inserted.datasetVersion,
          entries: [],
        };
      } else {
        await db
          .delete(locationIntroductionCatalogOverrides)
          .where(eq(locationIntroductionCatalogOverrides.sourceId, input.sourceId));
        throw err;
      }
    }
    if (!layout) {
      throw new Error("Failed to load or initialize the catalog file layout");
    }
    layout.entries = layout.entries.filter((entry) => entry.sourceId !== input.sourceId);
    layout.entries.push({
      sourceId: input.sourceId,
      canonicalPlaceId: input.canonicalPlaceId,
      name: input.name,
      country: input.country,
      countryCode: input.countryCode,
      admin1: input.admin1,
      admin1Code: input.admin1Code,
      nearestCity: input.nearestCity,
      nearestCityCoordinates: {
        longitude: input.nearestCityLongitude,
        latitude: input.nearestCityLatitude,
      },
      datasetVersion: inserted.datasetVersion,
      origin: "override",
    });
    layout.datasetVersion = inserted.datasetVersion;

    try {
      await rewriteCatalogFile(catalogPath, layout);
    } catch (fileErr) {
      await db
        .delete(locationIntroductionCatalogOverrides)
        .where(eq(locationIntroductionCatalogOverrides.sourceId, input.sourceId));
      throw fileErr;
    }

    invalidateLocationIntroductionOverrideCache();

    result = {
      sourceId: inserted.sourceId,
      canonicalPlaceId: inserted.canonicalPlaceId,
      name: inserted.name,
      datasetVersion: inserted.datasetVersion,
      createdAt: inserted.createdAt.toISOString(),
      createdByUserId: inserted.createdByUserId,
    };

    await recordAudit({
      ctx: deps.ctx,
      action: "LOCATION_INTRODUCTION_REGISTER",
      summary: {
        operation: "register",
        sourceId: input.sourceId,
        canonicalPlaceId: input.canonicalPlaceId,
        datasetVersion: inserted.datasetVersion,
      },
    });
    metrics.inc("location_introduction_registry_total", { outcome: "registered" });
    safeSetAttribute(span, "cache.outcome", "registered");
    span.end();
    return result;
  } catch (err) {
    safeSetAttribute(span, "cache.outcome", "failure");
    span.end();
    if (err instanceof LocationIntroductionDuplicateEntryError) {
      metrics.inc("location_introduction_registry_total", { outcome: "duplicate" });
    } else {
      metrics.inc("location_introduction_registry_total", { outcome: "error" });
    }
    throw err;
  }
}