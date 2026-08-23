import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

function authHeaders(userId: string) {
  return { "x-demo-user": userId };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("Auth & Access Control", () => {
  it("rejects requests without X-Demo-User header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/profiles/me" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects invalid demo user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/me",
      headers: { "x-demo-user": "invalid" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts valid demo user", async () => {
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

describe("Fixture Provider Markers", () => {
  it("all fixture data is marked as Demo data", async () => {
    const { FLIGHT_FIXTURES, STAY_FIXTURES, GROUND_FIXTURES } = await import("../src/providers/fixtures.js");

    for (const flight of FLIGHT_FIXTURES) {
      expect(flight.source).toBe("Demo data");
      expect(flight.isDemo).toBe(true);
    }

    for (const stay of STAY_FIXTURES) {
      expect(stay.source).toBe("Demo data");
      expect(stay.isDemo).toBe(true);
    }

    for (const ground of GROUND_FIXTURES) {
      expect(ground.source).toBe("Demo data");
      expect(ground.isDemo).toBe(true);
    }
  });
});

describe("Booking Sandbox", () => {
  it("sandbox does not collect real payments", async () => {
    const { SANDBOX_CALLBACK_FIXTURES } = await import("../src/providers/fixtures.js");
    expect(SANDBOX_CALLBACK_FIXTURES.success.serviceResults.flight.reference).toContain("DEMO");
  });
});
