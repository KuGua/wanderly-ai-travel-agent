import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "./client";

describe("ApiClient authentication", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes the default browser fetch with the global receiver", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse("ok"));
    });
    const client = new ApiClient("https://api.example.test");

    await client.request("/health", z.literal("ok"));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("omits Authorization when there is no Cognito session", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse("ok"));
    const client = new ApiClient("https://api.example.test", fetchMock, async () => null);

    await client.request("/health", z.literal("ok"));

    expect(headersFor(fetchMock, 0).has("Authorization")).toBe(false);
  });

  it("reads the current access token for every request and stops authenticating after logout", async () => {
    let currentAccessToken: string | null = "access-token-one";
    const getAccessToken = vi.fn(async () => currentAccessToken);
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse("ok"));
    const client = new ApiClient("https://api.example.test", fetchMock, getAccessToken);

    await client.request("/first", z.literal("ok"));
    currentAccessToken = "access-token-two";
    await client.request("/second", z.literal("ok"));
    currentAccessToken = null;
    await client.request("/after-logout", z.literal("ok"));

    expect(getAccessToken).toHaveBeenCalledTimes(3);
    expect(headersFor(fetchMock, 0).get("Authorization")).toBe("Bearer access-token-one");
    expect(headersFor(fetchMock, 1).get("Authorization")).toBe("Bearer access-token-two");
    expect(headersFor(fetchMock, 2).has("Authorization")).toBe(false);
  });
});

function headersFor(fetchMock: ReturnType<typeof vi.fn>, call: number) {
  return new Headers(fetchMock.mock.calls[call][1]?.headers);
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
