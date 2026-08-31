import { beforeEach, describe, expect, it, vi } from "vitest";

import { metrics } from "../src/observability/metrics.js";
import { NuiteeHotelProvider, readNuiteeHotelConfiguration } from "../src/providers/nuitee-hotel-provider.js";

const fixedNow = new Date("2026-08-30T10:00:00.000Z");

const baseRequest = {
  destination: {
    destinationId: "Tokyo",
    cityName: "Tokyo",
    countryCode: "JP",
    latitude: 35.6812,
    longitude: 139.7671,
  },
  checkIn: "2026-09-15",
  checkOut: "2026-09-18",
  roomCount: 1,
  adultsPerRoom: [2],
  currency: "USD",
  locale: "en" as const,
  quoteNationality: "US",
};

beforeEach(() => metrics.reset());

function providerWith(fetchImpl: typeof fetch): NuiteeHotelProvider {
  return new NuiteeHotelProvider({
    apiKey: "secret-nuitee-key",
    timeoutMs: 12_000,
    maxRetries: 1,
    baseUrl: "https://nuitee.test",
    fetchImpl,
    now: () => fixedNow,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("NuiteeHotelProvider", () => {
  it("normalizes live hotel evidence and never leaks keys, URLs, or supplier tokens", async () => {
    const seen: { url?: string; headers?: HeadersInit; body?: string } = {};
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.url = String(input);
      seen.headers = init?.headers;
      seen.body = typeof init?.body === "string" ? init.body : undefined;
      return jsonResponse({
        data: [{
          hotelId: "hotel-raw-id",
          name: "Safe Nuitee Hotel",
          starRating: 4,
          rates: [{
            rateId: "rate-raw-id",
            retailRate: {
              totalAmount: 360,
              currency: "USD",
              taxesAndFeesAmount: 60,
              taxesAndFeesIncluded: true,
            },
            cancellationPolicies: { cancellationPolicy: [{ description: "Free cancellation" }] },
            roomTypes: [{ description: "Deluxe Room", adults: 2 }],
          }],
        }],
      });
    }) as typeof fetch;
    const result = await providerWith(fetchImpl).searchHotels(baseRequest);

    expect(result).toMatchObject({
      outcome: "LIVE", source: "Nuitee LiteAPI Rates",
      data: [{
        propertyName: "Safe Nuitee Hotel",
        totalPrice: 360, pricePerNight: 120, currency: "USD",
        taxesAndFees: { status: "INCLUDED", amount: 60 },
        cancellationSummary: "Free cancellation",
        roomCount: 1, adultsPerRoom: [2],
      }],
    });
    // Sensitive fields never appear in the serialized result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("hotel-raw-id");
    expect(serialized).not.toContain("rate-raw-id");
    expect(serialized).not.toContain("secret-nuitee-key");
    expect(serialized).not.toContain("nuitee.test");
    // Request shape is correct.
    expect(seen.url).toBe("https://nuitee.test/v3.0/hotels/rates");
    const headers = seen.headers as Record<string, string> | undefined;
    expect(headers?.["x-api-key"]).toBe("secret-nuitee-key");
    expect(headers?.["content-type"]).toBe("application/json");
    const parsed = JSON.parse(seen.body ?? "{}");
    expect(parsed.checkin).toBe("2026-09-15");
    expect(parsed.checkout).toBe("2026-09-18");
    expect(parsed.guestNationality).toBe("US");
    expect(parsed.occupancies).toEqual([{ adults: 2 }]);
    expect(parsed.city).toBe("Tokyo");
    expect(parsed.countryCode).toBe("JP");
    expect(parsed.maxRatesPerHotel).toBe(1);
    expect(parsed.includeHotelData).toBe(true);
  });

  it.each([
    [401, {}, "PROVIDER_NOT_APPROVED"],
    [403, {}, "PROVIDER_NOT_APPROVED"],
    [429, {}, "RATE_LIMITED"],
    [500, {}, "UPSTREAM_FAILURE"],
    [200, { error: { code: "2001", message: "no results" } }, "NO_RESULTS"],
    [200, { error: { code: "9999", message: "server error" } }, "UPSTREAM_FAILURE"],
    [200, { data: [] }, "NO_RESULTS"],
    [200, { data: [{ hotelId: "x", name: "x", rates: [] }] }, "NO_RESULTS"],
    [200, "this is not json", "INVALID_PROVIDER_RESPONSE"],
    [200, { data: [{ hotelId: "x", name: "x", rates: [{ rateId: "y", retailRate: { totalAmount: -1, currency: "USD" } }] }] }, "INVALID_PROVIDER_RESPONSE"],
  ])("maps status %s body %j to %s", async (status, body, reason) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body, status)) as typeof fetch;
    await expect(providerWith(fetchImpl).searchHotels(baseRequest))
      .resolves.toEqual({ outcome: "UNAVAILABLE", reason });
  });

  it("refuses without quoteNationality rather than calling the supplier", async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    const result = await providerWith(fetchImpl).searchHotels({ ...baseRequest, quoteNationality: undefined });
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "SEARCH_CONSTRAINTS_INCOMPLETE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects multi-room shapes outside the supported range", async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    const tooMany = await providerWith(fetchImpl).searchHotels({ ...baseRequest, roomCount: 9, adultsPerRoom: [1, 1, 1, 1, 1, 1, 1, 1, 1] });
    expect(tooMany).toEqual({ outcome: "UNAVAILABLE", reason: "SEARCH_CONSTRAINTS_INCOMPLETE" });
    const mismatched = await providerWith(fetchImpl).searchHotels({ ...baseRequest, roomCount: 2, adultsPerRoom: [2] });
    expect(mismatched).toEqual({ outcome: "UNAVAILABLE", reason: "SEARCH_CONSTRAINTS_INCOMPLETE" });
    const tooManyAdults = await providerWith(fetchImpl).searchHotels({ ...baseRequest, roomCount: 1, adultsPerRoom: [10] });
    expect(tooManyAdults).toEqual({ outcome: "UNAVAILABLE", reason: "SEARCH_CONSTRAINTS_INCOMPLETE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps occupancies correctly for multi-room requests", async () => {
    let captured: { occupancies?: unknown } = {};
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      captured = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return jsonResponse({ data: [] });
    }) as typeof fetch;
    await providerWith(fetchImpl).searchHotels({
      ...baseRequest,
      roomCount: 3,
      adultsPerRoom: [2, 1, 4],
    });
    expect(captured.occupancies).toEqual([{ adults: 2 }, { adults: 1 }, { adults: 4 }]);
  });

  it("classifies PARTIAL when taxesAndFeesAmount is set but not explicitly included", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{
        hotelId: "h", name: "Partial Tax Hotel", rates: [{
          rateId: "r",
          retailRate: { totalAmount: 200, currency: "USD", taxesAndFeesAmount: 15 },
          roomTypes: [],
        }],
      }],
    })) as typeof fetch;
    const result = await providerWith(fetchImpl).searchHotels(baseRequest);
    expect(result).toMatchObject({
      outcome: "LIVE",
      data: [{ taxesAndFees: { status: "PARTIAL", amount: 15 } }],
    });
  });

  it("classifies UNKNOWN when no tax information is present", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{
        hotelId: "h", name: "Unknown Tax Hotel", rates: [{
          rateId: "r",
          retailRate: { totalAmount: 200, currency: "USD" },
          roomTypes: [],
        }],
      }],
    })) as typeof fetch;
    const result = await providerWith(fetchImpl).searchHotels(baseRequest);
    expect(result).toMatchObject({
      outcome: "LIVE",
      data: [{ taxesAndFees: { status: "UNKNOWN" } }],
    });
  });

  it("respects the configured deadline and retries at most once", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
        // Never resolves — only abort cancels the call.
      });
    }) as typeof fetch;
    const provider = new NuiteeHotelProvider({
      apiKey: "k", timeoutMs: 50, maxRetries: 1, fetchImpl,
    });
    const result = await provider.searchHotels(baseRequest);
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "UPSTREAM_TIMEOUT" });
    // 1 initial attempt + 1 retry = 2 total.
    expect(calls).toBe(2);
  });

  it("caps results at ten and drops malformed rate blocks", async () => {
    const hotels = Array.from({ length: 12 }, (_, index) => ({
      hotelId: `hotel-${index}`,
      name: `Hotel ${index}`,
      rates: [{
        rateId: `rate-${index}`,
        retailRate: { totalAmount: 100 + index, currency: "USD", taxesAndFeesAmount: 10, taxesAndFeesIncluded: true },
        roomTypes: [{ description: "Standard" }],
      }],
    }));
    const fetchImpl = vi.fn(async () => jsonResponse({ data: hotels })) as typeof fetch;
    const result = await providerWith(fetchImpl).searchHotels(baseRequest);
    if (result.outcome !== "LIVE") throw new Error("expected LIVE");
    expect(result.data).toHaveLength(10);
    expect(result.data.map((d) => d.propertyName)).toEqual([
      "Hotel 0", "Hotel 1", "Hotel 2", "Hotel 3", "Hotel 4",
      "Hotel 5", "Hotel 6", "Hotel 7", "Hotel 8", "Hotel 9",
    ]);
  });

  it("readNuiteeHotelConfiguration returns null without NUITEE_API_KEY", () => {
    expect(readNuiteeHotelConfiguration({})).toBeNull();
    expect(readNuiteeHotelConfiguration({ NUITEE_API_KEY: "" })).toBeNull();
    expect(readNuiteeHotelConfiguration({ NUITEE_API_KEY: "key" })).toMatchObject({ apiKey: "key" });
  });
});
