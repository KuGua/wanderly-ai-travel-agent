import { and, eq, lt, lte } from "drizzle-orm";

import { db } from "../db/database.js";
import { providerSearchCache } from "../db/schema.js";
import type { ProviderResult } from "../providers/types.js";

type UnavailableReason = Extract<ProviderResult<never>, { outcome: "UNAVAILABLE" }>["reason"];

export interface ProviderCachePolicy {
  liveTtlMs: number;
  negativeTtlMs: number;
  leaseMs: number;
  waitMs: number;
  retentionMs: number;
  pollMs?: number;
}

export type ProviderCacheDecision =
  | { kind: "OWNER" }
  | { kind: "PENDING" }
  | { kind: "LIVE"; sourceSearchRunId: string; capturedAt: Date }
  | { kind: "UNAVAILABLE"; reason: UnavailableReason; capturedAt: Date };

export async function claimProviderSearchCache(params: {
  requestFingerprint: string;
  providerName: string;
  category: string;
  now: Date;
  policy: ProviderCachePolicy;
}): Promise<ProviderCacheDecision> {
  await db.delete(providerSearchCache).where(lt(
    providerSearchCache.expiresAt,
    new Date(params.now.getTime() - params.policy.retentionMs),
  ));
  return db.transaction(async (tx) => {
    const leaseExpiresAt = new Date(params.now.getTime() + params.policy.leaseMs);
    const [inserted] = await tx.insert(providerSearchCache).values({
      requestFingerprint: params.requestFingerprint,
      providerName: params.providerName,
      category: params.category,
      state: "PENDING",
      capturedAt: params.now,
      expiresAt: leaseExpiresAt,
      leaseExpiresAt,
    }).onConflictDoNothing().returning({ requestFingerprint: providerSearchCache.requestFingerprint });
    if (inserted) return { kind: "OWNER" };

    const [existing] = await tx.select().from(providerSearchCache).where(and(
      eq(providerSearchCache.requestFingerprint, params.requestFingerprint),
      eq(providerSearchCache.providerName, params.providerName),
      eq(providerSearchCache.category, params.category),
    )).limit(1);
    if (existing && existing.expiresAt.getTime() > params.now.getTime()) return decisionFromRow(existing);

    const [takenOver] = await tx.update(providerSearchCache).set({
      providerName: params.providerName,
      category: params.category,
      state: "PENDING",
      sourceSearchRunId: null,
      errorCode: null,
      capturedAt: params.now,
      expiresAt: leaseExpiresAt,
      leaseExpiresAt,
      updatedAt: params.now,
    }).where(and(
      eq(providerSearchCache.requestFingerprint, params.requestFingerprint),
      lte(providerSearchCache.expiresAt, params.now),
    )).returning({ requestFingerprint: providerSearchCache.requestFingerprint });
    return takenOver ? { kind: "OWNER" } : { kind: "PENDING" };
  });
}

export async function waitForProviderSearchCache(params: {
  requestFingerprint: string;
  providerName: string;
  category: string;
  policy: ProviderCachePolicy;
}): Promise<ProviderCacheDecision> {
  const deadline = Date.now() + params.policy.waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, params.policy.pollMs ?? 100));
    const [row] = await db.select().from(providerSearchCache).where(and(
      eq(providerSearchCache.requestFingerprint, params.requestFingerprint),
      eq(providerSearchCache.providerName, params.providerName),
      eq(providerSearchCache.category, params.category),
    )).limit(1);
    if (row && row.state !== "PENDING" && row.expiresAt.getTime() > Date.now()) return decisionFromRow(row);
  }
  return { kind: "PENDING" };
}

export async function expireProviderSearchCache(requestFingerprint: string): Promise<void> {
  await db.update(providerSearchCache).set({ expiresAt: new Date(0), updatedAt: new Date() })
    .where(eq(providerSearchCache.requestFingerprint, requestFingerprint));
}

export async function completeProviderSearchCache(params: {
  requestFingerprint: string;
  runId: string;
  result: ProviderResult<unknown>;
  capturedAt: Date;
  policy: ProviderCachePolicy;
  liveExpiresAt?: Date;
}): Promise<void> {
  const now = new Date();
  if (params.result.outcome === "LIVE") {
    const expiresAt = new Date(Math.min(
      params.capturedAt.getTime() + params.policy.liveTtlMs,
      params.liveExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
    ));
    await db.update(providerSearchCache).set({
      state: "LIVE",
      sourceSearchRunId: params.runId,
      errorCode: null,
      capturedAt: params.capturedAt,
      expiresAt,
      leaseExpiresAt: null,
      updatedAt: now,
    }).where(eq(providerSearchCache.requestFingerprint, params.requestFingerprint));
    return;
  }
  await db.update(providerSearchCache).set({
    state: "UNAVAILABLE",
    sourceSearchRunId: null,
    errorCode: params.result.reason,
    capturedAt: params.capturedAt,
    expiresAt: new Date(params.capturedAt.getTime() + params.policy.negativeTtlMs),
    leaseExpiresAt: null,
    updatedAt: now,
  }).where(eq(providerSearchCache.requestFingerprint, params.requestFingerprint));
}

function decisionFromRow(row: typeof providerSearchCache.$inferSelect): ProviderCacheDecision {
  if (row.state === "LIVE" && row.sourceSearchRunId) {
    return { kind: "LIVE", sourceSearchRunId: row.sourceSearchRunId, capturedAt: row.capturedAt };
  }
  if (row.state === "UNAVAILABLE" && isUnavailableReason(row.errorCode)) {
    return { kind: "UNAVAILABLE", reason: row.errorCode, capturedAt: row.capturedAt };
  }
  return { kind: "PENDING" };
}

function isUnavailableReason(value: string | null): value is UnavailableReason {
  return [
    "NOT_CONFIGURED",
    "SEARCH_CONSTRAINTS_INCOMPLETE",
    "NO_RESULTS",
    "RATE_LIMITED",
    "UPSTREAM_TIMEOUT",
    "UPSTREAM_FAILURE",
    "INVALID_PROVIDER_RESPONSE",
    "PROVIDER_NOT_APPROVED",
  ].includes(value ?? "");
}
