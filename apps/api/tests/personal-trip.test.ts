import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { users, sharedTrips, tripMembers, auditEvents } from "../src/db/schema.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
let aliceId: string;
let bobId: string;

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
});

async function cleanup(): Promise<void> {
  if (!aliceId || !bobId) return;
  // Cascade-clean every table alice (or any other test) may have touched
  // for these trips.  Other suites write planning/snapshot/booking rows
  // against alice's trips; truncate those FKs before shared_trips.
  const tables = [
    "provider_offers",
    "source_evidence",
    "destination_candidates",
    "constraint_snapshots",
    "member_confirmations",
    "visa_readiness_checks",
    "idempotency_records",
    "booking_executions",
    "itinerary_plans",
    "outbox_events",
    "audit_events",
    "chat_messages",
    "chat_threads",
    "trip_members",
    "shared_trips",
  ];
  await db.execute(`TRUNCATE TABLE ${tables.map((t) => `travelagent_test.${t}`).join(", ")} RESTART IDENTITY CASCADE`);
}

describe("personal scratch trip creation", () => {
  it("creates a single-member trip with the caller as the only CREATOR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/trips/personal",
      headers: authHeaders("alice"),
      payload: {
        departureCities: ["San Francisco"],
        destinationCandidates: ["Tokyo", "Bangkok"],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; message: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.message).toBe("Personal trip created");

    const tripRows = await db.select()
      .from(sharedTrips)
      .where(eq(sharedTrips.id, body.id))
      .limit(1);
    expect(tripRows[0]?.name).toBe("Personal scratch trip");
    expect(tripRows[0]?.createdBy).toBe(aliceId);

    const members = await db.select()
      .from(tripMembers)
      .where(eq(tripMembers.tripId, body.id));
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(aliceId);
    expect(members[0]?.role).toBe("CREATOR");
    expect(members[0]?.isRequired).toBe(true);

    const [audit] = await db.select()
      .from(auditEvents)
      .where(and(
        eq(auditEvents.action, "TRIP_CREATE"),
        eq(auditEvents.actorUserId, aliceId),
      ))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit.summary).toMatchObject({ memberCount: 1, kind: "personal" });
  });

  it("provisions the caller's default thread on the new personal trip", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/trips/personal",
      headers: authHeaders("alice"),
      payload: {
        departureCities: ["San Francisco"],
        destinationCandidates: ["Tokyo", "Bangkok"],
      },
    });
    expect(create.statusCode).toBe(201);
    const { id: tripId } = create.json() as { id: string };

    const def = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/threads/default`,
      headers: authHeaders("alice"),
    });
    expect(def.statusCode).toBe(200);
    const thread = def.json() as { id: string; tripId: string; isDefault: boolean };
    expect(thread.tripId).toBe(tripId);
    expect(thread.isDefault).toBe(true);
  });

  it("rejects unauthenticated callers", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/trips/personal",
      payload: {
        departureCities: ["San Francisco"],
        destinationCandidates: ["Tokyo", "Bangkok"],
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects payloads with fewer than two destination candidates", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/trips/personal",
      headers: authHeaders("alice"),
      payload: {
        departureCities: ["San Francisco"],
        destinationCandidates: ["Tokyo"],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not allow a different caller to read the trip", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/trips/personal",
      headers: authHeaders("alice"),
      payload: {
        departureCities: ["San Francisco"],
        destinationCandidates: ["Tokyo", "Bangkok"],
      },
    });
    const { id: tripId } = create.json() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripId}`,
      headers: authHeaders("bob"),
    });
    expect(res.statusCode).toBe(403);
  });
});