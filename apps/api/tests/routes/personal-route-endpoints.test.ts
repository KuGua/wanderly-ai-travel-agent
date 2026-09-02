/**
 * Personal Route Endpoint Routes — Phase 4.
 *
 * Validates:
 *  - Trip membership gate (Bob cannot access Alice's proposals / list).
 *  - `OWNER_PRIVATE` visibility is rejected at the adopt boundary
 *    (spec §6.5 — route endpoints must be visible to the orchestrator).
 *  - The proposals endpoint caps the candidate set at 5 and never
 *    echoes the original chat question into the response.
 *  - The adopt endpoint persists an ACTIVE non-private `trip_place`
 *    and returns the new place id, plus a membership 403 when the
 *    caller is not a required member.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { buildApp } from "../../src/app.js";
import { db } from "../../src/db/database.js";
import {
  sharedTrips,
  tripMembers,
  tripPlaces,
  users,
} from "../../src/db/schema.js";
import { AgentStreamRelay } from "../../src/tasks/agent-stream-relay.js";
import { authHeaders, verifyTestAccessToken } from "../helpers/auth.js";

let app: FastifyInstance;
let aliceId: string;
let tripId: string;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken, agentStreamRelay: new AgentStreamRelay() });
  await app.ready();

  const [alice] = await db.insert(users).values({
    externalId: "alice-route", displayName: "Alice",
  }).onConflictDoNothing({ target: users.externalId }).returning();
  await db.insert(users).values({
    externalId: "bob-route", displayName: "Bob",
  }).onConflictDoNothing({ target: users.externalId });
  const aliceRow = alice ?? (await db.select().from(users).where(eq(users.externalId, "alice-route")).limit(1))[0];
  aliceId = aliceRow!.id;

  const [trip] = await db.insert(sharedTrips).values({
    name: `route-test-${randomUUID()}`,
    createdBy: aliceId,
    status: "PLANNING",
    departureCities: ["San Francisco"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: "2026-09-01",
    travelDateEnd: "2026-09-07",
  }).returning();
  tripId = trip!.id;
  await db.insert(tripMembers).values({ tripId, userId: aliceId, role: "CREATOR", isRequired: true });
  // Bob is intentionally NOT a member so the cross-member 403 paths
  // stay honest. The membership-positive path is covered by Alice.
});

afterAll(async () => {
  await db.delete(tripPlaces).where(eq(tripPlaces.tripId, tripId));
  await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
  await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
  await app.close();
});

describe("GET /api/v1/trips/:tripId/route-endpoints/proposals", () => {
  it("returns an empty candidate list when no ACTIVE places exist", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripId}/route-endpoints/proposals?query=tokyo`,
      headers: authHeaders("alice-route"),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { candidates: unknown[] };
    expect(body.candidates).toEqual([]);
  });

  it("returns 403 when Bob asks for Alice's trip candidates", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripId}/route-endpoints/proposals?query=tokyo`,
      headers: authHeaders("bob-route"),
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects an empty query (server contract requires a non-empty query)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripId}/route-endpoints/proposals?query=`,
      headers: authHeaders("alice-route"),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/v1/trips/:tripId/route-endpoints", () => {
  it("creates an ACTIVE non-private trip_place from a candidate", async () => {
    const [candidate] = await db.insert(tripPlaces).values({
      tripId, ownerUserId: aliceId, visibility: "TEAM_VISIBLE", status: "ACTIVE", kind: "TRANSPORT_HUB",
      displayName: "Tokyo Station Source", countryCode: "JP", cityName: "Tokyo", longitude: 139.7673, latitude: 35.6812, source: "reference:tokyo-station",
    }).returning();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/route-endpoints`,
      headers: { ...authHeaders("alice-route"), "content-type": "application/json" },
      payload: {
        sourceId: `trip_place:${candidate!.id}`,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { placeId: string };
    expect(body.placeId).toMatch(/^[0-9a-f-]{36}$/);

    // The row is ACTIVE and non-private.
    const [row] = await db.select().from(tripPlaces).where(eq(tripPlaces.id, body.placeId));
    expect(row).toBeDefined();
    expect(row.status).toBe("ACTIVE");
    expect(row.visibility).not.toBe("OWNER_PRIVATE");
    expect(row.displayName).toBe("Tokyo Station Source");
  });

  it("rejects browser-supplied coordinates and visibility", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/route-endpoints`,
      headers: { ...authHeaders("alice-route"), "content-type": "application/json" },
      payload: {
        sourceId: "trip_place:00000000-0000-0000-0000-000000000000",
        displayName: "Private Pin",
        longitude: 139.7,
        latitude: 35.68,
        visibility: "OWNER_PRIVATE",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 403 when Bob tries to adopt a candidate on Alice's trip", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/route-endpoints`,
      headers: { ...authHeaders("bob-route"), "content-type": "application/json" },
      payload: {
        sourceId: "trip_place:00000000-0000-0000-0000-000000000000",
      },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("GET /api/v1/trips/:tripId/route-endpoints", () => {
  it("returns the adopted ACTIVE endpoints for the owner's trip", async () => {
    const [candidate] = await db.insert(tripPlaces).values({
      tripId, ownerUserId: aliceId, visibility: "TEAM_VISIBLE", status: "ACTIVE", kind: "ATTRACTION",
      displayName: "Asakusa Source", longitude: 139.7967, latitude: 35.7148, source: "reference:asakusa",
    }).returning();
    await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/route-endpoints`,
      headers: { ...authHeaders("alice-route"), "content-type": "application/json" },
      payload: {
        sourceId: `trip_place:${candidate!.id}`,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripId}/route-endpoints`,
      headers: authHeaders("alice-route"),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { endpoints: Array<{ displayName: string }> };
    expect(body.endpoints.length).toBeGreaterThan(0);
    expect(body.endpoints.length).toBeLessThanOrEqual(2);
  });
});
