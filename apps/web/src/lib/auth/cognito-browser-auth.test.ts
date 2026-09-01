import { beforeEach, describe, expect, it, vi } from "vitest";

const amplifyMocks = vi.hoisted(() => ({
  configure: vi.fn(),
  fetchAuthSession: vi.fn(),
  getCurrentUser: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  setKeyValueStorage: vi.fn(),
}));

vi.mock("aws-amplify", () => ({ Amplify: { configure: amplifyMocks.configure } }));
vi.mock("aws-amplify/auth", () => ({
  fetchAuthSession: amplifyMocks.fetchAuthSession,
  getCurrentUser: amplifyMocks.getCurrentUser,
  signIn: amplifyMocks.signIn,
  signOut: amplifyMocks.signOut,
}));
vi.mock("aws-amplify/auth/cognito", () => ({
  cognitoUserPoolsTokenProvider: { setKeyValueStorage: amplifyMocks.setKeyValueStorage },
}));
vi.mock("aws-amplify/utils", () => ({
  defaultStorage: { kind: "persistent" },
  sessionStorage: { kind: "session" },
}));

import { createCognitoBrowserAuth } from "./cognito-browser-auth";

describe("Cognito browser auth adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_AUTH_MODE;
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
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
    const service = await createCognitoBrowserAuth();

    expect(await service.signIn("traveler", "not-a-real-password", true)).toEqual({ username: "traveler@example.test" });
    expect(await service.getAccessToken()).toBe("current-access-token");
    await service.signOut();

    expect(amplifyMocks.configure).toHaveBeenCalledWith(expect.objectContaining({
      Auth: { Cognito: expect.objectContaining({ userPoolClientId: "public-client-id" }) },
    }));
    expect(amplifyMocks.signIn).toHaveBeenCalledWith({ username: "traveler", password: "not-a-real-password" });
    expect(amplifyMocks.setKeyValueStorage).toHaveBeenCalledWith({ kind: "persistent" });
    expect(amplifyMocks.fetchAuthSession).toHaveBeenCalledTimes(1);
    expect(amplifyMocks.signOut).toHaveBeenCalledTimes(1);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("is explicitly unconfigured when public Cognito identifiers are absent", async () => {
    delete process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
    delete process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;

    const service = await createCognitoBrowserAuth();

    expect(service.configured).toBe(false);
    expect(await service.getAccessToken()).toBeNull();
  });

  it("uses a token-free, explicitly local browser state in local-dev mode", async () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "local-dev";
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:3000";

    const service = await createCognitoBrowserAuth();

    expect(service.localDevelopment).toBe(true);
    expect(service.configured).toBe(false);
    expect(await service.getAccessToken()).toBeNull();
    expect(amplifyMocks.configure).not.toHaveBeenCalled();
  });

  it("selects the database-backed adapter in custom-local mode", async () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "custom-local";
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:3000";

    const service = await createCognitoBrowserAuth();

    expect(service.configured).toBe(true);
    expect(service.localDevelopment).toBe(false);
    expect(amplifyMocks.configure).not.toHaveBeenCalled();
  });

  it("permits a private IPv4 API URL for custom-local LAN testing", async () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "custom-local";
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://10.91.182.185:3000";

    const service = await createCognitoBrowserAuth();

    expect(service.configured).toBe(true);
    expect(service.localDevelopmentConfigurationInvalid).toBeUndefined();
  });

  it("does not activate local-dev when its API base URL is not loopback", async () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "local-dev";
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://192.168.1.10:3000";

    const service = await createCognitoBrowserAuth();

    expect(service.localDevelopment).toBe(false);
    expect(service.localDevelopmentConfigurationInvalid).toBe(true);
    expect(await service.getAccessToken()).toBeNull();
  });
});
