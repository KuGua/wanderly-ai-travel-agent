import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { users } from "../src/db/schema.js";
import { verifyJwt } from "../src/utils/jwt.js";

const suffix = Math.random().toString(36).slice(2, 10);
const username = `reset_${suffix}`;
const email = `${username}@example.test`;
const originalPasswordResetMode = process.env.PASSWORD_RESET_MODE;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  if (originalPasswordResetMode === undefined) {
    delete process.env.PASSWORD_RESET_MODE;
  } else {
    process.env.PASSWORD_RESET_MODE = originalPasswordResetMode;
  }
  await db.delete(users).where(eq(users.email, email));
  await app.close();
});

describe("custom username login and password reset", () => {
  it("logs in by username and issues a 30-day remembered token", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username, email, password: "OldPassword1", confirmPassword: "OldPassword1" },
    });
    expect(register.statusCode).toBe(201);

    const emailLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: email, password: "OldPassword1" },
    });
    expect(emailLogin.statusCode).toBe(422);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "OldPassword1", rememberMe: true },
    });
    expect(login.statusCode).toBe(200);
    const payload = verifyJwt((login.json() as { token: string }).token);
    expect(payload).not.toBeNull();
    expect(payload!.exp - payload!.iat).toBe(30 * 24 * 60 * 60);
  });

  it("enforces cooldown, six-digit verification, and one-time password reset", async () => {
    process.env.PASSWORD_RESET_MODE = "email-code";
    const request = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email },
    });
    expect(request.statusCode).toBe(200);
    const body = request.json() as { developmentCode: string; retryAfterSeconds: number };
    expect(body.developmentCode).toMatch(/^\d{6}$/);
    expect(body.retryAfterSeconds).toBe(60);

    const resend = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email },
    });
    expect(resend.statusCode).toBe(429);

    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-reset-code",
      payload: { email, code: "12345" },
    });
    expect(malformed.statusCode).toBe(422);

    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-reset-code",
      payload: { email, code: body.developmentCode },
    });
    expect(verify.statusCode).toBe(200);
    const resetToken = (verify.json() as { resetToken: string }).resetToken;

    const mismatch = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { email, resetToken, password: "NewPassword1", confirmPassword: "Different1" },
    });
    expect(mismatch.statusCode).toBe(422);

    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { email, resetToken, password: "NewPassword1", confirmPassword: "NewPassword1" },
    });
    expect(reset.statusCode).toBe(200);

    const reused = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { email, resetToken, password: "OtherPassword1", confirmPassword: "OtherPassword1" },
    });
    expect(reused.statusCode).toBe(401);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "OldPassword1" },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "NewPassword1" },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("supports the temporary direct reset mode without a verification code", async () => {
    process.env.PASSWORD_RESET_MODE = "direct";

    const request = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email },
    });
    expect(request.statusCode).toBe(200);
    const body = request.json() as { mode: string; resetToken: string };
    expect(body.mode).toBe("direct");
    expect(body.resetToken).toHaveLength(64);

    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: {
        email,
        resetToken: body.resetToken,
        password: "DirectPassword1",
        confirmPassword: "DirectPassword1",
      },
    });
    expect(reset.statusCode).toBe(200);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "DirectPassword1" },
    });
    expect(login.statusCode).toBe(200);
  });
});
