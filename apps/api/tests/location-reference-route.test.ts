import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../src/middleware/error-handler.js";
import { buildApp } from "../src/app.js";
import { locationReferenceRoutes } from "../src/routes/location-reference.js";

const app = Fastify();

beforeAll(async () => {
  app.setErrorHandler(errorHandler);
  await app.register(locationReferenceRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("location reference route", () => {
  it("returns a non-authoritative offline reference for a supported coordinate", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/v1/explore/location-reference",
      payload: { latitude: 38.7223, longitude: -9.1393 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { admin1: string | null };
    expect(body).toMatchObject({
      outcome: "REFERENCE", country: "Portugal", countryCode: "PT", nearestCity: "Lisbon", isTravelFact: false,
    });
    expect(body.admin1).toBeTruthy();
  });

  it("rejects invalid coordinates before resolving them", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/v1/explore/location-reference",
      payload: { latitude: 91, longitude: 0 },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns a controlled 429 after 30 anonymous requests in one minute", async () => {
    const rateLimitedApp = Fastify();
    rateLimitedApp.setErrorHandler(errorHandler);
    await rateLimitedApp.register(locationReferenceRoutes, { prefix: "/api/v1" });
    await rateLimitedApp.ready();
    try {
      for (let request = 0; request < 30; request += 1) {
        const response = await rateLimitedApp.inject({
          method: "POST", url: "/api/v1/explore/location-reference",
          payload: { latitude: 38.7223, longitude: -9.1393 },
        });
        expect(response.statusCode).toBe(200);
      }

      const limited = await rateLimitedApp.inject({
        method: "POST", url: "/api/v1/explore/location-reference",
        payload: { latitude: 38.7223, longitude: -9.1393 },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: "Too Many Requests" });
    } finally {
      await rateLimitedApp.close();
    }
  });
});

describe("anonymous location reference boundary", () => {
  it("allows only the location reference endpoint without a bearer token", async () => {
    const protectedApp = await buildApp();
    await protectedApp.ready();
    try {
      const location = await protectedApp.inject({
        method: "POST", url: "/api/v1/explore/location-reference",
        payload: { latitude: 38.7223, longitude: -9.1393 },
      });
      const profile = await protectedApp.inject({ method: "GET", url: "/api/v1/profiles/me" });

      expect(location.statusCode).toBe(200);
      expect(profile.statusCode).toBe(401);
    } finally {
      await protectedApp.close();
    }
  });
});
