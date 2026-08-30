import { beforeEach, describe, expect, it, vi } from "vitest";

import { metrics } from "../src/observability/metrics.js";
import {
  readViatorMcpConfiguration,
  ViatorMcpActivitiesProvider,
} from "../src/providers/viator-mcp-activities-provider.js";

const fixedNow = new Date("2026-08-29T10:00:00.000Z");

beforeEach(() => metrics.reset());

describe("ViatorMcpActivitiesProvider", () => {
  it("asks the provider to price in the trip's currency and keeps the amount", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { arguments: Record<string, unknown> };
      };
      // The currency is what makes the returned amount meaningful; omitting it
      // is what previously forced the price to be thrown away.
      expect(body.params.arguments).toMatchObject({
        searchTerm: "food experiences in Paris",
        startDate: "2026-09-15",
        endDate: "2026-09-17",
        limit: 2,
        currency: "USD",
      });
      return jsonResponse(validEnvelope([experience()]));
    }) as typeof fetch;
    const provider = providerWith(fetchImpl);

    const result = await provider.searchActivities({
      destination: "Paris",
      dateStart: "2026-09-15",
      dateEnd: "2026-09-17",
      theme: "FOOD",
      locale: "en",
      currency: "USD",
      limit: 2,
    });

    expect(result).toEqual({
      outcome: "LIVE",
      source: "Viator Experiences MCP",
      capturedAt: fixedNow.toISOString(),
      data: [{
        providerOfferId: "394285P13",
        title: "Paris City Center Walking Tour",
        thumbnailUrl: "https://example.com/lead.jpg",
        rating: 4.9,
        reviewCount: 1956,
        freeCancellation: true,
        durationMinutes: { fixed: 135, from: null, to: null },
        category: "Walking Tours",
        fromPrice: 3.53,
        currency: "USD",
        providerLocality: "Paris",
      }],
    });
    // The booking link is still discarded; only the locality is read out of it.
    expect(JSON.stringify(result)).not.toContain("clickOffToLander");
    expect(JSON.stringify(result)).not.toContain("viator.com/tours");
  });

  it("drops a product the provider filed under another destination", async () => {
    // A search for Tokyo really does return Rio de Janeiro and Anaheim: the
    // provider matches on text, and naming the country in the query does not
    // change that. The product URL is the only geographic signal in the
    // response, so it is read before being discarded.
    const fetchImpl = vi.fn(async () => jsonResponse(validEnvelope([
      experience(),
      {
        ...experience(),
        code: "999999P1",
        title: "Christ the Redeemer Ticket",
        clickOffToLander: "https://www.viator.com/tours/Rio-de-Janeiro/example/d479-999999P1",
      },
    ]))) as typeof fetch;

    const result = await providerWith(fetchImpl).searchActivities({
      destination: "Paris", dateStart: "2026-09-15", dateEnd: "2026-09-17",
      locale: "en", currency: "USD", limit: 5,
    });

    if (result.outcome !== "LIVE") throw new Error("expected LIVE");
    expect(result.data.map((item) => item.title)).toEqual(["Paris City Center Walking Tour"]);
  });

  it("keeps a product whose URL carries no locality", async () => {
    // The check removes results that are demonstrably elsewhere; it does not
    // demand proof of belonging, which would silently empty the list whenever
    // the provider changes its URL shape.
    const fetchImpl = vi.fn(async () => jsonResponse(validEnvelope([
      { ...experience(), clickOffToLander: "https://www.viator.com/other/shape" },
    ]))) as typeof fetch;

    const result = await providerWith(fetchImpl).searchActivities({
      destination: "Paris", dateStart: "2026-09-15", dateEnd: "2026-09-17",
      locale: "en", currency: "USD", limit: 5,
    });

    if (result.outcome !== "LIVE") throw new Error("expected LIVE");
    expect(result.data).toHaveLength(1);
    expect(result.data[0].providerLocality).toBeNull();
  });

  it("maps rate limiting and malformed provider data to bounded UNAVAILABLE results", async () => {
    const rateLimitedFetch = vi.fn(async () => new Response("", { status: 429 })) as typeof fetch;
    const rateLimited = new ViatorMcpActivitiesProvider({
      endpoint: "https://example.test/mcp",
      timeoutMs: 100,
      maxRetries: 2,
      fetchImpl: rateLimitedFetch,
      now: () => fixedNow,
    });
    await expect(rateLimited.searchActivities(searchParams())).resolves.toEqual({
      outcome: "UNAVAILABLE",
      reason: "RATE_LIMITED",
    });
    expect(rateLimitedFetch).toHaveBeenCalledTimes(1);

    const malformed = providerWith(vi.fn(async () => jsonResponse(validEnvelope([{
      ...experience(),
      fromPrice: undefined,
    }]))) as typeof fetch);
    await expect(malformed.searchActivities(searchParams())).resolves.toEqual({
      outcome: "UNAVAILABLE",
      reason: "INVALID_PROVIDER_RESPONSE",
    });
  });

  it("uses a neutral discovery query when no theme is supplied", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { arguments: Record<string, unknown> };
      };
      expect(body.params.arguments.searchTerm).toBe("things to do in Paris");
      return jsonResponse(validEnvelope([experience()]));
    }) as typeof fetch;

    await expect(providerWith(fetchImpl).searchActivities(searchParams())).resolves.toMatchObject({
      outcome: "LIVE",
    });
  });

  it("honors a bounded provider reset window before retrying a 429", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(jsonResponse(validEnvelope([experience()]))) as typeof fetch;
    const retrying = new ViatorMcpActivitiesProvider({
      endpoint: "https://example.test/mcp",
      timeoutMs: 100,
      maxRetries: 1,
      fetchImpl,
      now: () => fixedNow,
    });
    await expect(retrying.searchActivities(searchParams())).resolves.toMatchObject({ outcome: "LIVE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps its own request deadline to UPSTREAM_TIMEOUT", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const provider = new ViatorMcpActivitiesProvider({
      endpoint: "https://example.test/mcp",
      timeoutMs: 5,
      maxRetries: 0,
      fetchImpl,
      now: () => fixedNow,
    });
    await expect(provider.searchActivities(searchParams())).resolves.toEqual({
      outcome: "UNAVAILABLE",
      reason: "UPSTREAM_TIMEOUT",
    });
  });
});

describe("readViatorMcpConfiguration", () => {
  it("is opt-in and requires bounded safe configuration", () => {
    expect(readViatorMcpConfiguration({})).toBeNull();
    expect(readViatorMcpConfiguration({ VIATOR_MCP_ENABLED: "true" })).toMatchObject({
      endpoint: "https://exp-app-mcp.prod.ep.viator.com/mcp",
      timeoutMs: 8_000,
      maxRetries: 1,
    });
    expect(() => readViatorMcpConfiguration({
      VIATOR_MCP_ENABLED: "true",
      VIATOR_MCP_URL: "http://example.test/mcp",
    })).toThrow("VIATOR_MCP_URL must use HTTPS");
  });
});

function providerWith(fetchImpl: typeof fetch): ViatorMcpActivitiesProvider {
  return new ViatorMcpActivitiesProvider({
    endpoint: "https://example.test/mcp",
    timeoutMs: 100,
    maxRetries: 0,
    fetchImpl,
    now: () => fixedNow,
  });
}

function searchParams() {
  return {
    destination: "Paris",
    dateStart: "2026-09-15",
    dateEnd: "2026-09-17",
    locale: "en" as const,
    limit: 2,
  };
}

function experience() {
  return {
    title: "Paris City Center Walking Tour",
    code: "394285P13",
    thumbnail: "https://example.com/lead.jpg",
    rating: 4.9,
    reviewCount: 1956,
    freeCancellation: true,
    fromPrice: 3.53,
    clickOffToLander: "https://www.viator.com/tours/Paris/example/d479-394285P13",
    duration: { fixedDurationInMinutes: 135 },
    keyAttributes: { features: [], mainCategory: "Walking Tours" },
  };
}

function validEnvelope(experiences: unknown[]) {
  return {
    jsonrpc: "2.0",
    id: "request-id",
    result: {
      content: [{ type: "text", text: "provider text is not trusted" }],
      isError: false,
      structuredContent: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        experiences,
      },
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
