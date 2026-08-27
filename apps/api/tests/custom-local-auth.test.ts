import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { users } from "../src/db/schema.js";

const username = `local_${Math.random().toString(36).slice(2, 10)}`;
const email = `${username}@example.test`;
const allowedOrigin = "http://localhost:3001";
const originalAuthMode = process.env.AUTH_MODE;
const originalOrigins = process.env.LOCAL_DEV_ALLOWED_ORIGINS;
let app: FastifyInstance;

beforeAll(async () => {
  process.env.AUTH_MODE = "custom-local";
  process.env.LOCAL_DEV_ALLOWED_ORIGINS = allowedOrigin;
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await db.delete(users).where(eq(users.username, username));
  await app.close();
  if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = originalAuthMode;
  if (originalOrigins === undefined) delete process.env.LOCAL_DEV_ALLOWED_ORIGINS;
  else process.env.LOCAL_DEV_ALLOWED_ORIGINS = originalOrigins;
});

describe("custom-local authentication", () => {
  it("uses the original password user for protected requests", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: allowedOrigin },
      payload: { username, email, password: "Password1A", confirmPassword: "Password1A" },
    });
    expect(register.statusCode).toBe(201);
    const registered = register.json() as { user: { id: string } };

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: allowedOrigin },
      payload: { username, password: "Password1A" },
    });
    expect(login.statusCode).toBe(200);
    const { token } = login.json() as { token: string };

    const trips = await app.inject({
      method: "GET",
      url: "/api/v1/trips",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(trips.statusCode).toBe(200);

    const matchingUsers = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.externalId, `custom:${username}`));
    expect(matchingUsers).toEqual([{ id: registered.user.id }]);
  });

  it("rejects cross-origin custom-local login attempts", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "https://attacker.example" },
      payload: { username, password: "Password1A" },
    });
    expect(response.statusCode).toBe(403);
  });
});
