import { describe, expect, it, vi } from "vitest";

import { fixtureProfile } from "@/lib/fixtures/profiles";
import { fixtureTrips } from "@/lib/fixtures/trips";
import { ApiClient } from "./client";
import { FixtureTravelApi } from "./fixture-travel-api";
import { HttpTravelApi } from "./http-travel-api";
import { profileResponseSchema } from "./contracts";

describe("HttpTravelApi", () => {
  it("adds the current Cognito access token to protected requests", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixtureProfile));
    const api = new HttpTravelApi("http://localhost:3000", fetchMock, () => "test-access-token");

    await api.getMyProfile();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/v1/profiles/me");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-access-token");
    expect(new Headers(init?.headers).has("X-Demo-User")).toBe(false);
  });

  it("keeps fixture and HTTP responses in the same domain shape", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(fixtureProfile))
      .mockResolvedValueOnce(jsonResponse(fixtureTrips));
    const httpApi = new HttpTravelApi("http://localhost:3000", fetchMock);
    const fixtureApi = new FixtureTravelApi();

    await expect(httpApi.getMyProfile()).resolves.toEqual(await fixtureApi.getMyProfile());
    await expect(httpApi.getTrips()).resolves.toEqual(await fixtureApi.getTrips());
  });
});

describe("ApiClient correlation chain", () => {
  it("attaches a fresh X-Request-Id and matching X-Correlation-Id on the first request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixtureProfile));
    const client = new ApiClient("http://localhost:3000", fetchMock, () => null);

    await client.request("/profiles/me", profileResponseSchema);

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    const requestId = headers.get("X-Request-Id");
    const correlationId = headers.get("X-Correlation-Id");
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // On a fresh client the correlation id mirrors the request id.
    expect(correlationId).toBe(requestId);
  });

  it("forwards the server-issued x-correlation-id to the next request", async () => {
    const serverCorrelation = "11111111-2222-3333-4444-555555555555";
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponseWithCorrelation(fixtureProfile, serverCorrelation))
      .mockResolvedValueOnce(jsonResponse(fixtureProfile));
    const client = new ApiClient("http://localhost:3000", fetchMock, () => null);

    await client.request("/profiles/me", profileResponseSchema);
    await client.request("/profiles/me", profileResponseSchema);

    const [, secondInit] = fetchMock.mock.calls[1];
    const headers = new Headers(secondInit?.headers);
    expect(headers.get("X-Correlation-Id")).toBe(serverCorrelation);
    // X-Request-Id stays fresh per call — only X-Correlation-Id is chained.
    expect(headers.get("X-Request-Id")).not.toBe(serverCorrelation);
  });

  it("does not overwrite caller-supplied X-Request-Id", async () => {
    const callerId = "caller-supplied-001";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixtureProfile));
    const client = new ApiClient("http://localhost:3000", fetchMock, () => null);

    await client.request("/profiles/me", profileResponseSchema, {
      headers: { "X-Request-Id": callerId },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("X-Request-Id")).toBe(callerId);
  });

  it("does not overwrite caller-supplied X-Correlation-Id", async () => {
    const callerCorrelation = "caller-correlation-9";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixtureProfile));
    const client = new ApiClient("http://localhost:3000", fetchMock, () => null);

    await client.request("/profiles/me", profileResponseSchema, {
      headers: { "X-Correlation-Id": callerCorrelation },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("X-Correlation-Id")).toBe(callerCorrelation);
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonResponseWithCorrelation(body: unknown, correlationId: string) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": correlationId,
    },
  });
}
