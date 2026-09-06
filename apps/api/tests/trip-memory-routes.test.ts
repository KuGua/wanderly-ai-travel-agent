import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  sharedTrips,
  tripMembers,
  tripConstraintFacts,
  users,
} from "../src/db/schema.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
let ownerId: string;
let memberId: string;
let outsiderId: string;
let tripOne: string;
let tripTwo: string;

const OWNER = "trip-mem-owner";
const MEMBER = "trip-mem-member";
const OUTSIDER = "trip-mem-outsider";

async function ensureUser(externalId: string): Promise<string> {
  const [created] = await db.insert(users)
    .values({ externalId, displayName: externalId })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  if (created) return created.id;
  const [existing] = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
  return existing!.id;
}

async function cleanup() {
  const trips = [tripOne, tripTwo].filter(Boolean);
  const ids = [ownerId, memberId, outsiderId].filter(Boolean);
  if (ids.length > 0) await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, ids));
  if (trips.length > 0) {
    // Audit rows carry a trip FK, so they go before the trips they reference.
    await db.delete(auditEvents).where(inArray(auditEvents.tripId, trips));
    await db.delete(tripConstraintFacts).where(inArray(tripConstraintFacts.tripId, trips));
    await db.delete(tripMembers).where(inArray(tripMembers.tripId, trips));
    await db.delete(sharedTrips).where(inArray(sharedTrips.id, trips));
  }
}

async function createTrip(name: string, memberIds: string[]): Promise<string> {
  const [trip] = await db.insert(sharedTrips).values({
    name,
    createdBy: memberIds[0],
    departureCities: ["Shanghai"],
    destinationCandidates: ["Tokyo", "Kyoto"],
  }).returning();
  await db.insert(tripMembers).values(memberIds.map((userId, index) => ({
    tripId: trip.id,
    userId,
    role: index === 0 ? "CREATOR" : "MEMBER",
  })));
  return trip.id;
}

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();
  ownerId = await ensureUser(OWNER);
  memberId = await ensureUser(MEMBER);
  outsiderId = await ensureUser(OUTSIDER);
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

beforeEach(async () => {
  await cleanup();
  tripOne = await createTrip("Trip One", [ownerId, memberId]);
  tripTwo = await createTrip("Trip Two", [ownerId]);
});

describe("personal overrides", () => {
  it("copies a preference-card departure into this draft trip's brief only", async () => {
    await db.update(sharedTrips).set({ status: "DRAFT" }).where(eq(sharedTrips.id, tripOne));
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripOne}/preference-card`,
      headers: authHeaders(OWNER),
      payload: { adjustments: [{ fieldKey: "departure_city", value: "San Francisco" }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ applied: ["departure_city"] });

    const [updatedTrip, untouchedTrip] = await Promise.all([
      db.select({ departureCities: sharedTrips.departureCities }).from(sharedTrips)
        .where(eq(sharedTrips.id, tripOne)).limit(1),
      db.select({ departureCities: sharedTrips.departureCities }).from(sharedTrips)
        .where(eq(sharedTrips.id, tripTwo)).limit(1),
    ]);
    expect(updatedTrip[0]?.departureCities).toEqual(["San Francisco"]);
    expect(untouchedTrip[0]?.departureCities).toEqual(["Shanghai"]);
  });

  it("saves and reads back the caller's own override", async () => {
    const save = await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/trip_pace`,
      headers: authHeaders(OWNER),
      payload: { value: "packed" },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ kind: "PERSONAL_OVERRIDE", value: "packed" });

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripOne}/memory/me`,
      headers: authHeaders(OWNER),
    });
    expect(read.json().overrides).toHaveLength(1);
  });

  it("keeps one member's override invisible to another", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/trip_pace`,
      headers: authHeaders(OWNER),
      payload: { value: "packed" },
    });

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripOne}/memory/me`,
      headers: authHeaders(MEMBER),
    });
    expect(read.json().overrides).toHaveLength(0);
  });

  it("does not carry an override across trips", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/trip_pace`,
      headers: authHeaders(OWNER),
      payload: { value: "packed" },
    });

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripTwo}/memory/me`,
      headers: authHeaders(OWNER),
    });
    expect(read.json().overrides).toHaveLength(0);
  });

  it("refuses a non-member", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripOne}/memory/me`,
      headers: authHeaders(OUTSIDER),
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a sensitive field", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/nationality`,
      headers: authHeaders(OWNER),
      payload: { value: "Singapore" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a value outside the field schema", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/trip_pace`,
      headers: authHeaders(OWNER),
      payload: { value: "sprint" },
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses a body carrying extra fields", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/trip_pace`,
      headers: authHeaders(OWNER),
      payload: { value: "packed", ownerUserId: memberId },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("group decisions", () => {
  it("is visible to every active member", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/group-decisions/accommodation_style`,
      headers: authHeaders(OWNER),
      payload: { value: "budget" },
    });

    for (const identity of [OWNER, MEMBER]) {
      const read = await app.inject({
        method: "GET",
        url: `/api/v1/trips/${tripOne}/memory`,
        headers: authHeaders(identity),
      });
      expect(read.json().groupDecisions).toHaveLength(1);
    }
  });

  it("does not expose another member's private override", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/trip_pace`,
      headers: authHeaders(OWNER),
      payload: { value: "packed" },
    });

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripOne}/memory`,
      headers: authHeaders(MEMBER),
    });
    expect(read.body).not.toContain("packed");
  });

  it("refuses a personal-only field", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/group-decisions/interests`,
      headers: authHeaders(OWNER),
      payload: { value: ["art"] },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a non-member", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/group-decisions/accommodation_style`,
      headers: authHeaders(OUTSIDER),
      payload: { value: "budget" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("deletion", () => {
  it("removes the caller's own override", async () => {
    const save = await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/trip_pace`,
      headers: authHeaders(OWNER),
      payload: { value: "packed" },
    });
    const { id } = save.json();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/trips/${tripOne}/memory/${id}`,
      headers: authHeaders(OWNER),
    });
    expect(response.statusCode).toBe(204);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripOne}/memory/me`,
      headers: authHeaders(OWNER),
    });
    expect(read.json().overrides).toHaveLength(0);
  });

  it("will not delete another member's override", async () => {
    const save = await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/trip_pace`,
      headers: authHeaders(OWNER),
      payload: { value: "packed" },
    });
    const { id } = save.json();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/trips/${tripOne}/memory/${id}`,
      headers: authHeaders(MEMBER),
    });
    expect(response.statusCode).toBe(404);
  });

  it("will not delete across trips", async () => {
    const save = await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/trip_pace`,
      headers: authHeaders(OWNER),
      payload: { value: "packed" },
    });
    const { id } = save.json();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/trips/${tripTwo}/memory/${id}`,
      headers: authHeaders(OWNER),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("telemetry redaction", () => {
  it("keeps the value out of the audit trail", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/v1/trips/${tripOne}/memory/me/overrides/trip_pace`,
      headers: authHeaders(OWNER),
      payload: { value: "packed" },
    });

    const events = await db.select().from(auditEvents)
      .where(eq(auditEvents.tripId, tripOne));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("packed");
    expect(serialized).toContain("TRIP_MEMORY_UPDATE");
  });
});
