import { describe, expect, it, vi } from "vitest";

import { fixtureProfile } from "@/lib/fixtures/profiles";
import { fixtureTrips } from "@/lib/fixtures/trips";
import { FixtureTravelApi } from "./fixture-travel-api";
import { HttpTravelApi } from "./http-travel-api";

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

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
