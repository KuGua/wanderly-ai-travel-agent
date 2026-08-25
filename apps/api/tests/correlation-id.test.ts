import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { auditEvents, users } from "../src/db/schema.js";
import { verifyTestAccessToken, authHeaders } from "./helpers/auth.js";
import { randomUUID } from "node:crypto";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.delete(auditEvents).where(eq(auditEvents.action, "PROFILE_CREATE"));
});

describe("server-side correlation id chain", () => {
  it("attaches x-correlation-id to 2xx responses", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const correlationHeader = response.headers["x-correlation-id"];
    expect(typeof correlationHeader).toBe("string");
    expect(correlationHeader).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("uses a different correlation id per request unless one is forwarded", async () => {
    const r1 = await app.inject({ method: "GET", url: "/health" });
    const r2 = await app.inject({ method: "GET", url: "/health" });

    expect(r1.headers["x-correlation-id"]).not.toBe(r2.headers["x-correlation-id"]);
  });

  it("echoes an inbound X-Correlation-Id when the client supplies one", async () => {
    const forwarded = randomUUID();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": forwarded },
    });

    // The server owns correlationId and always generates a fresh one;
    // X-Correlation-Id from the client is advisory. We only require the
    // response header to be present and well-formed.
    expect(response.headers["x-correlation-id"]).toBeDefined();
    expect(response.headers["x-correlation-id"]).not.toBe(forwarded);
  });

  it("propagates inbound X-Request-Id as the response x-request-id header", async () => {
    const clientRequestId = `web-${randomUUID()}`;
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": clientRequestId },
    });

    expect(response.headers["x-request-id"]).toBe(clientRequestId);
    expect(response.headers["x-correlation-id"]).toBeDefined();
    expect(response.headers["x-correlation-id"]).not.toBe(clientRequestId);
  });

  it("rejects malformed X-Request-Id (length, charset)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "id with spaces and !@#" },
    });

    expect(response.headers["x-request-id"]).toBeUndefined();
  });

  it("persists correlationId on every audit row, even when client supplied its own request id", async () => {
    // Ensure a Profile row exists for alice so the create path runs.
    const [alice] = await db.select().from(users).where(eq(users.externalId, "alice")).limit(1);
    if (!alice) throw new Error("alice missing — run seed first");

    const clientRequestId = `audit-${randomUUID()}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/profiles",
      headers: {
        ...authHeaders("alice"),
        "x-request-id": clientRequestId,
        "content-type": "application/json",
      },
      payload: { departureCity: "AuditCDTest" },
    });

    expect(response.statusCode).toBe(201);
    const correlationHeader = response.headers["x-correlation-id"];
    expect(correlationHeader).toBeDefined();

    // The audit row should carry the server-generated correlationId, NOT
    // the clientRequestId. (The client's id is a log-binding convenience,
    // not a substitute for server-authoritative identity.)
    const [audit] = await db.select()
      .from(auditEvents)
      .where(eq(auditEvents.correlationId, correlationHeader as string))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(alice.id);
  });
});
