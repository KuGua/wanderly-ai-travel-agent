import { createHash, randomUUID } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/database.js";
import { providerOffers, providerSearchRuns } from "../db/schema.js";
import { metrics } from "../observability/metrics.js";
import type { AccommodationDiscoveryProvider, ProviderResult } from "../providers/types.js";
import type { AccommodationEvidence, ConstraintSnapshotData } from "../types/domain.js";
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

export const accommodationDiscoveryInputSchema = z.object({
  snapshotId: z.string().uuid(),
  destinationId: z.string().trim().min(1).max(128),
}).strict();
export const accommodationDiscoveryModelArgumentsSchema = accommodationDiscoveryInputSchema.omit({ snapshotId: true });
export type AccommodationDiscoveryInput = z.infer<typeof accommodationDiscoveryInputSchema>;

export const accommodationEvidenceSchema = z.object({
  id: z.string().uuid(),
  queryId: z.string().uuid(),
  providerPlaceId: z.string().min(1).max(256),
  destinationId: z.string().min(1).max(128),
  name: z.string().min(1).max(512),
  kind: z.string().min(1).max(256),
  longitude: z.number().finite().min(-180).max(180),
  latitude: z.number().finite().min(-90).max(90),
  distanceMeters: z.number().int().nonnegative().nullable(),
  popularityTier: z.number().int().min(1).max(3).nullable(),
  source: z.literal("OpenTripMap"),
  attribution: z.literal("© OpenStreetMap contributors"),
  capturedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

const CACHE_POLICY: ProviderCachePolicy = {
  liveTtlMs: 24 * 60 * 60_000,
  negativeTtlMs: 30_000,
  leaseMs: 35_000,
  waitMs: 1_500,
  retentionMs: 7 * 24 * 60 * 60_000,
  pollMs: 100,
};
const MIN_REMAINING_TTL_MS = 60_000;
const RESULT_LIMIT = 20;

export class AccommodationDiscoveryAlreadyAttemptedError extends Error {
  constructor() {
    super("accommodation.discover may run at most once per destination in a planning run");
    this.name = "AccommodationDiscoveryAlreadyAttemptedError";
  }
}

export function validateSnapshotBoundAccommodationDiscovery(params: {
  input: unknown;
  snapshotId: string;
  snapshot: ConstraintSnapshotData;
}): AccommodationDiscoveryInput {
  const input = accommodationDiscoveryInputSchema.parse(params.input);
  if (input.snapshotId !== params.snapshotId) throw new Error("accommodation discovery snapshot does not match task snapshot");
  if (!params.snapshot.destinationCandidates.includes(input.destinationId)) {
    throw new Error("accommodation discovery destination is not in snapshot candidates");
  }
  return input;
}

export async function executeAndPersistAccommodationDiscovery(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
  input: AccommodationDiscoveryInput;
  provider: AccommodationDiscoveryProvider;
  resolveDestinationReference?: typeof resolveTripDestinationReference;
  signal?: AbortSignal;
}): Promise<ProviderResult<AccommodationEvidence[]> & { queryId?: string }> {
  const destination = await (params.resolveDestinationReference ?? resolveTripDestinationReference)({
    tripId: params.tripId,
    destinationId: params.input.destinationId,
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({
    provider: "opentripmap",
    category: "accommodation",
    destination,
    limit: RESULT_LIMIT,
    contractVersion: 1,
  })).digest("hex");
  const [reservedRun] = await db.insert(providerSearchRuns).values({
    snapshotId: params.snapshotId,
    agentTaskRunId: params.agentTaskRunId ?? null,
    category: "accommodation",
    providerName: "opentripmap",
    destinationId: params.input.destinationId,
    requestFingerprint: fingerprint,
    outcome: "PENDING",
  }).onConflictDoNothing().returning();
  if (!reservedRun) throw new AccommodationDiscoveryAlreadyAttemptedError();

  await recordAudit({
    ctx: params.ctx,
    action: "ACCOMMODATION_DISCOVERY_REQUESTED",
    tripId: params.tripId,
    summary: { provider: "opentripmap", operation: "accommodation_discovery" },
  });

  let decision = await claimProviderSearchCache({
    requestFingerprint: fingerprint,
    providerName: "opentripmap",
    category: "accommodation",
    now: new Date(),
    policy: CACHE_POLICY,
  });
  if (decision.kind === "PENDING") {
    decision = await waitForProviderSearchCache({
      requestFingerprint: fingerprint,
      providerName: "opentripmap",
      category: "accommodation",
      policy: CACHE_POLICY,
    });
  }
  if (decision.kind === "LIVE") {
    const cached = await copyCachedEvidence(decision.sourceSearchRunId, reservedRun.id, new Date());
    if (cached) {
      metrics.inc("provider_search_cache_total", { category: "accommodation", outcome: "hit_live" });
      await finalize({ params, runId: reservedRun.id, result: {
        outcome: "LIVE", data: cached, source: "OpenTripMap", capturedAt: decision.capturedAt.toISOString(),
      }, capturedAt: decision.capturedAt });
      return { outcome: "LIVE", data: cached, source: "OpenTripMap", capturedAt: decision.capturedAt.toISOString(), queryId: reservedRun.id };
    }
    await expireProviderSearchCache(fingerprint);
    decision = await claimProviderSearchCache({
      requestFingerprint: fingerprint,
      providerName: "opentripmap",
      category: "accommodation",
      now: new Date(),
      policy: CACHE_POLICY,
    });
  }
  if (decision.kind === "UNAVAILABLE") {
    metrics.inc("provider_search_cache_total", { category: "accommodation", outcome: "hit_unavailable" });
    const result = { outcome: "UNAVAILABLE" as const, reason: decision.reason };
    await finalize({ params, runId: reservedRun.id, result, capturedAt: decision.capturedAt });
    return result;
  }
  if (decision.kind === "PENDING") {
    metrics.inc("provider_search_cache_total", { category: "accommodation", outcome: "wait_timeout" });
    const result = { outcome: "UNAVAILABLE" as const, reason: "UPSTREAM_TIMEOUT" as const };
    await finalize({ params, runId: reservedRun.id, result, capturedAt: new Date() });
    return result;
  }

  metrics.inc("provider_search_cache_total", { category: "accommodation", outcome: "miss" });
  const providerResult = destination
    ? await params.provider.discoverAccommodations({ destination, limit: RESULT_LIMIT, signal: params.signal })
    : { outcome: "UNAVAILABLE" as const, reason: "SEARCH_CONSTRAINTS_INCOMPLETE" as const };
  const capturedAt = providerResult.outcome === "LIVE" ? new Date(providerResult.capturedAt) : new Date();
  const evidence: AccommodationEvidence[] = providerResult.outcome === "LIVE"
    ? providerResult.data.map((item) => ({
        id: randomUUID(),
        queryId: reservedRun.id,
        providerPlaceId: item.providerPlaceId,
        destinationId: params.input.destinationId,
        name: item.name,
        kind: item.kind,
        longitude: item.longitude,
        latitude: item.latitude,
        distanceMeters: item.distanceMeters,
        popularityTier: item.popularityTier,
        source: item.source,
        attribution: item.attribution,
        capturedAt: item.capturedAt,
        expiresAt: new Date(Date.parse(item.capturedAt) + CACHE_POLICY.liveTtlMs).toISOString(),
      }))
    : [];
  const normalizedResult: ProviderResult<AccommodationEvidence[]> = providerResult.outcome === "LIVE"
    ? { ...providerResult, data: evidence }
    : providerResult;
  await finalize({ params, runId: reservedRun.id, result: normalizedResult, capturedAt });
  await completeProviderSearchCache({
    requestFingerprint: fingerprint,
    runId: reservedRun.id,
    result: providerResult,
    capturedAt,
    policy: CACHE_POLICY,
    ...(evidence.length > 0 ? { liveExpiresAt: new Date(evidence[0].expiresAt) } : {}),
  });
  return normalizedResult.outcome === "LIVE" ? { ...normalizedResult, queryId: reservedRun.id } : normalizedResult;
}

async function copyCachedEvidence(sourceSearchRunId: string, currentSearchRunId: string, now: Date): Promise<AccommodationEvidence[] | null> {
  const rows = await db.select({ offerData: providerOffers.offerData }).from(providerOffers).where(and(
    eq(providerOffers.searchRunId, sourceSearchRunId),
    eq(providerOffers.category, "accommodation"),
    gt(providerOffers.expiresAt, new Date(now.getTime() + MIN_REMAINING_TTL_MS)),
  ));
  if (rows.length === 0 || rows.length > RESULT_LIMIT) return null;
  const parsed = rows.map((row) => accommodationEvidenceSchema.safeParse(row.offerData));
  if (parsed.some((item) => !item.success)) return null;
  return parsed.map((item) => ({ ...item.data!, id: randomUUID(), queryId: currentSearchRunId }));
}

async function finalize(params: {
  params: Parameters<typeof executeAndPersistAccommodationDiscovery>[0];
  runId: string;
  result: ProviderResult<AccommodationEvidence[]>;
  capturedAt: Date;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(providerSearchRuns).set({
      outcome: params.result.outcome,
      errorCode: params.result.outcome === "UNAVAILABLE" ? params.result.reason : null,
      capturedAt: params.capturedAt,
    }).where(eq(providerSearchRuns.id, params.runId));
    if (params.result.outcome === "LIVE") {
      await tx.insert(providerOffers).values(params.result.data.map((item) => ({
        snapshotId: params.params.snapshotId,
        searchRunId: params.runId,
        category: "accommodation",
        providerName: "opentripmap",
        providerOfferId: item.providerPlaceId,
        currency: null,
        expiresAt: new Date(item.expiresAt),
        offerData: item as unknown as Record<string, unknown>,
        capturedAt: new Date(item.capturedAt),
      })));
    }
    await recordAudit({
      ctx: params.params.ctx,
      action: params.result.outcome === "LIVE" ? "ACCOMMODATION_DISCOVERY_COMPLETED" : "ACCOMMODATION_DISCOVERY_UNAVAILABLE",
      tripId: params.params.tripId,
      summary: {
        provider: "opentripmap",
        outcome: params.result.outcome,
        ...(params.result.outcome === "UNAVAILABLE" ? { errorCode: params.result.reason } : {}),
      },
      tx,
    });
  });
  metrics.inc("accommodation_tool_invocations_total", {
    outcome: params.result.outcome === "LIVE" ? "live" : "unavailable",
    provider: "opentripmap",
    error_category: params.result.outcome === "LIVE" ? "none" : params.result.reason.toLowerCase(),
  });
}
