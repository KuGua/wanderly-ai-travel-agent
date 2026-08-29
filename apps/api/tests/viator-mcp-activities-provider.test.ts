import { beforeEach, describe, expect, it, vi } from "vitest";

import { metrics } from "../src/observability/metrics.js";
import {
  readViatorMcpConfiguration,
  ViatorMcpActivitiesProvider,
} from "../src/providers/viator-mcp-activities-provider.js";

const fixedNow = new Date("2026-08-29T10:00:00.000Z");

beforeEach(() => metrics.reset());

describe("ViatorMcpActivitiesProvider", () => {
  it("normalizes official MCP structuredContent and discards link and currency-less prices", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { arguments: Record<string, unknown> };
      };
      expect(body.params.arguments).toMatchObject({
        searchTerm: "food experiences in Paris",
        startDate: "2026-09-15",
        endDate: "2026-09-17",
        limit: 2,
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
      }],
    });
    expect(JSON.stringify(result)).not.toContain("clickOffToLander");
    expect(JSON.stringify(result)).not.toContain("fromPrice");
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
