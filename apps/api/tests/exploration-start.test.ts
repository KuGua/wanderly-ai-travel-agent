import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  chatThreads,
  constraintSnapshots,
  idempotencyRecords,
  itineraryPlans,
  providerOffers,
  providerSearchRuns,
  sharedTrips,
  sourceEvidence,
  tripSearchPreferences,
  agentTaskRuns,
  tripMembers,
  users,
} from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
let aliceId: string;
let bobId: string;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();

  for (const subject of ["alice", "bob"] as const) {
    const [existing] = await db.select().from(users)
      .where(eq(users.externalId, subject)).limit(1);
    if (existing) {
      if (subject === "alice") aliceId = existing.id;
      else bobId = existing.id;
      continue;
    }
    const [created] = await db.insert(users).values({
      externalId: subject,
      displayName: subject.charAt(0).toUpperCase() + subject.slice(1),
    }).returning();
    if (subject === "alice") aliceId = created.id;
    else bobId = created.id;
  }
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // Best-effort cleanup. Order matters because of FKs.
  await db.delete(auditEvents);
  await db.delete(idempotencyRecords);
  await db.delete(sourceEvidence);
  await db.delete(providerOffers);
  await db.delete(itineraryPlans);
  await db.delete(providerSearchRuns);
  await db.delete(agentTaskRuns);
  await db.delete(constraintSnapshots);
  await db.delete(tripSearchPreferences);
  await db.delete(chatThreads);
  await db.delete(tripMembers);
  await db.delete(sharedTrips).where(eq(sharedTrips.createdBy, aliceId));
  await db.delete(sharedTrips).where(eq(sharedTrips.createdBy, bobId));
});

async function startExploration(userKey: "alice" | "bob", requestId: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/explorations/start",
    headers: authHeaders(userKey),
    payload: { requestId },
  });
}

describe("Exploration start", () => {
  it("creates a PLANNING trip with creator member and default thread in one transaction", async () => {
    const requestId = randomUUID();
    const res = await startExploration("alice", requestId);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.trip.status).toBe("PLANNING");
    expect(body.trip.departureCities).toEqual([]);
    expect(body.trip.destinationCandidates).toEqual([]);
    expect(body.trip.travelDateStart).toBeNull();
    expect(body.trip.travelDateEnd).toBeNull();
    expect(body.defaultThread.scope).toBe("TRIP");
    expect(body.defaultThread.isDefault).toBe(true);
    expect(body.defaultThread.tripId).toBe(body.trip.id);

    // All three resources exist and agree on the trip id.
    const [tripRows] = await db.select().from(sharedTrips)
      .where(eq(sharedTrips.id, body.trip.id)).limit(1);
    expect(tripRows.status).toBe("PLANNING");
    expect(tripRows.createdBy).toBe(aliceId);

    const memberRows = await db.select().from(tripMembers)
      .where(eq(tripMembers.tripId, body.trip.id));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0].role).toBe("CREATOR");
    expect(memberRows[0].isRequired).toBe(true);

    const [threadRows] = await db.select().from(chatThreads)
      .where(eq(chatThreads.id, body.defaultThread.id)).limit(1);
    expect(threadRows.tripId).toBe(body.trip.id);
    expect(threadRows.isDefault).toBe(true);

    // Two audit rows: EXPLORATION_START + TRIP_DEFAULT_THREAD_PROVISION.
    const audits = await db.select().from(auditEvents)
      .where(eq(auditEvents.tripId, body.trip.id));
    const actions = audits.map((row) => row.action).sort();
    expect(actions).toEqual(["EXPLORATION_START", "TRIP_DEFAULT_THREAD_PROVISION"]);

    // Idempotency record stored with the trip id and payload.
    const [idemp] = await db.select().from(idempotencyRecords)
      .where(eq(idempotencyRecords.idempotencyKey, `exploration:${aliceId}:${requestId}`))
      .limit(1);
    expect(idemp).toBeDefined();
    expect(idemp.entityType).toBe("exploration_start");
    expect(idemp.entityId).toBe(body.trip.id);
  });

  it("is idempotent on (user, requestId): replays return 200 with the same trip", async () => {
    const requestId = randomUUID();
    const first = await startExploration("alice", requestId);
    const second = await startExploration("alice", requestId);
    const third = await startExploration("alice", requestId);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
    expect(second.json().trip.id).toBe(first.json().trip.id);
    expect(third.json().trip.id).toBe(first.json().trip.id);

    const tripCount = await db.select({ id: sharedTrips.id }).from(sharedTrips)
      .where(eq(sharedTrips.createdBy, aliceId));
    expect(tripCount).toHaveLength(1);

    const auditCount = await db.select({ id: auditEvents.id }).from(auditEvents);
    // Two from the first creation only; replays must not add audits.
    expect(auditCount).toHaveLength(2);
  });

  it("lists a new exploration as an active planning workspace", async () => {
    const started = await startExploration("alice", randomUUID());
    const tripId = started.json().trip.id;
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/trips",
      headers: authHeaders("alice"),
    });

    expect(listed.statusCode).toBe(200);
    const trip = listed.json().trips.find((item: { id: string }) => item.id === tripId);
    expect(trip.displayState).toBe("ACTION_REQUIRED");
  });

  it("creates independent drafts per user even with the same requestId", async () => {
    const requestId = randomUUID();
    const alice = await startExploration("alice", requestId);
    const bob = await startExploration("bob", requestId);

    expect(alice.statusCode).toBe(201);
    expect(bob.statusCode).toBe(201);
    expect(alice.json().trip.id).not.toBe(bob.json().trip.id);
  });

  it("rejects an empty body and a non-UUID requestId with 400", async () => {
    const noBody = await app.inject({
      method: "POST",
      url: "/api/v1/explorations/start",
      headers: authHeaders("alice"),
      payload: {},
    });
    expect(noBody.statusCode).toBe(400);

    const badUuid = await app.inject({
      method: "POST",
      url: "/api/v1/explorations/start",
      headers: authHeaders("alice"),
      payload: { requestId: "not-a-uuid" },
    });
    expect(badUuid.statusCode).toBe(400);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/explorations/start",
      payload: { requestId: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
  });

  it("never persists the requestId in audit summaries (PII safety)", async () => {
    const requestId = randomUUID();
    await startExploration("alice", requestId);
    const audits = await db.select().from(auditEvents);
    const payloadText = JSON.stringify(audits.map((row) => row.summary ?? {}));
    // The requestId is the per-tab UUID used for idempotency, not a session
    // identifier. We never want it in audit / log / metric labels.
    expect(payloadText.includes(requestId)).toBe(false);
    expect(payloadText.includes("question")).toBe(false);
    expect(payloadText.includes("body")).toBe(false);
    expect(payloadText.includes("place")).toBe(false);
  });
});
