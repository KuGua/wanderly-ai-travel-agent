/**
 * Repository for `location_introduction_cache` rows. All helpers open a
 * short transaction and return enough information for the caller to
 * decide whether they hold the generation lease, whether they should
 * commit the LLM output, or whether they should fall back to 202
 * GENERATING.
 *
 * No method holds a transaction across a network call. The
 * `LocationIntroductionCacheService` opens the lease here, runs the
 * model outside the transaction, then commits or releases here.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/database.js";
import { locationIntroductionCache } from "../db/schema.js";
import type { LocationIntroductionCatalogEntry } from "./location-introduction-catalog.js";

export type LocationIntroductionCacheStatus = "GENERATING" | "READY";

export interface LocationIntroductionCacheReadRow {
  status: LocationIntroductionCacheStatus;
  content: string | null;
  generatedAt: Date | null;
  expiresAt: Date | null;
  generationLeaseToken: string | null;
  generationLeaseExpiresAt: Date | null;
  modelName: string | null;
  promptVersion: string | null;
}

export interface ReadyCacheResult {
  outcome: "ready";
  content: string;
  expiresAt: Date;
  modelName: string | null;
  promptVersion: string | null;
}

export interface GeneratingCacheResult {
  outcome: "generating";
  leaseToken: string;
  leaseExpiresAt: Date;
}

export interface LeaseLostCacheResult {
  outcome: "lease-lost";
  currentStatus: LocationIntroductionCacheStatus;
  currentLeaseExpiresAt: Date | null;
}

export interface LeaseClaimSuccess {
  outcome: "claimed";
  leaseToken: string;
  leaseExpiresAt: Date;
}

export type LeaseClaimResult = LeaseClaimSuccess | LeaseLostCacheResult;

export interface CommitSuccess {
  outcome: "committed";
}

export interface CommitLostLease {
  outcome: "lease-lost";
}

/**
 * Derive the deterministic cache key from non-personalized catalog output.
 * `contentVersion` is taken from the catalog (`datasetVersion`) so a
 * catalog upgrade (or content prompt bump via `LOCATION_INTRODUCTION_CONTENT_VERSION`)
 * naturally invalidates the cache.
 */
export function buildLocationIntroductionCacheKey(input: {
  contentVersion: string;
  canonicalPlaceId: string;
  locale: "en" | "zh";
}): string {
  const hash = createHash("sha256");
  hash.update(input.contentVersion);
  hash.update("\x1f");
  hash.update(input.canonicalPlaceId);
  hash.update("\x1f");
  hash.update(input.locale);
  return hash.digest("hex");
}

export async function findReadyLocationIntroductionCache(
  cacheKey: string,
  now: Date,
): Promise<ReadyCacheResult | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        status: locationIntroductionCache.status,
        content: locationIntroductionCache.content,
        expiresAt: locationIntroductionCache.expiresAt,
        modelName: locationIntroductionCache.modelName,
        promptVersion: locationIntroductionCache.promptVersion,
      })
      .from(locationIntroductionCache)
      .where(eq(locationIntroductionCache.cacheKey, cacheKey))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.status !== "READY") return null;
    if (!row.content || !row.expiresAt) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    return {
      outcome: "ready",
      content: row.content,
      expiresAt: row.expiresAt,
      modelName: row.modelName,
      promptVersion: row.promptVersion,
    };
  });
}

/**
 * Attempt to claim the generation lease. Returns `claimed` with a fresh
 * token and expiry if the row is absent, expired, or its prior lease has
 * expired. Returns `lease-lost` otherwise (carrying the row's current
 * state so the caller can decide whether to return 202).
 */
export async function claimLocationIntroductionLease(input: {
  cacheKey: string;
  catalogEntry: LocationIntroductionCatalogEntry;
  locale: "en" | "zh";
  contentVersion: string;
  leaseSeconds: number;
  now: Date;
}): Promise<LeaseClaimResult> {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1000);
  const leaseToken = randomUUID();

  return db.transaction(async (tx) => {
    // Try to insert a new row first. ON CONFLICT DO NOTHING means a
    // successful insert is the lease win.
    const inserted = await tx
      .insert(locationIntroductionCache)
      .values({
        cacheKey: input.cacheKey,
        canonicalPlaceId: input.catalogEntry.canonicalPlaceId,
        locale: input.locale,
        contentVersion: input.contentVersion,
        status: "GENERATING",
        generationLeaseToken: leaseToken,
        generationLeaseExpiresAt: leaseExpiresAt,
      })
      .onConflictDoNothing({ target: locationIntroductionCache.cacheKey })
      .returning({
        cacheKey: locationIntroductionCache.cacheKey,
        status: locationIntroductionCache.status,
        generationLeaseToken: locationIntroductionCache.generationLeaseToken,
      });

    if (inserted.length === 1) {
      return {
        outcome: "claimed",
        leaseToken,
        leaseExpiresAt,
      };
    }

    // Row already exists. Try to take it over: the previous GENERATING
    // lease expired OR the READY entry is past its expires_at.
    // Drizzle's `sql` template re-uses `${input.now}` placeholders, but
    // postgres-js requires string-encoded timestamptz literals — we
    // expand the comparison values up-front to keep the placeholders
    // monotonic.
    const nowIso = input.now.toISOString();
    const updated = await tx
      .update(locationIntroductionCache)
      .set({
        status: "GENERATING",
        content: null,
        generatedAt: null,
        expiresAt: null,
        generationLeaseToken: leaseToken,
        generationLeaseExpiresAt: leaseExpiresAt,
        modelName: null,
        promptVersion: null,
        updatedAt: input.now,
      })
      .where(
        sql`(
          cache_key = ${input.cacheKey}
          AND (
            (status = 'READY' AND expires_at <= ${nowIso})
            OR
            (status = 'GENERATING' AND generation_lease_expires_at <= ${nowIso})
          )
        )`,
      )
      .returning({
        cacheKey: locationIntroductionCache.cacheKey,
        generationLeaseToken: locationIntroductionCache.generationLeaseToken,
      });

    if (updated.length === 1) {
      return {
        outcome: "claimed",
        leaseToken,
        leaseExpiresAt,
      };
    }

    // Read the current row so the caller knows whether to send 202.
    const current = await tx
      .select({
        status: locationIntroductionCache.status,
        generationLeaseExpiresAt: locationIntroductionCache.generationLeaseExpiresAt,
      })
      .from(locationIntroductionCache)
      .where(eq(locationIntroductionCache.cacheKey, input.cacheKey))
      .limit(1);
    const row = current[0];
    return {
      outcome: "lease-lost",
      currentStatus: (row?.status ?? "GENERATING") as LocationIntroductionCacheStatus,
      currentLeaseExpiresAt: row?.generationLeaseExpiresAt ?? null,
    };
  });
}

/**
 * Commit a successful generation. Returns `committed` only when the
 * lease token still matches AND status is still `GENERATING`. Any other
 * outcome means we lost the lease; the caller MUST discard the LLM
 * output.
 */
export async function commitLocationIntroductionReady(input: {
  cacheKey: string;
  leaseToken: string;
  content: string;
  modelName: string;
  promptVersion: string;
  ttlSeconds: number;
  now: Date;
}): Promise<CommitSuccess | CommitLostLease> {
  const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
  const updated = await db
    .update(locationIntroductionCache)
    .set({
      status: "READY",
      content: input.content,
      generatedAt: input.now,
      expiresAt,
      modelName: input.modelName,
      promptVersion: input.promptVersion,
      generationLeaseToken: null,
      generationLeaseExpiresAt: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(locationIntroductionCache.cacheKey, input.cacheKey),
        eq(locationIntroductionCache.generationLeaseToken, input.leaseToken),
        eq(locationIntroductionCache.status, "GENERATING"),
      ),
    )
    .returning({ cacheKey: locationIntroductionCache.cacheKey });

  return updated.length === 1
    ? { outcome: "committed" }
    : { outcome: "lease-lost" };
}

/**
 * Release the lease after a generation failure (timeout, schema parse,
 * policy, 5xx, network). Deletes only if the lease token still matches
 * AND status is still GENERATING — never delete a row a peer lease
 * owner may have re-claimed.
 */
export async function releaseLocationIntroductionLease(input: {
  cacheKey: string;
  leaseToken: string;
  now: Date;
}): Promise<void> {
  await db
    .delete(locationIntroductionCache)
    .where(
      and(
        eq(locationIntroductionCache.cacheKey, input.cacheKey),
        eq(locationIntroductionCache.generationLeaseToken, input.leaseToken),
        eq(locationIntroductionCache.status, "GENERATING"),
      ),
    );
}

/**
 * Read the current row for the GENERATING short-circuit. Returns the
 * lease owner info when the lease is still held, otherwise `null` so
 * the caller can treat this as a fresh miss.
 */
export async function findCurrentLocationIntroductionCache(
  cacheKey: string,
): Promise<LocationIntroductionCacheReadRow | null> {
  const rows = await db
    .select({
      status: locationIntroductionCache.status,
      content: locationIntroductionCache.content,
      generatedAt: locationIntroductionCache.generatedAt,
      expiresAt: locationIntroductionCache.expiresAt,
      generationLeaseToken: locationIntroductionCache.generationLeaseToken,
      generationLeaseExpiresAt: locationIntroductionCache.generationLeaseExpiresAt,
      modelName: locationIntroductionCache.modelName,
      promptVersion: locationIntroductionCache.promptVersion,
    })
    .from(locationIntroductionCache)
    .where(eq(locationIntroductionCache.cacheKey, cacheKey))
    .limit(1);
  return rows[0] ?? null;
}

/** Renew a still-valid lease. A lease that has already expired is deliberately
 * not revived: another request may have taken ownership after expiry. */
export async function renewLocationIntroductionLease(input: {
  cacheKey: string;
  leaseToken: string;
  leaseSeconds: number;
  now: Date;
}): Promise<boolean> {
  const expiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1000);
  const updated = await db
    .update(locationIntroductionCache)
    .set({ generationLeaseExpiresAt: expiresAt, updatedAt: input.now })
    .where(sql`cache_key = ${input.cacheKey}
      AND generation_lease_token = ${input.leaseToken}
      AND status = 'GENERATING'
      AND generation_lease_expires_at > ${input.now.toISOString()}`)
    .returning({ cacheKey: locationIntroductionCache.cacheKey });
  return updated.length === 1;
}
