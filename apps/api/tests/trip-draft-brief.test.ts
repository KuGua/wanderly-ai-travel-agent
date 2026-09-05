/**
 * PATCH /trips/:tripId/draft-brief — the date guard at the write boundary.
 *
 * A conversation once proposed a start in 2026 and an end in 2024, and this
 * route was the only thing that noticed. It answered a bare 400, the client
 * mapped every 400 to "refresh the conversation and try again", and the
 * traveller followed advice that could not work: the pair was stored on the
 * trip, so every click produced the same 400. The rejection now carries a
 * code the client can tell apart, in the same shape as DESTINATION_UNRESOLVED.
 *
 * Spec: docs/personal-and-planning-boundaries.md §3.1.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { auditEvents, chatMessages, chatThreads, sharedTrips, tripMembers, users } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";
import { provisionTripAndMember } from "./helpers/trip.js";

let app: FastifyInstance;
let aliceId: string;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();

  const [existing] = await db.select().from(users).where(eq(users.externalId, "alice")).limit(1);
  aliceId = existing?.id ?? (await db.insert(users)
    .values({ externalId: "alice", displayName: "Alice" }).returning())[0].id;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // The test database is shared across files in one run, and `chat_threads`
  // has a NOT NULL trip_id — so a sibling file's threads block the parent
  // delete unless they go first.
  await db.delete(auditEvents);
  await db.delete(chatMessages);
  await db.delete(chatThreads);
  await db.delete(tripMembers);
  await db.delete(sharedTrips);
});

async function draftTrip(): Promise<string> {
  const { tripId } = await provisionTripAndMember({ ownerUserId: aliceId });
  // The helper's column default is PLANNING; this route only serves a DRAFT.
  await db.update(sharedTrips).set({ status: "DRAFT" }).where(eq(sharedTrips.id, tripId));
  return tripId;
}

async function patchBrief(tripId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/trips/${tripId}/draft-brief`,
    headers: authHeaders("alice"),
    payload: { titleLocale: "en", ...payload },
  });
}

async function getTrip(tripId: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/trips/${tripId}`,
    headers: authHeaders("alice"),
  });
}

describe("draft-brief travel dates", () => {
  it("lets a Draft member open empty shared read projections without activating the trip", async () => {
    const tripId = await draftTrip();

    const [plans, constraints] = await Promise.all([
      app.inject({ method: "GET", url: `/api/v1/trips/${tripId}/plans`, headers: authHeaders("alice") }),
      app.inject({ method: "GET", url: `/api/v1/trips/${tripId}/constraints`, headers: authHeaders("alice") }),
    ]);

    expect(plans.statusCode).toBe(200);
    expect(plans.json()).toMatchObject({ tripId, proposed: [], active: [], stale: [] });
    expect(constraints.statusCode).toBe(200);
    expect(constraints.json()).toMatchObject({ tripId, teamVisibleFacts: [] });
  });

  it("does not return an older country-level proposal as an unsaveable card", async () => {
    const tripId = await draftTrip();
    await db.update(sharedTrips).set({
      pendingBriefProposal: { destinationCandidates: ["France"] },
    }).where(eq(sharedTrips.id, tripId));

    const res = await getTrip(tripId);

    expect(res.statusCode).toBe(200);
    expect(res.json().trip.pendingBriefProposal).toBeNull();
  });

  it("names the reason when the end date lands before the start", async () => {
    const res = await patchBrief(await draftTrip(), {
      travelDateStart: "2026-10-01",
      travelDateEnd: "2024-10-07",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/^BRIEF_DATES_INVALID:/);
  });

  it("rejects a date that is not on the calendar", async () => {
    const res = await patchBrief(await draftTrip(), { travelDateStart: "2026-02-30" });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/^BRIEF_DATES_INVALID:/);
  });

  it("still refuses a submitted end date that precedes a start already on the trip", async () => {
    const tripId = await draftTrip();
    await db.update(sharedTrips).set({ travelDateStart: "2026-10-01" })
      .where(eq(sharedTrips.id, tripId));

    const res = await patchBrief(tripId, { travelDateEnd: "2026-09-20" });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/^BRIEF_DATES_INVALID:/);
  });

  it("writes a coherent pair", async () => {
    const tripId = await draftTrip();
    const res = await patchBrief(tripId, {
      destinationCandidates: ["Shanghai"],
      replaceDestinationCandidates: true,
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-07",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().trip).toMatchObject({
      destinationCandidates: ["Shanghai"],
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-07",
    });

    const [persisted] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
    expect(persisted.travelDateEnd).toBe("2026-10-07");
    // The candidate has become a fact, so the card has nothing left to offer.
    expect(persisted.pendingBriefProposal).toBeNull();
  });
});
