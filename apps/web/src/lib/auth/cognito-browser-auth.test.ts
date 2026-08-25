import { beforeEach, describe, expect, it, vi } from "vitest";

const amplifyMocks = vi.hoisted(() => ({
  configure: vi.fn(),
  fetchAuthSession: vi.fn(),
  getCurrentUser: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("aws-amplify", () => ({ Amplify: { configure: amplifyMocks.configure } }));
vi.mock("aws-amplify/auth", () => ({
  fetchAuthSession: amplifyMocks.fetchAuthSession,
  getCurrentUser: amplifyMocks.getCurrentUser,
  signIn: amplifyMocks.signIn,
  signOut: amplifyMocks.signOut,
}));

import { createCognitoBrowserAuth } from "./cognito-browser-auth";

describe("Cognito browser auth adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_AUTH_MODE;
    process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID = "us-east-1_example";
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = "public-client-id";
    amplifyMocks.getCurrentUser.mockResolvedValue({ username: "traveler@example.test" });
    amplifyMocks.signIn.mockResolvedValue({ isSignedIn: true });
    amplifyMocks.fetchAuthSession.mockResolvedValue({
      tokens: { accessToken: { toString: () => "current-access-token" } },
    });
  });

  it("uses Amplify-managed session state without application-owned token persistence", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const service = createCognitoBrowserAuth();

    expect(await service.signIn("traveler@example.test", "not-a-real-password")).toEqual({ username: "traveler@example.test" });
    expect(await service.getAccessToken()).toBe("current-access-token");
    await service.signOut();

    expect(amplifyMocks.configure).toHaveBeenCalledWith(expect.objectContaining({
      Auth: { Cognito: expect.objectContaining({ userPoolClientId: "public-client-id" }) },
    }));
    expect(amplifyMocks.signIn).toHaveBeenCalledWith({ username: "traveler@example.test", password: "not-a-real-password" });
    expect(amplifyMocks.fetchAuthSession).toHaveBeenCalledTimes(1);
    expect(amplifyMocks.signOut).toHaveBeenCalledTimes(1);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("is explicitly unconfigured when public Cognito identifiers are absent", async () => {
    delete process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
    delete process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;

    const service = createCognitoBrowserAuth();

    expect(service.configured).toBe(false);
    expect(await service.getAccessToken()).toBeNull();
  });

  it("uses a token-free, explicitly local browser state in local-dev mode", async () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "local-dev";

    const service = createCognitoBrowserAuth();

    expect(service.localDevelopment).toBe(true);
    expect(service.configured).toBe(false);
    expect(await service.getAccessToken()).toBeNull();
    expect(amplifyMocks.configure).not.toHaveBeenCalled();
  });
});
