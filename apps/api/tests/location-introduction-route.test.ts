import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/db/database.js";
import { buildApp } from "../src/app.js";
import { locationIntroductionCache } from "../src/db/schema.js";
import { LOCATION_INTRODUCTION_RATE_LIMIT } from "../src/routes/location-introduction-rate-limit.js";
import {
  __setModelGatewayForTests,
} from "../src/providers/gateway-factory.js";
import type { ModelGateway } from "../src/providers/model-gateway.js";

const FAKE_CONTENT_EN = "Tokyo is a city of contrasts — glass towers over neon-lit backstreets, vending machines beside tiny shrines, and a rhythm that shifts from morning calm to midnight rush. Wander between neighborhoods rather than chase a checklist, and let the city reveal itself over coffee, ramen, and long subway rides that feel like time travel.";

const CATALOG_SOURCE_ID = "tokyo";

const app = await buildApp();
await app.ready();

const gateway: ModelGateway = {
  generateStructuredPlan: async () => ({}),
  explainPlanDiff: async () => ({ added: [], removed: [], changed: [] }),
  generateConversationReply: async () => ({ content: "", responseMode: "MODEL" }),
  generateLocationIntroduction: async () => ({
    content: FAKE_CONTENT_EN,
    modelName: "fake-model",
    promptVersion: "location-intro-v1",
  }),
};

beforeAll(() => {
  __setModelGatewayForTests(gateway);
});

afterEach(async () => {
  await db.execute(sql`DELETE FROM location_introduction_cache`);
});

afterAll(async () => {
  __setModelGatewayForTests(null);
  await app.close();
});

describe("POST /api/v1/explore/location-introductions", () => {
  it("returns 200 READY for a known sourceId and is anonymous (no Authorization header)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/explore/location-introductions",
      payload: { sourceId: CATALOG_SOURCE_ID, locale: "en" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; cacheStatus: string; content: string };
    expect(body.status).toBe("READY");
    expect(body.cacheStatus).toBe("MISS");
    expect(body.content).toBe(FAKE_CONTENT_EN);
    // Anonymous path: no auth-related header should be required.
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("returns 200 READY with cacheStatus HIT on the second call", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/explore/location-introductions",
      payload: { sourceId: CATALOG_SOURCE_ID, locale: "en" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/explore/location-introductions",
      payload: { sourceId: CATALOG_SOURCE_ID, locale: "en" },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json() as { cacheStatus: string };
    expect(body.cacheStatus).toBe("HIT");
  });

  it("returns 400 LOCATION_INTRODUCTION_UNSUPPORTED_PLACE for an unknown sourceId", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/explore/location-introductions",
      payload: { sourceId: "atlantis", locale: "en" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { message: string };
    expect(body.message).toContain("not in the active introduction catalog");
  });

  it("rejects extra fields via the strict schema (400)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/explore/location-introductions",
      payload: { sourceId: CATALOG_SOURCE_ID, locale: "en", secret: true },
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 503 LOCATION_INTRODUCTION_UNAVAILABLE when the model throws", async () => {
    __setModelGatewayForTests({
      ...gateway,
      generateLocationIntroduction: async () => { throw new Error("upstream 5xx"); },
    });
    await db.execute(sql`DELETE FROM location_introduction_cache`);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/explore/location-introductions",
      payload: { sourceId: CATALOG_SOURCE_ID, locale: "en" },
    });
    expect(response.statusCode).toBe(503);
    const rows = await db.select().from(locationIntroductionCache);
    expect(rows).toHaveLength(0);
    __setModelGatewayForTests(gateway);
  });

  it("rate limit behavior is exercised by the dedicated unit test", () => {
    // The route shares a process-local limiter with other route tests;
    // pinning the 429 path here would be order-dependent. The
    // deterministic contract — 10 successes then 11th rejected —
    // lives in `tests/location-introduction-rate-limit.test.ts`.
    expect(LOCATION_INTRODUCTION_RATE_LIMIT).toBe(10);
  });
});