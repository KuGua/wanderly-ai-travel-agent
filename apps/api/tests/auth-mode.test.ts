import { describe, expect, it } from "vitest";

import {
  assertAuthModeEnvironment,
  assertLocalDevServerHost,
  isLoopbackAddress,
  isAllowedLocalDevOrigin,
  resolveLocalDevAllowedOrigins,
  resolveAuthMode,
} from "../src/middleware/auth-mode.js";
import { createAuthMiddleware } from "../src/middleware/auth.js";

describe("authentication mode safety", () => {
  it("defaults to Cognito", () => {
    expect(resolveAuthMode(undefined)).toBe("cognito");
  });

  it("allows local-dev only in development or test", () => {
    expect(() => assertAuthModeEnvironment("local-dev", "development")).not.toThrow();
    expect(() => assertAuthModeEnvironment("local-dev", "test")).not.toThrow();
    expect(() => assertAuthModeEnvironment("local-dev", "production")).toThrow(/development or test/);
    expect(() => assertAuthModeEnvironment("local-dev", "staging")).toThrow(/development or test/);
    expect(() => createAuthMiddleware(undefined, { mode: "local-dev", nodeEnv: "production" })).toThrow(/development or test/);
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

  it("accepts only exact loopback HTTP origins for local-dev", () => {
    expect(resolveLocalDevAllowedOrigins("http://localhost:3001,http://127.0.0.1:3001"))
      .toEqual(["http://localhost:3001", "http://127.0.0.1:3001"]);
    expect(() => resolveLocalDevAllowedOrigins("https://localhost:3001")).toThrow(/loopback HTTP/);
    expect(() => resolveLocalDevAllowedOrigins("http://192.168.1.10:3001")).toThrow(/loopback HTTP/);
    expect(() => resolveLocalDevAllowedOrigins("http://localhost:3001/path")).toThrow(/exact loopback HTTP/);
    expect(() => resolveLocalDevAllowedOrigins("")).toThrow(/LOCAL_DEV_ALLOWED_ORIGINS/);
    expect(isAllowedLocalDevOrigin("http://localhost:3001", ["http://localhost:3001"])).toBe(true);
    expect(isAllowedLocalDevOrigin("https://attacker.example", ["http://localhost:3001"])).toBe(false);
  });
});
