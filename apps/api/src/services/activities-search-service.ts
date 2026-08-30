import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { db } from "../db/database.js";
import { providerOffers, providerSearchRuns } from "../db/schema.js";
import { metrics } from "../observability/metrics.js";
import type { ActivitiesProvider, ProviderResult } from "../providers/types.js";
import type { ActivityEvidence, ConstraintSnapshotData } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";

const activityThemeSchema = z.enum(["CULTURE", "FOOD", "OUTDOOR", "FAMILY"]);

export const activitiesSearchInputSchema = z.object({
  snapshotId: z.string().uuid(),
  destinationId: z.string().trim().min(1).max(128),
  theme: activityThemeSchema.optional(),
  locale: z.enum(["en", "zh"]),
}).strict();

export const activitiesSearchModelArgumentsSchema = activitiesSearchInputSchema.omit({ snapshotId: true });

export type ActivitiesSearchInput = z.infer<typeof activitiesSearchInputSchema>;

export function validateSnapshotBoundActivitiesSearch(params: {
  input: unknown;
  snapshotId: string;
  snapshot: ConstraintSnapshotData;
}): ActivitiesSearchInput {
  const input = activitiesSearchInputSchema.parse(params.input);
  if (input.snapshotId !== params.snapshotId) {
    throw new Error("activities search snapshot does not match task snapshot");
  }
  if (!params.snapshot.destinationCandidates.includes(input.destinationId)) {
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
  provider: ActivitiesProvider;
  signal?: AbortSignal;
}): Promise<ProviderResult<ActivityEvidence[]> & { queryId?: string }> {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    destinationId: params.input.destinationId,
    dateStart: params.snapshot.travelDateStart,
    dateEnd: params.snapshot.travelDateEnd,
    theme: params.input.theme ?? null,
    locale: params.input.locale,
  })).digest("hex");
  await recordAudit({
    ctx: params.ctx,
    action: "ACTIVITIES_SEARCH_REQUESTED",
    tripId: params.tripId,
    summary: { provider: "viator_mcp", operation: "activities_search" },
  });

  const result = await params.provider.searchActivities({
    destination: params.input.destinationId,
    dateStart: params.snapshot.travelDateStart!,
    dateEnd: params.snapshot.travelDateEnd!,
    theme: params.input.theme,
    locale: params.input.locale,
    limit: 5,
    signal: params.signal,
  });

  const persisted = await db.transaction(async (tx) => {
    const [run] = await tx.insert(providerSearchRuns).values({
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId ?? null,
      category: "activity",
      providerName: "viator_mcp",
      destinationId: params.input.destinationId,
      requestFingerprint: fingerprint,
      outcome: result.outcome,
      errorCode: result.outcome === "UNAVAILABLE" ? result.reason : null,
    }).returning();

    const evidence: ActivityEvidence[] = result.outcome === "LIVE"
      ? result.data.map((item) => ({
          id: randomUUID(),
          providerOfferId: item.providerOfferId,
          providerName: "viator",
          queryId: run.id,
          destination: params.input.destinationId,
          title: item.title,
          thumbnailUrl: item.thumbnailUrl,
          rating: item.rating,
          reviewCount: item.reviewCount,
          freeCancellation: item.freeCancellation,
          durationMinutes: item.durationMinutes,
          category: item.category,
          source: "Viator Experiences MCP",
          capturedAt: result.capturedAt,
          expiresAt: new Date(Date.parse(result.capturedAt) + 15 * 60_000).toISOString(),
        }))
      : [];

    if (evidence.length > 0) {
      await tx.insert(providerOffers).values(evidence.map((offer) => ({
        snapshotId: params.snapshotId,
        searchRunId: run.id,
        category: "activity",
        providerName: "viator_mcp",
        providerOfferId: offer.providerOfferId,
        currency: null,
        expiresAt: new Date(offer.expiresAt),
        offerData: offer as unknown as Record<string, unknown>,
        capturedAt: new Date(offer.capturedAt),
      })));
    }

    await recordAudit({
      ctx: params.ctx,
      action: result.outcome === "LIVE"
        ? "ACTIVITIES_SEARCH_COMPLETED"
        : "ACTIVITIES_SEARCH_UNAVAILABLE",
      tripId: params.tripId,
      summary: {
        provider: "viator_mcp",
        outcome: result.outcome,
        ...(result.outcome === "UNAVAILABLE" ? { errorCode: result.reason } : {}),
      },
      tx,
    });
    return { run, evidence };
  });

  metrics.inc("activities_tool_invocations_total", {
    outcome: result.outcome === "LIVE" ? "live" : "unavailable",
    provider: "viator_mcp",
    error_category: result.outcome === "LIVE" ? "none" : result.reason.toLowerCase(),
  });
  return result.outcome === "LIVE"
    ? {
        outcome: "LIVE",
        data: persisted.evidence,
        source: result.source,
        capturedAt: result.capturedAt,
        queryId: persisted.run.id,
      }
    : result;
}
