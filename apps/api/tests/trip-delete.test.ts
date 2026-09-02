import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  chatMessages,
  chatThreads,
  constraintSnapshots,
  destinationCandidates,
  idempotencyRecords,
  itineraryPlans,
  providerOffers,
  providerSearchRuns,
  sharedTrips,
  sourceEvidence,
  tripMembers,
  users,
  visaReadinessChecks,
} from "../src/db/schema.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();
  for (const subject of ["alice", "bob"] as const) {
    await db.insert(users)
      .values({ externalId: subject, displayName: subject })
      .onConflictDoNothing({ target: users.externalId });
  }
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // Leaf-first, matching trip-activate.test.ts: the test database is shared
  // across files in one run, so a sibling's rows can block an FK cascade.
  await db.delete(providerOffers);
  await db.delete(sourceEvidence);
  await db.delete(visaReadinessChecks);
  await db.delete(auditEvents);
  await db.delete(itineraryPlans);
  await db.delete(providerSearchRuns);
  await db.delete(agentTaskRuns);
  await db.delete(destinationCandidates);
  await db.delete(constraintSnapshots);
  await db.delete(idempotencyRecords);
  await db.delete(chatMessages);
  await db.delete(chatThreads);
  await db.delete(tripMembers);
  await db.delete(sharedTrips);
});

async function createTripFor(externalId: "alice" | "bob"): Promise<string> {
  const start = await app.inject({
    method: "POST",
    url: "/api/v1/explorations/start",
    headers: authHeaders(externalId),
    payload: { requestId: randomUUID() },
  });
  expect(start.statusCode).toBe(201);
  return start.json().trip.id;
}

function deleteTrip(tripId: string, externalId: "alice" | "bob") {
  return app.inject({
    method: "DELETE",
    url: `/api/v1/trips/${tripId}`,
    headers: authHeaders(externalId),
  });
}

describe("deleting a trip", () => {
  it("removes the trip and the private threads it owned", async () => {
    const tripId = await createTripFor("alice");
    // `explorations/start` provisions a default thread, so this covers the
    // ON DELETE SET NULL foreign key on a NOT NULL column that would
    // otherwise make the delete fail outright.
    const threadsBefore = await db.select().from(chatThreads).where(eq(chatThreads.tripId, tripId));
    expect(threadsBefore.length).toBeGreaterThan(0);

    const response = await deleteTrip(tripId, "alice");
    expect(response.statusCode).toBe(204);

    expect(await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId))).toHaveLength(0);
    expect(await db.select().from(chatThreads).where(eq(chatThreads.tripId, tripId))).toHaveLength(0);
    expect(await db.select().from(tripMembers).where(eq(tripMembers.tripId, tripId))).toHaveLength(0);

    const listed = await app.inject({ method: "GET", url: "/api/v1/trips", headers: authHeaders("alice") });
    expect(listed.json().trips.find((trip: { id: string }) => trip.id === tripId)).toBeUndefined();
  });

  it("keeps the audit history and drops only its reference to the trip", async () => {
    const tripId = await createTripFor("alice");
    expect((await db.select().from(auditEvents).where(eq(auditEvents.tripId, tripId))).length).toBeGreaterThan(0);

    expect((await deleteTrip(tripId, "alice")).statusCode).toBe(204);

    // Nothing still points at the deleted trip, but the events themselves —
    // including the deletion — are still on record.
    expect(await db.select().from(auditEvents).where(eq(auditEvents.tripId, tripId))).toHaveLength(0);
    const actions = (await db.select({ action: auditEvents.action }).from(auditEvents)).map((row) => row.action);
    expect(actions).toContain("TRIP_DELETE");
    expect(actions).toContain("EXPLORATION_START");
  });

  it("refuses a member who did not create the trip", async () => {
    const tripId = await createTripFor("alice");
    const response = await deleteTrip(tripId, "bob");

    expect(response.statusCode).toBe(403);
    expect(await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId))).toHaveLength(1);
  });

  it("returns 404 for a trip that does not exist, and for one already deleted", async () => {
    expect((await deleteTrip(randomUUID(), "alice")).statusCode).toBe(404);

    const tripId = await createTripFor("alice");
    expect((await deleteTrip(tripId, "alice")).statusCode).toBe(204);
    // A retried request, or a second click, must not read as a server fault.
    expect((await deleteTrip(tripId, "alice")).statusCode).toBe(404);
  });
});
