import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, and } from "drizzle-orm";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import {
  agentTaskRuns,
  constraintSnapshots,
  sharedTrips,
  tripMembers,
  tripSearchPreferences,
  users,
} from "../../src/db/schema.js";
import { authHeaders } from "../helpers/auth.js";
import { verifyTestAccessToken } from "../helpers/auth.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("POST /api/v1/trips/:tripId/research — Phase 2", () => {
  let app: Awaited<ReturnType<typeof import("../../src/app.js").buildApp>>;
  let cleanup: postgres.Sql;

  beforeAll(async () => {
    await runMigrations(connectionString);
    const { buildApp } = await import("../../src/app.js");
    app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
    await app.ready();
    cleanup = postgres(connectionString, { max: 1 });
  });

  afterAll(async () => {
    await app.close();
    // beforeEach truncates before each test but not after the last one; a
    // RESEARCH row left behind here breaks migrate.test.ts's from-scratch
    // migration replay (0012's pre-RESEARCH constraint) if it runs later in
    // the same single-forked vitest process.
    await cleanup.unsafe(`DELETE FROM agent_task_runs`);
    await cleanup.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup.unsafe(`
      TRUNCATE TABLE
        audit_events,
        outbox_events,
        planning_research_results,
        constraint_snapshots,
        agent_task_runs,
        idempotency_records,
        chat_messages,
        chat_threads,
        provider_search_runs,
        provider_offers,
        trip_members,
        trip_search_preferences,
        trip_stay_search_preferences,
        shared_trips,
        itinerary_plans,
        member_confirmations,
        source_evidence,
        visa_readiness_checks,
        trip_constraint_proposals,
        trip_constraint_facts,
        trip_invitations,
        consent_grants
      RESTART IDENTITY CASCADE
    `);
    await cleanup`DELETE FROM users`;
  });

  async function makeUser(externalId: string, displayName: string): Promise<string> {
    const [u] = await db.insert(users).values({
      externalId,
      displayName,
    }).returning({ id: users.id });
    return u!.id;
  }

  async function makeTripAndAddMember(params: {
    ownerExternalId: string;
    destinationCount: number;
    memberExternalIds?: string[];
    status?: "DRAFT" | "PLANNING" | "STALE";
  }): Promise<{ tripId: string; ownerId: string; memberIds: string[] }> {
    const ownerId = await makeUser(params.ownerExternalId, "Owner");
    const memberIds = [ownerId];
    for (const extId of params.memberExternalIds ?? []) {
      const memberId = await makeUser(extId, "Member");
      memberIds.push(memberId);
    }
    const tripId = randomUUID();
    await db.insert(sharedTrips).values({
      id: tripId,
      name: `Trip ${tripId.slice(0, 8)}`,
      nameSource: "AUTO",
      createdBy: ownerId,
      status: params.status ?? "DRAFT",
      departureCities: ["San Francisco"],
      destinationCandidates: Array.from({ length: params.destinationCount }, (_, i) => `City ${i + 1}`),
      travelDateStart: "2027-06-01",
      travelDateEnd: "2027-06-07",
    });
    for (const memberId of memberIds) {
      await db.insert(tripMembers).values({
        tripId,
        userId: memberId,
        role: memberId === ownerId ? "CREATOR" : "MEMBER",
        isRequired: true,
      });
    }
    return { tripId, ownerId, memberIds };
  }

  async function seedFlightPreference(tripId: string, confirmedBy: string): Promise<void> {
    await db.insert(tripSearchPreferences).values({
      tripId,
      version: 1,
      tripType: "LEISURE",
      currency: "USD",
      adults: 1,
      cabin: "ECONOMY",
      offerFreshnessMinutes: 60,
      confirmedBy,
    });
  }

  it("§10.1 rejects a DRAFT trip with 409 and creates no run", async () => {
    const { tripId } = await makeTripAndAddMember({
      ownerExternalId: "alice",
      destinationCount: 2,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/research`,
      headers: authHeaders("alice"),
      payload: {
        requestId: randomUUID(),
        outputMode: "RESEARCH_ONLY",
        requestedCapabilities: ["activities", "places"],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ message: expect.stringMatching(/TRIP_NOT_ACTIVE/) });
    const runs = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
    expect(runs).toEqual([]);
  });

  it("§10.3 rejects TEAM with 1 candidate (RESEARCH_BRIEF_INVALID)", async () => {
    const { tripId } = await makeTripAndAddMember({
      ownerExternalId: "bob",
      destinationCount: 2,
      memberExternalIds: ["test-second-member"],
      status: "PLANNING",
    });
    // Drop candidates to 1 so the TEAM bound is violated.
    await db.update(sharedTrips)
      .set({ destinationCandidates: ["Solo City"] })
      .where(eq(sharedTrips.id, tripId));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/research`,
      headers: authHeaders("bob"),
      payload: {
        requestId: randomUUID(),
        outputMode: "PROPOSE_PLAN",
        requestedCapabilities: ["activities"],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ message: expect.stringMatching(/RESEARCH_BRIEF_INVALID/) });
  });

  it("§10.3 rejects a body carrying snapshotId / provider / latitude (Zod .strict())", async () => {
    const { tripId, ownerId } = await makeTripAndAddMember({
      ownerExternalId: "carol",
      destinationCount: 2,
      status: "PLANNING",
    });
    await seedFlightPreference(tripId, ownerId);

    const forbiddenFields = ["snapshotId", "provider", "latitude", "longitude", "placeId", "dates", "currency"];
    for (const forbidden of forbiddenFields) {
      const base = {
        requestId: randomUUID(),
        outputMode: "RESEARCH_ONLY",
        requestedCapabilities: ["activities"],
      };
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/trips/${tripId}/research`,
        headers: authHeaders("carol"),
        payload: { ...base, [forbidden]: "x" },
      });
      expect(res.statusCode, `expected 400 for forbidden field ${forbidden}`).toBe(400);
    }
  });

  it("§10.2 idempotency: same requestId returns the same 202 envelope", async () => {
    const { tripId, ownerId } = await makeTripAndAddMember({
      ownerExternalId: "dave",
      destinationCount: 2,
      status: "PLANNING",
    });
    await seedFlightPreference(tripId, ownerId);

    const requestId = randomUUID();
    const payload = {
      requestId,
      outputMode: "RESEARCH_ONLY",
      requestedCapabilities: ["activities", "places"],
    };

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/research`,
      headers: authHeaders("dave"),
      payload,
    });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/research`,
      headers: authHeaders("dave"),
      payload,
    });
    expect(second.statusCode).toBe(202);
    const secondBody = second.json();

    expect(secondBody.runId).toBe(firstBody.runId);
    expect(secondBody.snapshotId).toBe(firstBody.snapshotId);
    expect(secondBody.operation).toBe("RESEARCH");

    const runs = await db.select().from(agentTaskRuns).where(and(
      eq(agentTaskRuns.tripId, tripId),
      eq(agentTaskRuns.requestId, requestId),
    ));
    expect(runs).toHaveLength(1);
    const snapshots = await db.select().from(constraintSnapshots).where(eq(constraintSnapshots.tripId, tripId));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.departureCities).toEqual(["San Francisco"]);
  });

  it("rejects an incomplete active brief before creating a snapshot or run", async () => {
    const { tripId, ownerId } = await makeTripAndAddMember({
      ownerExternalId: "missing-brief-facts",
      destinationCount: 1,
      status: "PLANNING",
    });
    await seedFlightPreference(tripId, ownerId);
    await db.update(sharedTrips).set({ departureCities: [], travelDateStart: null, travelDateEnd: null })
      .where(eq(sharedTrips.id, tripId));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/research`,
      headers: authHeaders("missing-brief-facts"),
      payload: { requestId: randomUUID(), outputMode: "RESEARCH_ONLY", requestedCapabilities: ["activities"] },
    });
    expect(res.statusCode).toBe(422);
    expect(await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId))).toEqual([]);
    expect(await db.select().from(constraintSnapshots).where(eq(constraintSnapshots.tripId, tripId))).toEqual([]);
  });

  it("happy path: solo owner accepts 1-candidate brief and gets 202", async () => {
    const { tripId, ownerId } = await makeTripAndAddMember({
      ownerExternalId: "eve",
      destinationCount: 1,
      status: "PLANNING",
    });
    await db.update(sharedTrips)
      .set({ destinationCandidates: ["Solo City"] })
      .where(eq(sharedTrips.id, tripId));
    await seedFlightPreference(tripId, ownerId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${tripId}/research`,
      headers: authHeaders("eve"),
      payload: {
        requestId: randomUUID(),
        outputMode: "RESEARCH_ONLY",
        requestedCapabilities: ["activities"],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({
      operation: "RESEARCH",
      status: "QUEUED",
      runId: expect.any(String),
      snapshotId: expect.any(String),
    });
  });
});
