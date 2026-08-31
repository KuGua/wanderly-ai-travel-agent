import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";
import { and, eq, gt } from "drizzle-orm";

import { db } from "../db/database.js";
import { providerOffers, providerSearchRuns } from "../db/schema.js";
import { metrics } from "../observability/metrics.js";
import type { HotelOfferProviderName, HotelProvider, ProviderResult } from "../providers/types.js";
import type { ConstraintSnapshotData, DestinationReference, HotelOffer } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";
import { resolveTripDestinationReference } from "./destination-reference-service.js";
import {
  claimProviderSearchCache,
  completeProviderSearchCache,
  expireProviderSearchCache,
  waitForProviderSearchCache,
  type ProviderCachePolicy,
} from "./provider-search-cache-service.js";

export const hotelSearchInputSchema = z.object({
  snapshotId: z.string().uuid(),
  destinationId: z.string().trim().min(1).max(128),
}).strict();
export const hotelSearchModelArgumentsSchema = hotelSearchInputSchema.omit({ snapshotId: true });
export type HotelSearchInput = z.infer<typeof hotelSearchInputSchema>;

export const hotelOfferSchema = z.object({
  id: z.string().uuid(), providerOfferId: z.string().min(1), queryId: z.string().uuid(),
  providerName: z.enum(["nuitee_connect", "serpapi_google_hotels"]),
  destinationId: z.string().min(1),
  propertyId: z.string().min(1), propertyName: z.string().min(1),
  checkIn: z.string(), checkOut: z.string(), nights: z.number().int().positive(),
  roomCount: z.number().int().positive(), adultsPerRoom: z.array(z.number().int().positive()),
  totalPrice: z.number().nonnegative(), pricePerNight: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  taxesAndFees: z.object({
    status: z.enum(["INCLUDED", "PARTIAL", "UNKNOWN"]),
    amount: z.number().nonnegative().optional(),
  }).strict(),
  cancellationSummary: z.string().nullable(), roomSummary: z.string().nullable(),
  source: z.string().min(1),
  capturedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const HOTEL_LIVE_CACHE_TTL_MS = 15 * 60_000;
export const HOTEL_NEGATIVE_CACHE_TTL_MS = 30_000;
export const HOTEL_CACHE_LEASE_MS = 35_000;
export const HOTEL_CACHE_WAIT_MS = 1_500;
export const HOTEL_CACHE_RETENTION_MS = 24 * 60 * 60_000;
const HOTEL_CACHE_POLL_MS = 100;
const MIN_REMAINING_OFFER_TTL_MS = 60_000;
const HOTEL_CACHE_POLICY: ProviderCachePolicy = {
  liveTtlMs: HOTEL_LIVE_CACHE_TTL_MS,
  negativeTtlMs: HOTEL_NEGATIVE_CACHE_TTL_MS,
  leaseMs: HOTEL_CACHE_LEASE_MS,
  waitMs: HOTEL_CACHE_WAIT_MS,
  retentionMs: HOTEL_CACHE_RETENTION_MS,
  pollMs: HOTEL_CACHE_POLL_MS,
};

export class HotelSearchAlreadyAttemptedError extends Error {
  constructor() {
    super("hotel.search may run at most once per destination in a planning run");
    this.name = "HotelSearchAlreadyAttemptedError";
  }
}

export function buildHotelSearchFingerprint(params: {
  provider: HotelOfferProviderName;
  destinationId: string;
  destinationReference?: DestinationReference | null;
  checkIn: string;
  checkOut: string;
  preferences: { roomCount: number; adultsPerRoom: number[]; currency: string };
  locale: "en" | "zh";
  quoteAuthorization?: { id: string; version: number };
}): string {
  return createHash("sha256").update(JSON.stringify({
    provider: params.provider,
    category: "hotel",
    destinationId: params.destinationId,
    destinationReference: params.destinationReference ?? null,
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    preferences: params.preferences,
    locale: params.locale,
    quoteAuthorization: params.quoteAuthorization ?? null,
  })).digest("hex");
}

export function validateSnapshotBoundHotelSearch(params: {
  input: unknown;
  snapshotId: string;
  snapshot: ConstraintSnapshotData;
}): HotelSearchInput {
  const input = hotelSearchInputSchema.parse(params.input);
  if (input.snapshotId !== params.snapshotId) throw new Error("hotel search snapshot does not match task snapshot");
  if (!params.snapshot.destinationCandidates.includes(input.destinationId)) {
    throw new Error("hotel search destination is not in snapshot candidates");
  }
  if (!params.snapshot.travelDateStart || !params.snapshot.travelDateEnd) {
    throw new Error("hotel search requires snapshot travel dates");
  }
  return input;
}

export async function executeAndPersistHotelSearch(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
  snapshot: ConstraintSnapshotData;
  preferences: { roomCount: number; adultsPerRoom: number[]; currency: string };
  locale: "en" | "zh";
  input: HotelSearchInput;
  provider: HotelProvider;
  /**
   * Server-resolved ISO-3166-1 alpha-2 nationality, decrypted from
   * `stay_search_provider_authorizations` by the skill handler. Required
   * by the Nuitee adapter; ignored by SerpApi. The service MUST NOT echo
   * the value into logs, traces, audit summaries, or metric labels.
   */
  quoteNationality?: string;
  /** Non-sensitive task-bound authorization pointer; isolates Nuitee cache entries. */
  quoteAuthorization?: { id: string; version: number };
  resolveDestinationReference?: typeof resolveTripDestinationReference;
  signal?: AbortSignal;
}): Promise<ProviderResult<HotelOffer[]> & { queryId?: string }> {
  if (params.provider.providerName === "unconfigured") {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
  // Runtime invariant: a LIVE result is only ever returned by a real adapter.
  // `UnavailableHotelProvider` (`providerName === "unconfigured"`) is the
  // sole carrier of the broader value and never produces offers, so the
  // narrowing cast below cannot mislabel a persisted offer.
  const providerName = params.provider.providerName as HotelOfferProviderName;
  const providerSource = params.provider.source;
  const destination = await (params.resolveDestinationReference ?? resolveTripDestinationReference)({
    tripId: params.tripId,
    destinationId: params.input.destinationId,
  });
  const fingerprint = buildHotelSearchFingerprint({
    provider: providerName,
    destinationId: params.input.destinationId,
    destinationReference: destination,
    checkIn: params.snapshot.travelDateStart!,
    checkOut: params.snapshot.travelDateEnd!,
    preferences: params.preferences,
    locale: params.locale,
    ...(params.quoteAuthorization ? { quoteAuthorization: params.quoteAuthorization } : {}),
  });
  const [reservedRun] = await db.insert(providerSearchRuns).values({
    snapshotId: params.snapshotId,
    agentTaskRunId: params.agentTaskRunId ?? null,
    category: "hotel",
    providerName,
    destinationId: params.input.destinationId,
    requestFingerprint: fingerprint,
    outcome: "PENDING",
  }).onConflictDoNothing().returning();
  if (!reservedRun) throw new HotelSearchAlreadyAttemptedError();

  await recordAudit({
    ctx: params.ctx,
    action: "HOTEL_SEARCH_REQUESTED",
    tripId: params.tripId,
    summary: { provider: providerName, operation: "hotel_search" },
  });

  let cacheDecision = await claimProviderSearchCache({
    requestFingerprint: fingerprint,
    providerName,
    category: "hotel",
    now: new Date(),
    policy: HOTEL_CACHE_POLICY,
  });
  if (cacheDecision.kind === "PENDING") {
    cacheDecision = await waitForProviderSearchCache({
      requestFingerprint: fingerprint,
      providerName,
      category: "hotel",
      policy: HOTEL_CACHE_POLICY,
    });
  }
  if (cacheDecision.kind === "LIVE") {
    const cachedOffers = await copyCachedOffers({
      sourceSearchRunId: cacheDecision.sourceSearchRunId,
      currentSearchRunId: reservedRun.id,
      now: new Date(),
    });
    if (cachedOffers) {
      metrics.inc("provider_search_cache_total", { category: "hotel", outcome: "hit_live" });
      await finalizeSearchRun({
        params, runId: reservedRun.id, providerName, providerSource, result: {
          outcome: "LIVE", data: cachedOffers, source: providerSource,
          capturedAt: cacheDecision.capturedAt.toISOString(),
        },
        capturedAt: cacheDecision.capturedAt,
      });
      return {
        outcome: "LIVE", data: cachedOffers, source: providerSource,
        capturedAt: cacheDecision.capturedAt.toISOString(), queryId: reservedRun.id,
      };
    }
    // A dangling/expired source row must never be served. Expire the cache
    // entry and attempt one race-safe takeover before contacting the provider.
    await expireProviderSearchCache(fingerprint);
    cacheDecision = await claimProviderSearchCache({
      requestFingerprint: fingerprint,
      providerName,
      category: "hotel",
      now: new Date(),
      policy: HOTEL_CACHE_POLICY,
    });
  }
  if (cacheDecision.kind === "UNAVAILABLE") {
    metrics.inc("provider_search_cache_total", { category: "hotel", outcome: "hit_unavailable" });
    const result = { outcome: "UNAVAILABLE" as const, reason: cacheDecision.reason };
    await finalizeSearchRun({ params, runId: reservedRun.id, providerName, providerSource, result, capturedAt: cacheDecision.capturedAt });
    return result;
  }
  if (cacheDecision.kind === "PENDING") {
    metrics.inc("provider_search_cache_total", { category: "hotel", outcome: "wait_timeout" });
    const result = { outcome: "UNAVAILABLE" as const, reason: "UPSTREAM_TIMEOUT" as const };
    await finalizeSearchRun({ params, runId: reservedRun.id, providerName, providerSource, result, capturedAt: new Date() });
    return result;
  }

  metrics.inc("provider_search_cache_total", { category: "hotel", outcome: "miss" });
  const result = destination ? await params.provider.searchHotels({
    destination,
    checkIn: params.snapshot.travelDateStart!,
    checkOut: params.snapshot.travelDateEnd!,
    roomCount: params.preferences.roomCount,
    adultsPerRoom: params.preferences.adultsPerRoom,
    currency: params.preferences.currency,
    locale: params.locale,
    ...(params.quoteNationality ? { quoteNationality: params.quoteNationality } : {}),
    signal: params.signal,
  }) : { outcome: "UNAVAILABLE" as const, reason: "SEARCH_CONSTRAINTS_INCOMPLETE" as const };
  const capturedAt = result.outcome === "LIVE" ? new Date(result.capturedAt) : new Date();
  const offers: HotelOffer[] = result.outcome === "LIVE"
    ? result.data.map((item) => ({ id: randomUUID(), queryId: reservedRun.id, providerName, source: providerSource, ...item }))
    : [];
  await finalizeSearchRun({
    params,
    runId: reservedRun.id,
    providerName,
    providerSource,
    result: result.outcome === "LIVE" ? { ...result, data: offers } : result,
    capturedAt,
  });
  await completeProviderSearchCache({
    requestFingerprint: fingerprint,
    runId: reservedRun.id,
    result,
    capturedAt,
    policy: HOTEL_CACHE_POLICY,
    ...(offers.length > 0 ? {
      liveExpiresAt: new Date(Math.min(...offers.map((offer) => Date.parse(offer.expiresAt)))),
    } : {}),
  });
  return result.outcome === "LIVE"
    ? { outcome: "LIVE", data: offers, source: providerSource, capturedAt: result.capturedAt, queryId: reservedRun.id }
    : result;
}

async function copyCachedOffers(params: {
  sourceSearchRunId: string;
  currentSearchRunId: string;
  now: Date;
}): Promise<HotelOffer[] | null> {
  const rows = await db.select({ offerData: providerOffers.offerData }).from(providerOffers).where(and(
    eq(providerOffers.searchRunId, params.sourceSearchRunId),
    eq(providerOffers.category, "hotel"),
    gt(providerOffers.expiresAt, new Date(params.now.getTime() + MIN_REMAINING_OFFER_TTL_MS)),
  ));
  if (rows.length === 0 || rows.length > 10) return null;
  const parsed = rows.map((row) => hotelOfferSchema.safeParse(row.offerData));
  if (parsed.some((item) => !item.success)) return null;
  return parsed.map((item) => ({
    ...item.data!, id: randomUUID(), queryId: params.currentSearchRunId,
  }));
}

async function finalizeSearchRun(params: {
  params: Parameters<typeof executeAndPersistHotelSearch>[0];
  runId: string;
  providerName: HotelOfferProviderName;
  providerSource: string;
  result: ProviderResult<HotelOffer[]>;
  capturedAt: Date;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(providerSearchRuns).set({
      outcome: params.result.outcome,
      errorCode: params.result.outcome === "UNAVAILABLE" ? params.result.reason : null,
      capturedAt: params.capturedAt,
    }).where(eq(providerSearchRuns.id, params.runId));
    if (params.result.outcome === "LIVE" && params.result.data.length > 0) {
      await tx.insert(providerOffers).values(params.result.data.map((offer) => ({
        snapshotId: params.params.snapshotId,
        searchRunId: params.runId,
        category: "hotel",
        providerName: offer.providerName,
        providerOfferId: offer.providerOfferId,
        currency: offer.currency,
        expiresAt: new Date(offer.expiresAt),
        offerData: offer as unknown as Record<string, unknown>,
        capturedAt: new Date(offer.capturedAt),
      })));
    }
    await recordAudit({
      ctx: params.params.ctx,
      action: params.result.outcome === "LIVE" ? "HOTEL_SEARCH_COMPLETED" : "HOTEL_SEARCH_UNAVAILABLE",
      tripId: params.params.tripId,
      summary: {
        provider: params.providerName,
        outcome: params.result.outcome,
        ...(params.result.outcome === "UNAVAILABLE" ? { errorCode: params.result.reason } : {}),
      },
      tx,
    });
  });
  metrics.inc("hotel_tool_invocations_total", {
    outcome: params.result.outcome === "LIVE" ? "live" : "unavailable",
    provider: params.providerName,
    error_category: params.result.outcome === "LIVE" ? "none" : params.result.reason.toLowerCase(),
  });
}
