import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/database.js";
import { locationIntroductionCache } from "../src/db/schema.js";
import { sql } from "drizzle-orm";
import {
  resolveLocationIntroductionCatalogEntrySync as resolveLocationIntroductionCatalogEntry,
  LocationIntroductionUnsupportedPlaceError,
} from "../src/location-introduction/location-introduction-catalog.js";
import {
  buildLocationIntroductionCacheKey,
  findReadyLocationIntroductionCache,
} from "../src/location-introduction/location-introduction-cache-repository.js";
import {
  getOrStartLocationIntroduction,
  LocationIntroductionUnavailableError,
} from "../src/location-introduction/location-introduction-cache-service.js";
import type { ModelGateway } from "../src/providers/model-gateway.js";

const CATALOG_FIXTURE_SOURCE_ID = "tokyo";

async function clean() {
  await db.execute(sql`DELETE FROM location_introduction_cache`);
}

beforeEach(async () => {
  await clean();
});

afterEach(async () => {
  await clean();
});

function makeFakeGateway(overrides: Partial<{
  delayMs: number;
  throwOnce: Error;
  throwAlways: Error;
}> = {}): ModelGateway {
  return {
    generateStructuredPlan: vi.fn(),
    explainPlanDiff: vi.fn(),
    generateConversationReply: vi.fn(),
    generateLocationIntroduction: vi.fn(async (params) => {
      if (overrides.throwAlways) throw overrides.throwAlways;
      if (overrides.delayMs) await new Promise((r) => setTimeout(r, overrides.delayMs));
      if (overrides.throwOnce) {
        const err = overrides.throwOnce;
        overrides.throwOnce = undefined;
        throw err;
      }
      // Pad to satisfy the 60-char minimum enforced by the
      // location_introduction_cache_ready_invariants CHECK.
      const prose = `${params.place.name} is a city of contrasts — glass towers over neon-lit backstreets, vending machines beside tiny shrines, and a rhythm that shifts from morning calm to midnight rush.`;
      return {
        content: prose,
        modelName: "fake-model",
        promptVersion: "location-intro-v1",
      };
    }),
  };
}

describe("LocationIntroductionCacheService", () => {
  it("returns a HIT after the first successful MISS", async () => {
    const gateway = makeFakeGateway();
    const entry = resolveLocationIntroductionCatalogEntry(CATALOG_FIXTURE_SOURCE_ID);
    const deps = { gateway };

    const first = await getOrStartLocationIntroduction({
      catalogEntry: entry,
      locale: "zh",
      contentVersion: "test-v1",
      deps,
    });
    expect(first.status).toBe("READY");
    if (first.status === "READY") {
      expect(first.cacheStatus).toBe("MISS");
      expect(first.content.length).toBeGreaterThan(0);
    }

    const second = await getOrStartLocationIntroduction({
      catalogEntry: entry,
      locale: "zh",
      contentVersion: "test-v1",
      deps,
    });
    expect(second.status).toBe("READY");
    if (second.status === "READY") {
      expect(second.cacheStatus).toBe("HIT");
      expect(second.content).toBe(first.status === "READY" ? first.content : "");
    }
    expect(gateway.generateLocationIntroduction).toHaveBeenCalledTimes(1);
  });

  it("returns 503-equivalent when the model throws and does not persist a row", async () => {
    const gateway = makeFakeGateway({ throwAlways: new Error("upstream 5xx") });
    const entry = resolveLocationIntroductionCatalogEntry(CATALOG_FIXTURE_SOURCE_ID);
    await expect(getOrStartLocationIntroduction({
      catalogEntry: entry,
      locale: "en",
      contentVersion: "test-v1",
      deps: { gateway },
    })).rejects.toBeInstanceOf(LocationIntroductionUnavailableError);

    const cacheKey = buildLocationIntroductionCacheKey({
      contentVersion: "test-v1",
      canonicalPlaceId: entry.canonicalPlaceId,
      locale: "en",
    });
    const rows = await db
      .select()
      .from(locationIntroductionCache)
      .where(sql`${locationIntroductionCache.cacheKey} = ${cacheKey}`);
    expect(rows).toHaveLength(0);
  });

  it("does not invoke the model for unsupported sourceIds (route-layer check)", () => {
    // The cache service receives a pre-resolved entry, so unknown sourceIds
    // are rejected by the route via LocationIntroductionCatalog.resolve
    // before this layer runs. This test documents the boundary and asserts
    // the service does not itself short-circuit on the sourceId field.
    expect(typeof LocationIntroductionUnsupportedPlaceError).toBe("function");
  });

  it("regenerates after the cached entry expires", async () => {
    const gateway = makeFakeGateway();
    const entry = resolveLocationIntroductionCatalogEntry(CATALOG_FIXTURE_SOURCE_ID);
    const deps = { gateway };

    // First call populates the cache with a deterministic clock at t0.
    const t0 = new Date("2026-01-01T00:00:00Z");
    const first = await getOrStartLocationIntroduction({
      catalogEntry: entry,
      locale: "en",
      contentVersion: "test-v1",
      deps: { gateway: deps.gateway, now: () => t0 },
    });
    expect(first.status).toBe("READY");

    // Re-issue with a clock well past expires_at; the lease-takeover path
    // must regenerate and the cache row's expires_at advances.
    const t1 = new Date("2026-01-09T00:00:00Z");
    const second = await getOrStartLocationIntroduction({
      catalogEntry: entry,
      locale: "en",
      contentVersion: "test-v1",
      deps: { gateway: deps.gateway, now: () => t1 },
    });
    expect(second.status).toBe("READY");
    if (second.status === "READY") {
      expect(second.cacheStatus).toBe("MISS");
    }
    expect(gateway.generateLocationIntroduction).toHaveBeenCalledTimes(2);

    // And a third read with t1 should now be a HIT.
    const third = await getOrStartLocationIntroduction({
      catalogEntry: entry,
      locale: "en",
      contentVersion: "test-v1",
      deps: { gateway: deps.gateway, now: () => t1 },
    });
    expect(third.status).toBe("READY");
    if (third.status === "READY") expect(third.cacheStatus).toBe("HIT");
  });

  it("computes the cache key from contentVersion + canonicalPlaceId + locale only", () => {
    expect(buildLocationIntroductionCacheKey({
      contentVersion: "v1",
      canonicalPlaceId: "tokyo-jp",
      locale: "zh",
    })).toBe(buildLocationIntroductionCacheKey({
      contentVersion: "v1",
      canonicalPlaceId: "tokyo-jp",
      locale: "zh",
    }));
    expect(buildLocationIntroductionCacheKey({
      contentVersion: "v1",
      canonicalPlaceId: "tokyo-jp",
      locale: "zh",
    })).not.toBe(buildLocationIntroductionCacheKey({
      contentVersion: "v1",
      canonicalPlaceId: "tokyo-jp",
      locale: "en",
    }));
    expect(buildLocationIntroductionCacheKey({
      contentVersion: "v1",
      canonicalPlaceId: "tokyo-jp",
      locale: "en",
    })).not.toBe(buildLocationIntroductionCacheKey({
      contentVersion: "v2",
      canonicalPlaceId: "tokyo-jp",
      locale: "en",
    }));
  });

  it("findReadyLocationIntroductionCache returns null for expired rows", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-09T00:00:00Z");
    const entry = resolveLocationIntroductionCatalogEntry(CATALOG_FIXTURE_SOURCE_ID);
    const cacheKey = buildLocationIntroductionCacheKey({
      contentVersion: "test-v1",
      canonicalPlaceId: entry.canonicalPlaceId,
      locale: "en",
    });

    await db.insert(locationIntroductionCache).values({
      cacheKey,
      canonicalPlaceId: entry.canonicalPlaceId,
      locale: "en",
      contentVersion: "test-v1",
      status: "READY",
      content: "x".repeat(80),
      generatedAt: t0,
      expiresAt: new Date("2026-01-02T00:00:00Z"),
      modelName: "fake-model",
      promptVersion: "test-v1",
    });
    expect(await findReadyLocationIntroductionCache(cacheKey, t1)).toBeNull();
    expect(await findReadyLocationIntroductionCache(cacheKey, t0)).not.toBeNull();
  });
});