import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../src/middleware/error-handler.js";
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
});
