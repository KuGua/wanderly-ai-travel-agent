import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";
import { and, eq, gt } from "drizzle-orm";

import { db } from "../db/database.js";
import { providerOffers, providerSearchRuns } from "../db/schema.js";
import { metrics } from "../observability/metrics.js";
import type { ActivitiesProvider, ProviderResult } from "../providers/types.js";
import type { ActivityEvidence, ConstraintSnapshotData } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";
import { matchesSnapshotDestination } from "./destination-candidate-match.js";
import { recordAudit } from "./audit-service.js";
import {
  claimProviderSearchCache,
  completeProviderSearchCache,
  expireProviderSearchCache,
  waitForProviderSearchCache,
  type ProviderCachePolicy,
} from "./provider-search-cache-service.js";

const activityThemeSchema = z.enum(["CULTURE", "FOOD", "OUTDOOR", "FAMILY"]);

export const activitiesSearchInputSchema = z.object({
  snapshotId: z.string().uuid(),
  destinationId: z.string().trim().min(1).max(128),
  theme: activityThemeSchema.optional(),
  locale: z.enum(["en", "zh"]),
}).strict();

export const activitiesSearchModelArgumentsSchema = activitiesSearchInputSchema.omit({ snapshotId: true });

export type ActivitiesSearchInput = z.infer<typeof activitiesSearchInputSchema>;

export const activityEvidenceSchema = z.object({
  id: z.string().uuid(),
  providerOfferId: z.string().min(1),
  providerName: z.literal("viator"),
  queryId: z.string().uuid(),
  destination: z.string().min(1).max(128),
  title: z.string().min(1).max(512),
  thumbnailUrl: z.string().url(),
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative(),
  freeCancellation: z.boolean(),
  durationMinutes: z.object({
    fixed: z.number().int().nonnegative().nullable(),
    from: z.number().int().nonnegative().nullable(),
    to: z.number().int().nonnegative().nullable(),
  }).strict(),
  category: z.string().min(1).nullable(),
  // Price and currency travel together or not at all: an amount without a
  // stated denomination is what made this field unusable before.
  fromPrice: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  source: z.literal("Viator Experiences MCP"),
  capturedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

const ACTIVITY_CACHE_POLICY: ProviderCachePolicy = {
  liveTtlMs: 15 * 60_000,
  negativeTtlMs: 30_000,
  leaseMs: 35_000,
  waitMs: 1_500,
  retentionMs: 24 * 60 * 60_000,
  pollMs: 100,
};
const MIN_REMAINING_EVIDENCE_TTL_MS = 60_000;

export class ActivitiesSearchAlreadyAttemptedError extends Error {
  constructor() {
    super("activities.search may run only once per exact request in a planning run");
    this.name = "ActivitiesSearchAlreadyAttemptedError";
  }
}

export function validateSnapshotBoundActivitiesSearch(params: {
  input: unknown;
  snapshotId: string;
  snapshot: ConstraintSnapshotData;
}): ActivitiesSearchInput {
  const input = activitiesSearchInputSchema.parse(params.input);
  if (input.snapshotId !== params.snapshotId) {
    throw new Error("activities search snapshot does not match task snapshot");
  }
  if (!matchesSnapshotDestination(params.snapshot.destinationCandidates, input.destinationId)) {
    throw new Error("activities search destination is not in snapshot candidates");
  }
  if (!params.snapshot.travelDateStart || !params.snapshot.travelDateEnd) {
    throw new Error("activities search requires snapshot travel dates");
  }
  return input;
}

export async function executeAndPersistActivitiesSearch(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
  snapshot: ConstraintSnapshotData;
  input: ActivitiesSearchInput;
  /** ISO-4217 from the trip's confirmed preferences; never model-supplied. */
  currency: string;
  provider: ActivitiesProvider;
  signal?: AbortSignal;
}): Promise<ProviderResult<ActivityEvidence[]> & { queryId?: string }> {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    provider: "viator_mcp",
    category: "activity",
    destinationId: params.input.destinationId,
    dateStart: params.snapshot.travelDateStart,
    dateEnd: params.snapshot.travelDateEnd,
    theme: params.input.theme ?? null,
    locale: params.input.locale,
    // Part of the fingerprint: the same search priced in another currency is a
    // different result, and reusing a cached one would restate the amount in
    // the wrong denomination.
    currency: params.currency,
  })).digest("hex");
  const [reservedRun] = await db.insert(providerSearchRuns).values({
    snapshotId: params.snapshotId,
    agentTaskRunId: params.agentTaskRunId ?? null,
    category: "activity",
    providerName: "viator_mcp",
    destinationId: params.input.destinationId,
    requestFingerprint: fingerprint,
    outcome: "PENDING",
  }).onConflictDoNothing().returning();
  if (!reservedRun) throw new ActivitiesSearchAlreadyAttemptedError();

  await recordAudit({
    ctx: params.ctx,
    action: "ACTIVITIES_SEARCH_REQUESTED",
    tripId: params.tripId,
    summary: { provider: "viator_mcp", operation: "activities_search" },
  });

  let cacheDecision = await claimProviderSearchCache({
    requestFingerprint: fingerprint,
    providerName: "viator_mcp",
    category: "activity",
    now: new Date(),
    policy: ACTIVITY_CACHE_POLICY,
  });
  if (cacheDecision.kind === "PENDING") {
    cacheDecision = await waitForProviderSearchCache({
      requestFingerprint: fingerprint,
      providerName: "viator_mcp",
      category: "activity",
      policy: ACTIVITY_CACHE_POLICY,
    });
  }
  if (cacheDecision.kind === "LIVE") {
    const cached = await copyCachedActivityEvidence({
      sourceSearchRunId: cacheDecision.sourceSearchRunId,
      currentSearchRunId: reservedRun.id,
      now: new Date(),
    });
    if (cached) {
      metrics.inc("provider_search_cache_total", { category: "activity", outcome: "hit_live" });
      await finalizeActivitySearch({ params, runId: reservedRun.id, result: {
        outcome: "LIVE", data: cached, source: "Viator Experiences MCP", capturedAt: cacheDecision.capturedAt.toISOString(),
      }, capturedAt: cacheDecision.capturedAt });
      return { outcome: "LIVE", data: cached, source: "Viator Experiences MCP", capturedAt: cacheDecision.capturedAt.toISOString(), queryId: reservedRun.id };
    }
    await expireProviderSearchCache(fingerprint);
    cacheDecision = await claimProviderSearchCache({
      requestFingerprint: fingerprint,
      providerName: "viator_mcp",
      category: "activity",
      now: new Date(),
      policy: ACTIVITY_CACHE_POLICY,
    });
  }
  if (cacheDecision.kind === "UNAVAILABLE") {
    metrics.inc("provider_search_cache_total", { category: "activity", outcome: "hit_unavailable" });
    const result = { outcome: "UNAVAILABLE" as const, reason: cacheDecision.reason };
    await finalizeActivitySearch({ params, runId: reservedRun.id, result, capturedAt: cacheDecision.capturedAt });
    return result;
  }
  if (cacheDecision.kind === "PENDING") {
    metrics.inc("provider_search_cache_total", { category: "activity", outcome: "wait_timeout" });
    const result = { outcome: "UNAVAILABLE" as const, reason: "UPSTREAM_TIMEOUT" as const };
    await finalizeActivitySearch({ params, runId: reservedRun.id, result, capturedAt: new Date() });
    return result;
  }

  metrics.inc("provider_search_cache_total", { category: "activity", outcome: "miss" });
  const result = await params.provider.searchActivities({
    destination: params.input.destinationId,
    dateStart: params.snapshot.travelDateStart!,
    dateEnd: params.snapshot.travelDateEnd!,
    theme: params.input.theme,
    locale: params.input.locale,
    currency: params.currency,
    limit: 5,
    signal: params.signal,
  });

  const capturedAt = result.outcome === "LIVE" ? new Date(result.capturedAt) : new Date();
  const evidence: ActivityEvidence[] = result.outcome === "LIVE"
      ? result.data.map((item) => ({
          id: randomUUID(),
          providerOfferId: item.providerOfferId,
          providerName: "viator",
          queryId: reservedRun.id,
          destination: params.input.destinationId,
          title: item.title,
          thumbnailUrl: item.thumbnailUrl,
          rating: item.rating,
          reviewCount: item.reviewCount,
          freeCancellation: item.freeCancellation,
          durationMinutes: item.durationMinutes,
          category: item.category,
          fromPrice: item.fromPrice,
          currency: item.currency,
          source: "Viator Experiences MCP",
          capturedAt: result.capturedAt,
          expiresAt: new Date(Date.parse(result.capturedAt) + 15 * 60_000).toISOString(),
        }))
      : [];
  await finalizeActivitySearch({
    params,
    runId: reservedRun.id,
    result: result.outcome === "LIVE" ? { ...result, data: evidence } : result,
    capturedAt,
  });
  await completeProviderSearchCache({
    requestFingerprint: fingerprint,
    runId: reservedRun.id,
    result,
    capturedAt,
    policy: ACTIVITY_CACHE_POLICY,
    ...(evidence.length > 0 ? {
      liveExpiresAt: new Date(Math.min(...evidence.map((item) => Date.parse(item.expiresAt)))),
    } : {}),
  });

  metrics.inc("activities_tool_invocations_total", {
    outcome: result.outcome === "LIVE" ? "live" : "unavailable",
    provider: "viator_mcp",
    error_category: result.outcome === "LIVE" ? "none" : result.reason.toLowerCase(),
  });
  return result.outcome === "LIVE"
    ? {
        outcome: "LIVE",
        data: evidence,
        source: result.source,
        capturedAt: result.capturedAt,
        queryId: reservedRun.id,
      }
    : result;
}

async function copyCachedActivityEvidence(params: {
  sourceSearchRunId: string;
  currentSearchRunId: string;
  now: Date;
}): Promise<ActivityEvidence[] | null> {
  const rows = await db.select({ offerData: providerOffers.offerData }).from(providerOffers).where(and(
    eq(providerOffers.searchRunId, params.sourceSearchRunId),
    eq(providerOffers.category, "activity"),
    gt(providerOffers.expiresAt, new Date(params.now.getTime() + MIN_REMAINING_EVIDENCE_TTL_MS)),
  ));
  if (rows.length === 0 || rows.length > 5) return null;
  const parsed = rows.map((row) => activityEvidenceSchema.safeParse(row.offerData));
  if (parsed.some((item) => !item.success)) return null;
  return parsed.map((item) => ({ ...item.data!, id: randomUUID(), queryId: params.currentSearchRunId }));
}

async function finalizeActivitySearch(params: {
  params: Parameters<typeof executeAndPersistActivitiesSearch>[0];
  runId: string;
  result: ProviderResult<ActivityEvidence[]>;
  capturedAt: Date;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(providerSearchRuns).set({
      outcome: params.result.outcome,
      errorCode: params.result.outcome === "UNAVAILABLE" ? params.result.reason : null,
      capturedAt: params.capturedAt,
    }).where(eq(providerSearchRuns.id, params.runId));
    if (params.result.outcome === "LIVE") {
      await tx.insert(providerOffers).values(params.result.data.map((offer) => ({
        snapshotId: params.params.snapshotId,
        searchRunId: params.runId,
        category: "activity",
        providerName: "viator_mcp",
        providerOfferId: offer.providerOfferId,
        // Activities now carry a stated currency, so the offer row records it
        // rather than leaving the amount undenominated.
        currency: offer.currency,
        expiresAt: new Date(offer.expiresAt),
        offerData: offer as unknown as Record<string, unknown>,
        capturedAt: new Date(offer.capturedAt),
      })));
    }
    await recordAudit({
      ctx: params.params.ctx,
      action: params.result.outcome === "LIVE" ? "ACTIVITIES_SEARCH_COMPLETED" : "ACTIVITIES_SEARCH_UNAVAILABLE",
      tripId: params.params.tripId,
      summary: {
        provider: "viator_mcp",
        outcome: params.result.outcome,
        ...(params.result.outcome === "UNAVAILABLE" ? { errorCode: params.result.reason } : {}),
      },
      tx,
    });
  });
}
