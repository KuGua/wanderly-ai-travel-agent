/**
 * 7-step generation flow for the shared location-introduction cache.
 *
 * Mirrors docs/location-introduction-cache-implementation.md §5. The
 * service NEVER holds a database transaction across the LLM call.
 *
 *   1. catalog resolve
 *   2. READY hit lookup (short tx)
 *   3. lease claim (short tx)
 *   4. model call (outside tx; lease owner only)
 *   5. READY commit (short tx; lease owner only)
 *   6. non-owner short-circuit → 202
 *   7. failure release → lease owner only
 */
import { SpanKind } from "@opentelemetry/api";
import { getTracer, safeSetAttribute } from "../observability/tracing.js";
import { metrics } from "../observability/metrics.js";
import type { ModelGateway } from "../providers/model-gateway.js";
import type { LocationIntroductionCatalogEntry } from "./location-introduction-catalog.js";
import {
  buildLocationIntroductionCacheKey,
  claimLocationIntroductionLease,
  commitLocationIntroductionReady,
  findCurrentLocationIntroductionCache,
  findReadyLocationIntroductionCache,
  releaseLocationIntroductionLease,
  renewLocationIntroductionLease,
} from "./location-introduction-cache-repository.js";

export type LocationIntroductionServiceOutcome =
  | { status: "READY"; content: string; cacheStatus: "HIT" | "MISS"; expiresAt: string }
  | { status: "GENERATING"; retryAfterMs: number };

export interface LocationIntroductionServiceConfig {
  ttlSeconds: number;
  leaseSeconds: number;
  generationTimeoutMs: number;
}

function resolveConfig(): LocationIntroductionServiceConfig {
  const ttl = Number(process.env.LOCATION_INTRODUCTION_TTL_SECONDS ?? 604800);
  const lease = Number(process.env.LOCATION_INTRODUCTION_GENERATION_LEASE_SECONDS ?? 20);
  const generationTimeoutMs = Number(process.env.LOCATION_INTRODUCTION_GENERATION_TIMEOUT_MS ?? 60_000);
  return {
    ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 604800,
    leaseSeconds: Number.isFinite(lease) && lease > 0 ? lease : 20,
    generationTimeoutMs: Number.isFinite(generationTimeoutMs) && generationTimeoutMs >= 1_000 ? generationTimeoutMs : 60_000,
  };
}

export interface LocationIntroductionServiceDeps {
  gateway: ModelGateway;
  now?: () => Date;
}

const RETRY_AFTER_MS = 500;

export async function getOrStartLocationIntroduction(input: {
  catalogEntry: LocationIntroductionCatalogEntry;
  locale: "en" | "zh";
  contentVersion: string;
  deps: LocationIntroductionServiceDeps;
}): Promise<LocationIntroductionServiceOutcome> {
  const now = input.deps.now ?? (() => new Date());
  const config = resolveConfig();
  const cacheKey = buildLocationIntroductionCacheKey({
    contentVersion: input.contentVersion,
    canonicalPlaceId: input.catalogEntry.canonicalPlaceId,
    locale: input.locale,
  });

  const tracer = getTracer();
  const lookupSpan = tracer.startSpan("cache.lookup", {
    kind: SpanKind.INTERNAL,
    attributes: { "content.version": input.contentVersion },
  });

  // Step 2 — READY hit lookup.
  const readyHit = await findReadyLocationIntroductionCache(cacheKey, now());
  if (readyHit) {
    metrics.inc("location_introduction_requests_total", { outcome: "hit" });
    safeSetAttribute(lookupSpan, "cache.outcome", "hit");
    lookupSpan.end();
    return {
      status: "READY",
      content: readyHit.content,
      cacheStatus: "HIT",
      expiresAt: readyHit.expiresAt.toISOString(),
    };
  }
  safeSetAttribute(lookupSpan, "cache.outcome", "miss");
  lookupSpan.end();

  // Step 3 — lease claim.
  const claimSpan = tracer.startSpan("cache.lease", {
    kind: SpanKind.INTERNAL,
    attributes: { "content.version": input.contentVersion },
  });
  const claim = await claimLocationIntroductionLease({
    cacheKey,
    catalogEntry: input.catalogEntry,
    locale: input.locale,
    contentVersion: input.contentVersion,
    leaseSeconds: config.leaseSeconds,
    now: now(),
  });

  if (claim.outcome === "lease-lost") {
    // Step 6 — non-owner short-circuit.
    safeSetAttribute(claimSpan, "cache.outcome", "lost");
    claimSpan.end();
    metrics.inc("location_introduction_requests_total", { outcome: "generating" });
    return { status: "GENERATING", retryAfterMs: RETRY_AFTER_MS };
  }

  safeSetAttribute(claimSpan, "cache.outcome", "acquired");
  claimSpan.end();

  // Step 4 — model call (outside any DB transaction). It is deliberately
  // decoupled from request.signal: closing a map drawer stops observation,
  // not a valid shared-cache generation.
  let leaseLost = false;
  let renewal: Promise<void> | null = null;
  const renewalTimer = setInterval(() => {
    renewal = renewLocationIntroductionLease({
      cacheKey,
      leaseToken: claim.leaseToken,
      leaseSeconds: config.leaseSeconds,
      now: now(),
    }).then((renewed) => { if (!renewed) leaseLost = true; }).catch(() => { leaseLost = true; });
  }, Math.max(1_000, Math.floor((config.leaseSeconds * 1000) / 2)));
  const generationController = new AbortController();
  const generationTimeout = setTimeout(() => generationController.abort(), config.generationTimeoutMs);
  let generated;
  try {
    const llmSpan = tracer.startSpan("llm.location_introduction", {
      kind: SpanKind.CLIENT,
      attributes: { "content.version": input.contentVersion },
    });
    safeSetAttribute(llmSpan, "llm.method", "location.introduction");
    safeSetAttribute(llmSpan, "llm.skill.name", "location.introduction");
    const start = Date.now();
    try {
      generated = await input.deps.gateway.generateLocationIntroduction({
        locale: input.locale,
        place: {
          ...input.catalogEntry,
          contentVersion: input.contentVersion,
        },
        signal: generationController.signal,
      });
      const ms = Date.now() - start;
      metrics.observe("location_introduction_generation_duration_ms", ms, { outcome: "success" });
      safeSetAttribute(llmSpan, "llm.outcome", "success");
      llmSpan.end();
    } catch (err) {
      const ms = Date.now() - start;
      metrics.observe("location_introduction_generation_duration_ms", ms, { outcome: "failure" });
      safeSetAttribute(llmSpan, "llm.outcome", "failure");
      llmSpan.end();
      throw err;
    }
  } catch {
    // Step 7 — failure release.
    await releaseLocationIntroductionLease({
      cacheKey,
      leaseToken: claim.leaseToken,
      now: now(),
    });
    metrics.inc("location_introduction_requests_total", { outcome: "unavailable" });
    throw new LocationIntroductionUnavailableError();
  } finally {
    clearInterval(renewalTimer);
    clearTimeout(generationTimeout);
    await renewal;
  }

  if (leaseLost) {
    metrics.inc("location_introduction_requests_total", { outcome: "unavailable" });
    throw new LocationIntroductionUnavailableError();
  }

  // Step 5 — READY commit.
  const commit = await commitLocationIntroductionReady({
    cacheKey,
    leaseToken: claim.leaseToken,
    content: generated.content,
    modelName: generated.modelName,
    promptVersion: generated.promptVersion,
    ttlSeconds: config.ttlSeconds,
    now: now(),
  });

  if (commit.outcome === "lease-lost") {
    metrics.inc("location_introduction_requests_total", { outcome: "unavailable" });
    throw new LocationIntroductionUnavailableError();
  }

  // Final sanity read so the response carries the authoritative expiresAt.
  const finalRead = await findCurrentLocationIntroductionCache(cacheKey);
  if (!finalRead || finalRead.status !== "READY" || !finalRead.expiresAt || !finalRead.content) {
    metrics.inc("location_introduction_requests_total", { outcome: "unavailable" });
    throw new LocationIntroductionUnavailableError();
  }

  metrics.inc("location_introduction_requests_total", { outcome: "miss" });
  return {
    status: "READY",
    content: finalRead.content,
    cacheStatus: "MISS",
    expiresAt: finalRead.expiresAt.toISOString(),
  };
}

export class LocationIntroductionUnavailableError extends Error {
  override readonly name = "LocationIntroductionUnavailableError";
  constructor() {
    super("Location introduction is temporarily unavailable");
  }
}
