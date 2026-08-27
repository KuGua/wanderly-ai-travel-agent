import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCustomBrowserAuth } from "./custom-browser-auth";

describe("custom browser auth", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("persists remembered login and keeps unchecked login session-only", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      token: "remembered-token",
      user: { id: "user-1", username: "traveler", email: "traveler@example.test" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = createCustomBrowserAuth();

    await service.signIn("traveler", "Password1", true);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      username: "traveler",
      rememberMe: true,
    });
    expect(localStorage.getItem("wanderly_auth_token")).toBe("remembered-token");
    expect(sessionStorage.getItem("wanderly_auth_token")).toBeNull();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      token: "session-token",
      user: { id: "user-1", username: "traveler", email: "traveler@example.test" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await service.signIn("traveler", "Password1", false);

    expect(localStorage.getItem("wanderly_auth_token")).toBeNull();
    expect(sessionStorage.getItem("wanderly_auth_token")).toBe("session-token");
  });
});
