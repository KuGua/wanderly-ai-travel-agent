import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { users, userProfiles } from "../src/db/schema.js";

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

  /**
   * A 401 the browser cannot read is a 401 nobody can act on. CORS is
   * registered ahead of the authentication hook precisely so a rejection still
   * carries the header; with the two the other way round, the web app received
   * an opaque `net::ERR_FAILED` and could not tell "sign in again" apart from
   * "the API is down" — the globe composer just went quiet and stayed disabled.
   */
  it("keeps CORS headers on an unauthenticated rejection so the browser can read the status", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/explorations/start",
      headers: { origin: allowedOrigin, "content-type": "application/json" },
      // Deliberately no bearer token.
      payload: { requestId: randomUUID() },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
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

  /**
   * A registered account with no profile row could never record a nationality,
   * and without one hotel quotes cannot be authorized and the trip cannot be
   * planned. The row is created with the account so that path does not exist.
   */
  it("creates the traveller's profile row alongside the account", async () => {
    const probe = `local_${Math.random().toString(36).slice(2, 10)}`;
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: allowedOrigin },
      payload: {
        username: probe, email: `${probe}@example.test`,
        password: "Password1A", confirmPassword: "Password1A",
      },
    });
    expect(register.statusCode).toBe(201);
    const { token, user } = register.json() as { token: string; user: { id: string } };

    const profile = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(profile.statusCode).toBe(200);
    // Present but empty — somewhere to put preferences, not a claim any were stated.
    const body = profile.json() as { profile: { nationality: string | null } | null };
    expect(body.profile).not.toBeNull();
    expect(body.profile?.nationality).toBeNull();

    await db.delete(userProfiles).where(eq(userProfiles.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id));
  });
});
