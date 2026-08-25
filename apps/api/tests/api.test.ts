import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { __buildSandboxSignature } from "../src/middleware/sandbox-signature.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
const SANDBOX_SECRET = "test-only-sandbox-secret";

beforeAll(async () => {
  process.env.SANDBOX_HMAC_SECRET = SANDBOX_SECRET;
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("Auth & Access Control", () => {
  it("rejects requests without a bearer access token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/profiles/me" });
    expect(res.statusCode).toBe(401);
  });

  it("does not accept a client-supplied user ID as authentication", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/me",
      headers: { "x-demo-user": "alice" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid bearer access token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/me",
      headers: { authorization: "Bearer invalid" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a verified bearer access token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/me",
      headers: authHeaders("alice"),
    });
    expect(res.statusCode).toBe(200);
  });

  it("health check works without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});

describe("Profile CRUD", () => {
  it("creates and retrieves profile", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/profiles",
      headers: authHeaders("alice"),
      payload: {
        interests: ["art", "museums"],
        accommodationStyle: "city_center",
        noRedEye: true,
        departureCity: "San Francisco",
      },
    });
    expect(createRes.statusCode).toBe(201);

    const getRes = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/me",
      headers: authHeaders("alice"),
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.profile).toBeDefined();
    expect(body.profile.interests).toEqual(["art", "museums"]);
  });

  it("redacts passport number from profile response", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/profiles",
      headers: authHeaders("bob"),
      payload: { interests: ["food"] },
    });

    const getRes = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/me",
      headers: authHeaders("bob"),
    });
    const body = getRes.json();
    expect(body.profile.passportNumber).toBeUndefined();
  });
});

describe("Booking Sandbox", () => {
  it("authenticates the callback without a bearer token using the exact raw JSON bytes", async () => {
    const timestamp = Date.now();
    const rawBody = `{
      "orchestrationRequestId":"${randomUUID()}",
      "eventId":"${randomUUID()}",
      "serviceResults":{}
    }`;
    const signature = __buildSandboxSignature(SANDBOX_SECRET, timestamp, rawBody);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bookings/callback",
      headers: {
        "content-type": "application/json",
        "x-sandbox-signature": signature,
        "x-sandbox-timestamp": String(timestamp),
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("Callback could not be processed");
    expect(res.json().message).not.toBe("Callback authentication failed");
  });

  it.each([
    { headers: {}, expected: 401 },
    { headers: { "x-sandbox-signature": "invalid", "x-sandbox-timestamp": String(Date.now()) }, expected: 401 },
    { headers: { "x-sandbox-signature": "a".repeat(64), "x-sandbox-timestamp": "not-a-time" }, expected: 401 },
  ])("returns one generic 401 for missing, invalid, or malformed callback authentication", async ({ headers, expected }) => {
    const secretMaterial = "must-never-appear";
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bookings/callback",
      headers: { "content-type": "application/json", ...headers },
      payload: JSON.stringify({ secretMaterial }),
    });

    expect(res.statusCode).toBe(expected);
    expect(res.json().message).toBe("Callback authentication failed");
    expect(res.body).not.toContain(secretMaterial);
    expect(res.body).not.toContain("bad_signature");
    expect(res.body).not.toContain("malformed_timestamp");
  });

  it("rejects a body changed after signing", async () => {
    const timestamp = Date.now();
    const original = JSON.stringify({ eventId: randomUUID(), serviceResults: {} });
    const signature = __buildSandboxSignature(SANDBOX_SECRET, timestamp, original);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bookings/callback",
      headers: {
        "content-type": "application/json",
        "x-sandbox-signature": signature,
        "x-sandbox-timestamp": String(timestamp),
      },
      payload: JSON.stringify({ eventId: randomUUID(), serviceResults: {} }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("Callback authentication failed");
  });

  it("fails closed when SANDBOX_HMAC_SECRET is unset", async () => {
    const configuredSecret = process.env.SANDBOX_HMAC_SECRET;
    delete process.env.SANDBOX_HMAC_SECRET;
    try {
      const timestamp = Date.now();
      const rawBody = JSON.stringify({ eventId: randomUUID(), serviceResults: {} });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/bookings/callback",
        headers: {
          "content-type": "application/json",
          "x-sandbox-signature": __buildSandboxSignature(SANDBOX_SECRET, timestamp, rawBody),
          "x-sandbox-timestamp": String(timestamp),
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe("Callback authentication failed");
    } finally {
      if (configuredSecret === undefined) delete process.env.SANDBOX_HMAC_SECRET;
      else process.env.SANDBOX_HMAC_SECRET = configuredSecret;
    }
  });
});
