import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  bookingExecutions,
  chatThreads,
  consentGrants,
  idempotencyRecords,
  itineraryPlans,
  memberConfirmations,
  sharedTrips,
  tripMembers,
  users,
} from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
let bobId: string;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();

  for (const subject of ["alice", "bob"] as const) {
    const [existing] = await db.select().from(users)
      .where(eq(users.externalId, subject)).limit(1);
    if (existing) {
      if (subject === "bob") bobId = existing.id;
      continue;
    }
    const [created] = await db.insert(users).values({
      externalId: subject,
      displayName: subject.charAt(0).toUpperCase() + subject.slice(1),
    }).returning();
    if (subject === "bob") bobId = created.id;
  }
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await db.delete(bookingExecutions);
  await db.delete(idempotencyRecords);
  await db.delete(auditEvents);
  await db.delete(memberConfirmations);
  await db.delete(itineraryPlans);
  await db.delete(consentGrants);
  await db.delete(tripMembers);
  await db.delete(chatThreads);
  await db.delete(sharedTrips);
});

async function createDraftFor(externalId: "alice" | "bob"): Promise<string> {
  const start = await app.inject({
    method: "POST",
    url: "/api/v1/explorations/start",
    headers: authHeaders(externalId),
    payload: { requestId: randomUUID() },
  });
  expect(start.statusCode).toBe(201);
  return start.json().trip.id;
}

describe("Draft trip command guards", () => {
  it("POST /consent/grant returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/consent/grant",
      headers: authHeaders("alice"),
      payload: {
        tripId: draftId,
        scope: "PROFILE_BASIC",
        fieldList: ["displayName"],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/TRIP_NOT_ACTIVE/);

    const rows = await db.select().from(consentGrants);
    expect(rows).toHaveLength(0);
  });

  it("POST /consent/revoke returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/consent/revoke",
      headers: authHeaders("alice"),
      payload: { tripId: draftId, scope: "PROFILE_BASIC" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("GET /consent/:tripId/me returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/consent/${draftId}/me`,
      headers: authHeaders("alice"),
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /planning/generate returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/planning/generate",
      headers: authHeaders("alice"),
      payload: { tripId: draftId },
    });
    expect(res.statusCode).toBe(409);
    const plans = await db.select().from(itineraryPlans);
    expect(plans).toHaveLength(0);
  });

  it("POST /change-events returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/change-events",
      headers: authHeaders("alice"),
      payload: {
        tripId: draftId,
        eventId: randomUUID(),
        eventType: "PRICE_CHANGE",
        payload: {},
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /confirmations returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations",
      headers: authHeaders("alice"),
      payload: {
        tripId: draftId,
        planId: randomUUID(),
        decision: "CONFIRMED",
      },
    });
    expect(res.statusCode).toBe(409);
    const rows = await db.select().from(memberConfirmations);
    expect(rows).toHaveLength(0);
  });

  it("POST /bookings returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bookings",
      headers: authHeaders("alice"),
      payload: {
        tripId: draftId,
        planId: randomUUID(),
        orchestrationRequestId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(409);
    const rows = await db.select().from(bookingExecutions);
    expect(rows).toHaveLength(0);
  });

  it("Draft collaboration guards never write audit rows", async () => {
    const draftId = await createDraftFor("alice");

    // Hit every guarded route; all should reject.
    const requests = [
      app.inject({
        method: "POST",
        url: "/api/v1/consent/grant",
        headers: authHeaders("alice"),
        payload: { tripId: draftId, scope: "PROFILE_BASIC", fieldList: ["displayName"] },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/consent/revoke",
        headers: authHeaders("alice"),
        payload: { tripId: draftId, scope: "PROFILE_BASIC" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/planning/generate",
        headers: authHeaders("alice"),
        payload: { tripId: draftId },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/confirmations",
        headers: authHeaders("alice"),
        payload: { tripId: draftId, planId: randomUUID(), decision: "CONFIRMED" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/bookings",
        headers: authHeaders("alice"),
        payload: { tripId: draftId, planId: randomUUID(), orchestrationRequestId: randomUUID() },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/change-events",
        headers: authHeaders("alice"),
        payload: { tripId: draftId, eventId: randomUUID(), eventType: "PRICE_CHANGE", payload: {} },
      }),
    ];
    const responses = await Promise.all(requests);
    for (const r of responses) {
      expect(r.statusCode).toBe(409);
    }

    // Only the EXPLORATION_START and TRIP_DEFAULT_THREAD_PROVISION rows
    // from creating the draft are present. No new audit events.
    const audits = await db.select().from(auditEvents)
      .where(eq(auditEvents.tripId, draftId));
    expect(audits.map((row) => row.action).sort())
      .toEqual(["EXPLORATION_START", "TRIP_DEFAULT_THREAD_PROVISION"]);
  });

  it("non-creator cannot bypass via membership row alone: invitation service rejects Draft", async () => {
    const draftId = await createDraftFor("alice");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/invitations`,
      headers: authHeaders("alice"),
      payload: {
        invitedUserId: bobId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/TRIP_NOT_ACTIVE/);
  });
});
