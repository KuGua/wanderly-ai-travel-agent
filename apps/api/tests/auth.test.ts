import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createAuthMiddleware } from "../src/middleware/auth.js";
import { ApiError } from "../src/middleware/error-handler.js";

const originalUserPoolId = process.env.COGNITO_USER_POOL_ID;
const originalClientId = process.env.COGNITO_CLIENT_ID;

afterEach(() => {
  restoreEnvironment("COGNITO_USER_POOL_ID", originalUserPoolId);
  restoreEnvironment("COGNITO_CLIENT_ID", originalClientId);
});

describe("Cognito authentication boundary", () => {
  it("rejects requests without a bearer token", async () => {
    const middleware = createAuthMiddleware();

    await expect(middleware(requestWithHeaders({}))).rejects.toMatchObject({
      statusCode: 401,
      message: "A valid bearer access token is required",
    });
  });

  it("does not accept a client-supplied demo user ID", async () => {
    const middleware = createAuthMiddleware();

    await expect(middleware(requestWithHeaders({ "x-demo-user": "alice" }))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("normalizes verifier failures without exposing token details", async () => {
    const middleware = createAuthMiddleware(async () => {
      throw new Error("provider detail containing a token");
    });

    const error = await middleware(requestWithHeaders({ authorization: "Bearer secret-token" }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 401, message: "A valid bearer access token is required" });
    expect(String(error)).not.toContain("secret-token");
    expect(String(error)).not.toContain("provider detail");
  });

  it("fails closed when Cognito configuration is missing", async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;
    const middleware = createAuthMiddleware();

    await expect(middleware(requestWithHeaders({ authorization: "Bearer opaque-token" }))).rejects.toMatchObject({
      statusCode: 503,
      message: "Authentication service is not configured",
    });
  });
});

function requestWithHeaders(headers: Record<string, string>) {
  return { headers } as FastifyRequest;
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
