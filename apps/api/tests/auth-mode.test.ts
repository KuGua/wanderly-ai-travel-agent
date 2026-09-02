import { describe, expect, it } from "vitest";

import {
  assertAuthModeEnvironment,
  assertCustomLocalJwtSecret,
  assertLocalDevServerHost,
  isLoopbackAddress,
  isPrivateIpv4Address,
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
    expect(() => assertAuthModeEnvironment("custom-local", "development")).not.toThrow();
    expect(() => assertAuthModeEnvironment("custom-local", "production")).toThrow(/development or test/);
    expect(() => assertCustomLocalJwtSecret("custom-local", "x".repeat(32))).not.toThrow();
    expect(() => assertCustomLocalJwtSecret("custom-local", undefined)).toThrow(/JWT_SECRET/);
  });

  it("rejects malformed custom-local bearer tokens", async () => {
    const middleware = createAuthMiddleware(undefined, { mode: "custom-local", nodeEnv: "development" });
    await expect(middleware({ headers: { authorization: "Bearer malformed" }, ip: "127.0.0.1" } as never)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("requires a loopback server binding and loopback request source", async () => {
    expect(() => assertLocalDevServerHost("local-dev", "0.0.0.0")).toThrow(/loopback/);
    expect(() => assertLocalDevServerHost("local-dev", "0.0.0.0", true)).not.toThrow();
    expect(() => assertLocalDevServerHost("local-dev", "192.168.1.10", true)).toThrow(/loopback/);
    expect(() => assertLocalDevServerHost("local-dev", "192.168.1.10")).toThrow(/loopback/);
    expect(() => assertLocalDevServerHost("custom-local", "10.91.182.185")).not.toThrow();
    expect(() => assertLocalDevServerHost("local-dev", "10.91.182.185")).toThrow(/loopback/);
    expect(() => assertLocalDevServerHost("custom-local", "198.51.100.10")).toThrow(/loopback/);
    // Binding only the LAN address left `localhost` with nothing listening, so
    // every localhost URL failed at the network layer ("Failed to fetch") while
    // the LAN URL worked. custom-local may serve both at once; local-dev, which
    // authenticates without a password, may not.
    expect(() => assertLocalDevServerHost("custom-local", "0.0.0.0")).not.toThrow();
    expect(() => assertLocalDevServerHost("local-dev", "0.0.0.0")).toThrow(/loopback/);
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
    expect(() => resolveLocalDevAllowedOrigins("http://192.168.1.10:3001", "local-dev")).toThrow(/loopback HTTP/);
    expect(() => resolveLocalDevAllowedOrigins("http://localhost:3001/path")).toThrow(/exact loopback HTTP/);
    expect(() => resolveLocalDevAllowedOrigins("")).toThrow(/LOCAL_DEV_ALLOWED_ORIGINS/);
    expect(isAllowedLocalDevOrigin("http://localhost:3001", ["http://localhost:3001"])).toBe(true);
    expect(isAllowedLocalDevOrigin("https://attacker.example", ["http://localhost:3001"])).toBe(false);
  });

  it("allows exact private IPv4 origins only for custom-local LAN testing", () => {
    expect(isPrivateIpv4Address("10.91.182.185")).toBe(true);
    expect(isPrivateIpv4Address("172.20.1.4")).toBe(true);
    expect(isPrivateIpv4Address("192.168.1.4")).toBe(true);
    expect(isPrivateIpv4Address("172.32.1.4")).toBe(false);
    expect(isPrivateIpv4Address("198.51.100.10")).toBe(false);
    expect(resolveLocalDevAllowedOrigins("http://10.91.182.185:3001", "custom-local"))
      .toEqual(["http://10.91.182.185:3001"]);
    expect(() => resolveLocalDevAllowedOrigins("http://10.91.182.185:3001", "local-dev")).toThrow(/loopback HTTP/);
    expect(() => resolveLocalDevAllowedOrigins("http://198.51.100.10:3001", "custom-local")).toThrow(/loopback HTTP/);
  });
});
