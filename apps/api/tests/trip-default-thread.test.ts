import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  users,
  sharedTrips,
  tripMembers,
  chatThreads,
  auditEvents,
} from "../src/db/schema.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
let aliceId: string;
let bobId: string;
let tripId: string;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();

  const [alice] = await db.insert(users)
    .values({ externalId: "alice", displayName: "Alice" })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  const [bob] = await db.insert(users)
    .values({ externalId: "bob", displayName: "Bob" })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  aliceId = (alice ?? (await db.select().from(users).where(eq(users.externalId, "alice")).limit(1))[0])!.id;
  bobId = (bob ?? (await db.select().from(users).where(eq(users.externalId, "bob")).limit(1))[0])!.id;
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

beforeEach(async () => {
  await cleanup();
  tripId = crypto.randomUUID();
  await db.insert(sharedTrips).values({
    id: tripId,
    name: `trip-default-thread-test-${tripId}`,
    createdBy: aliceId,
    departureCities: ["San Francisco"],
    destinationCandidates: ["Tokyo", "Bangkok"],
  });
  await db.insert(tripMembers).values([
    { tripId, userId: aliceId, role: "CREATOR", isRequired: true },
    { tripId, userId: bobId, role: "MEMBER", isRequired: true },
  ]);
});

async function cleanup(): Promise<void> {
  if (!aliceId || !bobId) return;
  await db.delete(auditEvents).where(and(
    eq(auditEvents.action, "TRIP_DEFAULT_THREAD_PROVISION"),
    inArray(auditEvents.actorUserId, [aliceId, bobId]),
  ));
  await db.delete(chatThreads).where(inArray(chatThreads.ownerUserId, [aliceId, bobId]));
  if (tripId) {
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
  }
}

describe("trip default thread provisioning", () => {
  it("creates the creator membership and default private thread with a new trip", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/trips",
      headers: authHeaders("alice"),
      payload: {
        name: `created-trip-${crypto.randomUUID()}`,
        departureCities: ["San Francisco"],
        destinationCandidates: ["Tokyo", "Bangkok"],
      },
    });

    expect(response.statusCode).toBe(201);
    const createdTripId = (response.json() as { id: string }).id;
    try {
      const memberships = await db.select().from(tripMembers).where(and(
        eq(tripMembers.tripId, createdTripId),
        eq(tripMembers.userId, aliceId),
      ));
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.role).toBe("CREATOR");

      const threads = await db.select().from(chatThreads).where(and(
        eq(chatThreads.tripId, createdTripId),
        eq(chatThreads.ownerUserId, aliceId),
      ));
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({ isDefault: true, scope: "TRIP" });
    } finally {
      await db.delete(auditEvents).where(eq(auditEvents.tripId, createdTripId));
      await db.delete(chatThreads).where(eq(chatThreads.tripId, createdTripId));
      await db.delete(tripMembers).where(eq(tripMembers.tripId, createdTripId));
      await db.delete(sharedTrips).where(eq(sharedTrips.id, createdTripId));
    }
  });

  it("rejects direct member assignment during trip creation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/trips",
      headers: authHeaders("alice"),
      payload: {
        name: "invalid-direct-member-assignment",
        departureCities: ["San Francisco"],
        destinationCandidates: ["Tokyo", "Bangkok"],
        memberUserIds: [bobId],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("provisions a default thread for a member on first call", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/threads/default`,
      headers: authHeaders("alice"),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      ownerUserId: string;
      tripId: string;
      isDefault: boolean;
      title: string;
    };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.ownerUserId).toBe(aliceId);
    expect(body.tripId).toBe(tripId);
    expect(body.isDefault).toBe(true);
    expect(body.title.length).toBeGreaterThan(0);

    const [audit] = await db.select()
      .from(auditEvents)
      .where(and(
        eq(auditEvents.action, "TRIP_DEFAULT_THREAD_PROVISION"),
        eq(auditEvents.actorUserId, aliceId),
      ))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit.summary).toMatchObject({ threadId: body.id, idempotent: true });
  });

  it("returns the same thread id on a second call by the same user (idempotent)", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/threads/default`,
      headers: authHeaders("alice"),
    });
    expect(first.statusCode).toBe(200);
    const firstId = (first.json() as { id: string }).id;

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/threads/default`,
      headers: authHeaders("alice"),
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe(firstId);

    const rows = await db.select()
      .from(chatThreads)
      .where(eq(chatThreads.ownerUserId, aliceId));
    expect(rows).toHaveLength(1);
  });

  it("rejects non-members with 403", async () => {
    // Remove Bob's membership; he should now be locked out.
    await db.delete(tripMembers).where(and(
      eq(tripMembers.tripId, tripId),
      eq(tripMembers.userId, bobId),
    ));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/threads/default`,
      headers: authHeaders("bob"),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { message?: string };
    expect(body.message).toMatch(/member/i);
  });

  it("rejects unknown tripId with 403", async () => {
    const unknownTripId = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${unknownTripId}/threads/default`,
      headers: authHeaders("alice"),
    });
    expect(res.statusCode).toBe(403);
  });
});
