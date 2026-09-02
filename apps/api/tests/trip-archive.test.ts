import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
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

function archive(tripId: string, externalId: "alice" | "bob", archived: boolean) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/trips/${tripId}/archive`,
    headers: { ...authHeaders(externalId), "content-type": "application/json" },
    payload: { archived },
  });
}

describe("archiving a trip", () => {
  it("hides it from the working list without destroying it, and puts it back", async () => {
    const tripId = await createTripFor("alice");

    const archived = await archive(tripId, "alice", true);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().trip).toMatchObject({
      id: tripId,
      archiveReason: "USER_ARCHIVED",
      archivedAt: expect.any(String),
    });

    // The row is still there — archiving is a hide, not a delete.
    const [row] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
    expect(row).toBeDefined();
    expect(row!.archivedAt).toBeInstanceOf(Date);
    expect(row!.archiveReason).toBe("USER_ARCHIVED");

    // `displayState` is what the Archived tab filters on, so this is the
    // field that decides whether the trip actually left the working list.
    const listed = await app.inject({ method: "GET", url: "/api/v1/trips", headers: authHeaders("alice") });
    expect(listed.statusCode).toBe(200);
    const summary = listed.json().trips.find((trip: { id: string }) => trip.id === tripId);
    expect(summary).toMatchObject({
      displayState: "ARCHIVED",
      archiveReason: "USER_ARCHIVED",
      archivedAt: expect.any(String),
    });

    const restored = await archive(tripId, "alice", false);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().trip).toMatchObject({ archivedAt: null, archiveReason: null });

    const relisted = await app.inject({ method: "GET", url: "/api/v1/trips", headers: authHeaders("alice") });
    const restoredSummary = relisted.json().trips.find((trip: { id: string }) => trip.id === tripId);
    expect(restoredSummary).toMatchObject({ archivedAt: null, archiveReason: null });
    expect(restoredSummary.displayState).not.toBe("ARCHIVED");
  });

  it("keeps the original archive time when archived twice", async () => {
    // A double-click, or a retry after a dropped response, must not look
    // like the traveller archived it again just now.
    const tripId = await createTripFor("alice");
    const first = await archive(tripId, "alice", true);
    const second = await archive(tripId, "alice", true);

    expect(second.statusCode).toBe(200);
    expect(second.json().trip.archivedAt).toBe(first.json().trip.archivedAt);
  });

  it("refuses a member who did not create the trip", async () => {
    const tripId = await createTripFor("alice");
    const response = await archive(tripId, "bob", true);

    expect(response.statusCode).toBe(403);
    const [row] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
    expect(row!.archivedAt).toBeNull();
  });

  it("returns 404 for a trip that does not exist", async () => {
    expect((await archive(randomUUID(), "alice", true)).statusCode).toBe(404);
  });

  it("records both the archive and the restore in the audit trail", async () => {
    const tripId = await createTripFor("alice");
    await archive(tripId, "alice", true);
    await archive(tripId, "alice", false);

    const actions = await db.select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.tripId, tripId)));
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["TRIP_ARCHIVE", "TRIP_UNARCHIVE"]),
    );
  });
});
