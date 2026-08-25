import { describe, expect, it } from "vitest";

import {
  assertAuthModeEnvironment,
  assertLocalDevServerHost,
  isLoopbackAddress,
  resolveAuthMode,
} from "../src/middleware/auth-mode.js";
import { createAuthMiddleware } from "../src/middleware/auth.js";

describe("authentication mode safety", () => {
  it("defaults to Cognito", () => {
    expect(resolveAuthMode(undefined)).toBe("cognito");
  });

  it("forbids local-dev in production", () => {
    expect(() => assertAuthModeEnvironment("local-dev", "production")).toThrow(/forbidden/);
    expect(() => createAuthMiddleware(undefined, { mode: "local-dev", nodeEnv: "production" })).toThrow(/forbidden/);
  });

  it("requires a loopback server binding and loopback request source", async () => {
    expect(() => assertLocalDevServerHost("local-dev", "0.0.0.0")).toThrow(/loopback/);
    expect(() => assertLocalDevServerHost("local-dev", "192.168.1.10")).toThrow(/loopback/);
    expect(() => assertLocalDevServerHost("local-dev", "127.0.0.1")).not.toThrow();
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);

    const middleware = createAuthMiddleware(undefined, { mode: "local-dev", nodeEnv: "development" });
    await expect(middleware({ headers: {}, ip: "192.0.2.10" } as never)).rejects.toMatchObject({
      statusCode: 403,
      message: "Local development authentication requires a loopback client",
    });
  });
});
